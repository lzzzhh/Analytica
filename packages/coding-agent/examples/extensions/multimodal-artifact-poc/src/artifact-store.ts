/**
 * Simple in-memory artifact store for multimodal PoC.
 *
 * Stores parsed image results keyed by artifactId so the model
 * can reference earlier parses without re-running OCR.
 */

import type { ParseResult } from "./schemas.ts";

const store = new Map<string, ParseResult>();

export function storeArtifact(result: ParseResult): void {
  store.set(result.artifactId, result);
}

export function getArtifact(artifactId: string): ParseResult | undefined {
  return store.get(artifactId);
}

export function listArtifacts(): ParseResult[] {
  return [...store.values()];
}

export function clearArtifacts(): void {
  store.clear();
}
