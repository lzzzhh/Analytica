/**
 * Graph Engine — canonical serialization + content hashing.
 *
 * Canonical form: sorted keys, no whitespace, deterministic across objects.
 * Content hash = sha256 hex over the canonical JSON.
 */
import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

export function sortDeep(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value as JsonValue;
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

/** Hash of the spec EXCLUDING the self-referential contentHash field. */
export function specContentHash(spec: object & { contentHash?: string; createdAt?: string }): string {
  // createdAt is metadata, not content: the spec hash must be deterministic
  // across compilations of the same input (resume binding)
  const { contentHash: _omit, createdAt: _t, ...body } = spec;
  return contentHash(body);
}
