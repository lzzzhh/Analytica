/**
 * Abstract capability registry — the ONLY place where abstract capability
 * ids are defined. The requirement-planning core knows these ids and
 * nothing about concrete Pi tool names. Concrete tool mapping lives in
 * adapters/pi-capabilities.ts.
 */

/** Canonical abstract capability ids (spec §9). */
export const ABSTRACT_CAPABILITIES = [
  "image.ocr",
  "image.visual",
  "document.parse",
  "document.analyze",
  "lakehouse.catalog.search",
  "lakehouse.dataset.inspect",
  "lakehouse.query.validate",
  "lakehouse.query.execute",
  "data.quality",
  "data.lineage",
  "data.snapshot",
  "training.assess",
  "agent.reason",
  "agent.synthesize",
] as const;

export type AbstractCapabilityId = (typeof ABSTRACT_CAPABILITIES)[number];

/** Capability feature gating: which feature id backs each abstract capability. */
export const CAPABILITY_FEATURE_MAP: Record<AbstractCapabilityId, string> = {
  "image.ocr": "round1.image_ocr",
  "image.visual": "round1.visual_parser",
  "document.parse": "round1.document_parser",
  "document.analyze": "round1.document_subagent",
  "lakehouse.catalog.search": "round2.catalog_tools",
  "lakehouse.dataset.inspect": "round2.catalog_tools",
  "lakehouse.query.validate": "round2.query_tools",
  "lakehouse.query.execute": "round2.query_tools",
  "data.quality": "round2.data_quality",
  "data.lineage": "round2.lineage",
  "data.snapshot": "round2.snapshot",
  "training.assess": "round3.cdxr_training",
  "agent.reason": "round1.l2_expert",
  "agent.synthesize": "round1.evidence_merger",
};

/**
 * TaskType → capability families that can satisfy it. Used by the plan
 * builder to map task types to abstract capabilities and by the validator
 * to check capability availability deterministically.
 */
export const TASK_TYPE_CAPABILITIES: Record<string, AbstractCapabilityId[]> = {
  DISCOVER: ["lakehouse.catalog.search", "document.parse", "image.ocr"],
  EXTRACT: ["document.parse", "image.ocr", "image.visual", "lakehouse.dataset.inspect"],
  QUERY: ["lakehouse.query.execute"],
  VALIDATE: ["lakehouse.query.validate", "data.quality", "training.assess"],
  COMPARE: ["lakehouse.query.execute", "data.quality"],
  ASSESS: ["training.assess", "data.quality"],
  ANALYZE: ["agent.reason", "lakehouse.query.execute"],
  SYNTHESIZE: ["agent.synthesize"],
  CLARIFY: ["agent.reason"],
};
