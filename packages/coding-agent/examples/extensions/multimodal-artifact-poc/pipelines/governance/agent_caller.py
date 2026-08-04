"""Agent caller — plugs a real LLM into the Governance Agent roles.

The deterministic governance core NEVER depends on a model: every agent role
(design / remediation / placement) takes an injected caller and defaults to a
failing stub. `create_pi_rpc_caller()` wires a real brain: a one-shot
`pi --mode rpc` subprocess per call (spawn → prompt → collect final text →
exit). No resident agent, no chat history — matches the event-driven,
non-resident design (§3.2 of the governance architecture).
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

AgentCaller = Callable[[str], dict]


def create_stub_caller(error: str = "no agent caller injected") -> AgentCaller:
    """Default: fail loudly. The deterministic core never fabricates output."""

    def caller(_prompt: str) -> dict:
        return {"ok": False, "text": "", "error": error}

    return caller


def create_pi_rpc_caller(
    cli_path: str,
    provider: str = "deepseek",
    model: str = "deepseek-v4-flash",
    timeout_ms: int = 120_000,
    extra_args: Optional[list[str]] = None,
) -> AgentCaller:
    """One-shot pi RPC caller. Each call spawns `node <cli> --mode rpc
    --no-session`, prompts once, collects the final assistant text from the
    agent_end event, then tears the subprocess down."""

    def caller(prompt: str) -> dict:
        args = [
            "node", cli_path, "--mode", "rpc", "--no-session",
            "--provider", provider, "--model", model,
            *(extra_args or []),
        ]
        proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=os.environ.copy(),
        )
        text_parts: list[str] = []
        settled = threading.Event()
        final_text: list[str] = []
        stderr_tail: list[str] = []

        def _read_stdout() -> None:
            for raw in proc.stdout:  # type: ignore[union-attr]
                line = raw.rstrip("\n").rstrip("\r")
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                etype = event.get("type")
                if etype == "message_update":
                    inner = event.get("assistantMessageEvent") or {}
                    if inner.get("type") == "text_delta":
                        text_parts.append(inner["delta"])
                elif etype == "agent_end":
                    for m in reversed(event.get("messages") or []):
                        if m.get("role") == "assistant" and isinstance(m.get("content"), list):
                            txt = "".join(
                                c.get("text", "")
                                for c in m["content"]
                                if c.get("type") == "text" and isinstance(c.get("text"), str)
                            ).strip()
                            if txt:
                                final_text.append(txt)
                                break
                    settled.set()
                elif etype == "agent_settled":
                    settled.set()

        def _read_stderr() -> None:
            for line in proc.stderr or []:  # type: ignore[union-attr]
                stderr_tail.append(line)
                if len(stderr_tail) > 100:
                    stderr_tail.pop(0)

        threading.Thread(target=_read_stdout, daemon=True).start()
        threading.Thread(target=_read_stderr, daemon=True).start()

        try:
            # small settle window so the RPC loop is up before prompting
            time.sleep(1.5)
            if proc.poll() is not None:
                return {"ok": False, "text": "",
                        "error": f"pi rpc exited early (code={proc.poll()}): "
                                 f"{''.join(stderr_tail)[-300:]}"}
            proc.stdin.write(json.dumps({"type": "prompt", "message": prompt}) + "\n")  # type: ignore[union-attr]
            proc.stdin.flush()  # type: ignore[union-attr]
            if not settled.wait(timeout_ms / 1000.0):
                return {"ok": False, "text": "".join(text_parts),
                        "error": f"pi rpc timed out after {timeout_ms}ms"}
            text = final_text[0] if final_text else "".join(text_parts).strip()
            if not text:
                return {"ok": False, "text": "",
                        "error": "pi rpc finished without a final message"}
            return {"ok": True, "text": text}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "text": "".join(text_parts), "error": str(exc)}
        finally:
            try:
                proc.stdin.close()  # type: ignore[union-attr]
            except Exception:
                pass
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                proc.kill()

    return caller


def caller_from_env() -> AgentCaller:
    """Wire the caller from environment variables (explicit opt-in). Without
    PIPELINE_GOVERNANCE_PI_CLI the stub is used — the core stays deterministic."""
    cli = os.environ.get("PIPELINE_GOVERNANCE_PI_CLI", "").strip()
    if not cli or not os.path.exists(cli):
        return create_stub_caller(
            "no LLM caller wired (set PIPELINE_GOVERNANCE_PI_CLI to enable "
            "the pi RPC brain)")
    return create_pi_rpc_caller(
        cli,
        provider=os.environ.get("PIPELINE_GOVERNANCE_PROVIDER", "deepseek"),
        model=os.environ.get("PIPELINE_GOVERNANCE_MODEL", "deepseek-v4-flash"),
        timeout_ms=int(os.environ.get("PIPELINE_GOVERNANCE_TIMEOUT_MS", "120000")),
    )
