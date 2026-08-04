/**
 * Domain pack loader — packs are pure JSON under domain-packs/.
 * The generic pack always loads; other packs load on request and are gated
 * by semantic confirmation (requiresSemanticConfirmation).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DomainPack } from "./contracts.ts";

function packPath(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), `${name}.json`);
}

/** Load a domain pack by packId. Generic is built-in; risk etc. from JSON. */
export function loadDomainPack(packId: string): DomainPack | null {
  const normalized = packId.trim().toLowerCase();
  if (normalized === "generic") return loadGenericPack();
  try {
    const raw = readFileSync(packPath(normalized), "utf8");
    const pack = JSON.parse(raw) as DomainPack;
    if (!pack.packId || !Array.isArray(pack.metrics)) {
      throw new Error(`domain pack '${packId}' is malformed`);
    }
    return pack;
  } catch {
    return null;
  }
}

export function loadGenericPack(): DomainPack {
  const raw = readFileSync(packPath("generic"), "utf8");
  return JSON.parse(raw) as DomainPack;
}

/**
 * Semantic domain selection: the domainHint is only a hint. A domain pack
 * is adopted only when the raw request contains pack keywords (or when
 * domainPack feature is off and hint is generic).
 */
export function selectDomainPack(
  rawRequest: string,
  domainHint: string | undefined,
  domainPackEnabled: boolean,
): { pack: DomainPack; adoptedHint: boolean } {
  const generic = loadGenericPack();
  if (!domainPackEnabled) {
    return { pack: generic, adoptedHint: false };
  }
  if (domainHint && domainHint.trim().toLowerCase() !== "general") {
    const hinted = loadDomainPack(domainHint);
    if (hinted && hinted.packId !== "generic" && semanticMatch(hinted, rawRequest)) {
      return { pack: hinted, adoptedHint: true };
    }
    // hint provided but no semantic match → generic pack, record it
    return { pack: generic, adoptedHint: false };
  }
  // no hint: scan all non-generic packs for keyword match
  for (const candidate of ["risk"]) {
    const pack = loadDomainPack(candidate);
    if (pack && semanticMatch(pack, rawRequest)) {
      return { pack, adoptedHint: false };
    }
  }
  return { pack: generic, adoptedHint: false };
}

/** Keyword overlap decides semantics; empty keyword packs never match. */
export function semanticMatch(pack: DomainPack, rawRequest: string): boolean {
  if (pack.keywords.length === 0) return false;
  const lower = rawRequest.toLowerCase();
  return pack.keywords.some((k) => lower.includes(k.toLowerCase()));
}

export function listDomainPacks(): string[] {
  return ["generic", "risk"];
}
