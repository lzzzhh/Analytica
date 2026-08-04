/**
 * Formatter — text rendering helpers for the TUI renderer.
 * Pure functions; no terminal escapes beyond basic styling.
 */
import type { RenderedView } from "./contracts.ts";

export function formatRenderedViews(views: RenderedView[]): string {
  const blocks: string[] = [];
  for (const v of views) {
    blocks.push(`[${v.kind}] ${v.title}`);
    blocks.push(...v.lines);
  }
  return blocks.join("\n");
}

/** ASCII sparkline for a numeric series (bounded width). */
export function sparkline(values: number[], width = 20): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = Math.max(1, Math.ceil(values.length / width));
  const sampled = values.filter((_, i) => i % step === 0).slice(0, width);
  const chars = "▁▂▃▄▅▆▇█";
  return sampled
    .map((v) => chars[Math.min(chars.length - 1, Math.floor(((v - min) / range) * (chars.length - 1)))])
    .join("");
}

export function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
