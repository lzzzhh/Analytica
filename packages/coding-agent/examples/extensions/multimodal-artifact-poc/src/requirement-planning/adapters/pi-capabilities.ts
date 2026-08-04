/**
 * Pi adapter — maps abstract capability ids to concrete Pi tool names and
 * computes availability from the effective feature snapshot.
 *
 * This is the ONLY module where Pi tool names appear. The core stays
 * tool-agnostic.
 */
import type { CapabilityDescriptor } from "../contracts.ts";
import type { FeatureSnapshot } from "../../features/types.ts";

/** Tool name per abstract capability (display/prompt only — never executed here). */
export const PI_TOOL_MAP: Record<string, string> = {
  "image.ocr": "parse_image",
  "image.visual": "parse_visual",
  "document.parse": "parse_document",
  "document.analyze": "analyze_document_v2",
  "lakehouse.catalog.search": "search_catalog",
  "lakehouse.dataset.inspect": "inspect_dataset",
  "lakehouse.query.validate": "validate_query",
  "lakehouse.query.execute": "execute_query",
  "data.quality": "get_data_quality",
  "data.lineage": "explain_lineage",
  "data.snapshot": "get_snapshot",
  "training.assess": "assess_training_data",
  "agent.reason": "agent_reason",
  "agent.synthesize": "agent_synthesize",
};

/** Feature id backing each capability (mirrors capability-registry). */
const CAPABILITY_FEATURES: Record<string, string> = {
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

const CAPABILITY_KINDS: Record<string, { input: string[]; output: string[] }> = {
  "image.ocr": { input: ["image_path"], output: ["text_blocks"] },
  "image.visual": { input: ["image_path", "intent"], output: ["facts", "inferences"] },
  "document.parse": { input: ["document_path"], output: ["full_text", "mime_type"] },
  "document.analyze": { input: ["document_text", "question"], output: ["facts", "answer"] },
  "lakehouse.catalog.search": { input: ["query"], output: ["datasets"] },
  "lakehouse.dataset.inspect": { input: ["dataset_id"], output: ["schema", "fields"] },
  "lakehouse.query.validate": { input: ["query_plan"], output: ["validated_query_id"] },
  "lakehouse.query.execute": { input: ["validated_query_id"], output: ["rows", "snapshot"] },
  "data.quality": { input: ["dataset_id"], output: ["quality_report"] },
  "data.lineage": { input: ["dataset_id"], output: ["lineage_graph"] },
  "data.snapshot": { input: ["dataset_id"], output: ["snapshot_metadata"] },
  "training.assess": { input: ["dataset_id", "target_field", "feature_fields"], output: ["assessment"] },
  "agent.reason": { input: ["evidence"], output: ["analysis"] },
  "agent.synthesize": { input: ["analyses"], output: ["final_answer"] },
};

const CAPABILITY_SIDE_EFFECT: Record<string, "NONE" | "READ" | "WRITE"> = {
  "image.ocr": "NONE",
  "image.visual": "NONE",
  "document.parse": "NONE",
  "document.analyze": "NONE",
  "lakehouse.catalog.search": "READ",
  "lakehouse.dataset.inspect": "READ",
  "lakehouse.query.validate": "NONE",
  "lakehouse.query.execute": "READ",
  "data.quality": "READ",
  "data.lineage": "READ",
  "data.snapshot": "READ",
  "training.assess": "READ",
  "agent.reason": "NONE",
  "agent.synthesize": "NONE",
};

const CAPABILITY_COST: Record<string, "LOW" | "MEDIUM" | "HIGH"> = {
  "image.ocr": "MEDIUM",
  "image.visual": "HIGH",
  "document.parse": "LOW",
  "document.analyze": "HIGH",
  "lakehouse.catalog.search": "LOW",
  "lakehouse.dataset.inspect": "LOW",
  "lakehouse.query.validate": "LOW",
  "lakehouse.query.execute": "MEDIUM",
  "data.quality": "LOW",
  "data.lineage": "LOW",
  "data.snapshot": "LOW",
  "training.assess": "MEDIUM",
  "agent.reason": "HIGH",
  "agent.synthesize": "MEDIUM",
};

/**
 * Build capability descriptors from a feature snapshot.
 * A capability is available iff its backing feature is effective.
 */
export function buildCapabilities(snapshot: FeatureSnapshot): CapabilityDescriptor[] {
  const effective = new Set(snapshot.effectiveFeatures);
  return Object.keys(PI_TOOL_MAP).map((id) => {
    const featureId = CAPABILITY_FEATURES[id]!;
    const available = effective.has(featureId);
    const kinds = CAPABILITY_KINDS[id] ?? { input: [], output: [] };
    return {
      id,
      available,
      provider: "pi",
      inputKinds: kinds.input,
      outputKinds: kinds.output,
      sideEffect: CAPABILITY_SIDE_EFFECT[id] ?? "READ",
      costClass: CAPABILITY_COST[id] ?? "MEDIUM",
      supportsParallel: !["training.assess", "agent.reason"].includes(id),
      featureId,
    };
  });
}

/** Tool name for a capability (for the final report only — never called). */
export function toolNameForCapability(capabilityId: string): string | null {
  return PI_TOOL_MAP[capabilityId] ?? null;
}
