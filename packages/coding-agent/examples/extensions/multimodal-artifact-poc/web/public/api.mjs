/* Analytica Web UI — API client + tiny reactive store (no build step). */

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.code = data?.error?.code || "HTTP_ERROR";
    err.status = res.status;
    throw err;
  }
  return data;
}

/* Minimal event emitter used as a global app store. */
function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const fn of listeners) fn(state);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const appStore = createStore({
  sessions: [],
  sessionsError: null,
  sessionsLoaded: false,
  rightPanelRun: null, // {runId, storeLabel}
});

export async function refreshSessions() {
  try {
    const data = await api("/api/sessions");
    appStore.set({ sessions: data.sessions, sessionsError: null, sessionsLoaded: true });
  } catch (err) {
    appStore.set({ sessionsError: err, sessionsLoaded: true });
  }
}

/* SSE live channel: refetch hook registry. When the graph store changes,
 * every registered listener re-fetches its data (bounded polling fallback
 * when EventSource is unavailable). */
const liveListeners = new Set();
let streamStarted = false;
let pollTimer = null;

export function onStoreChange(fn) {
  liveListeners.add(fn);
  return () => liveListeners.delete(fn);
}

export function startLiveChannel() {
  if (streamStarted) return;
  streamStarted = true;
  const notify = () => { for (const fn of liveListeners) fn(); };
  if (typeof EventSource !== "undefined") {
    const es = new EventSource("/api/stream");
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "graph-store-changed") notify();
      } catch { /* ignore malformed frame */ }
    };
    es.onerror = () => {
      // SSE lost: fall back to bounded polling every 5s
      es.close();
      if (!pollTimer) pollTimer = setInterval(notify, 5000);
    };
  } else if (!pollTimer) {
    pollTimer = setInterval(notify, 5000);
  }
}

/* Async resource hook state machine: loading | ready | empty | error. */
export function resourceState(status, data = null, error = null) {
  return { status, data, error };
}
