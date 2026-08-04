/**
 * Deterministic canonical-JSON hashing shared by TS and Python so both
 * sides produce identical feature hashes (cross-language parity is tested).
 */
import { createHash } from "node:crypto";

/** Canonical form: objects with keys sorted (byte order), compact separators. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** First 16 hex chars of sha256 over the canonical JSON (matches Python). */
export function featureHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}
