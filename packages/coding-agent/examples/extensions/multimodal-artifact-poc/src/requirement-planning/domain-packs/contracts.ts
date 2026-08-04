/**
 * Domain pack contracts.
 *
 * A domain pack ONLY carries business vocabulary: terms, common metrics,
 * common subjects, time ranges, baselines, known ambiguities, recommended
 * clarification questions, and adoptable defaults with risk ratings.
 *
 * It NEVER contains SQL, concrete table names, tool names, fixed dataset
 * ids, user permissions, or auto-approval policies.
 */
import type { TimeRange } from "../contracts.ts";

export interface DomainMetric {
  name: string;
  definition: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
}

export interface DomainSubject {
  name: string;
  description: string;
}

export interface DomainDefault {
  field: string;
  value: string;
  impact: "LOW" | "MEDIUM" | "HIGH";
  /** Source tag recorded on the resulting assumption. */
  source: "DOMAIN_DEFAULT";
  risk: "LOW" | "MEDIUM" | "HIGH";
}

export interface DomainAmbiguity {
  field: string;
  type: "MISSING" | "MULTIPLE_INTERPRETATIONS" | "VAGUE_RANGE" | "UNKNOWN_METRIC" | "UNKNOWN_BASELINE" | "UNKNOWN_SUCCESS_CRITERIA" | "DOMAIN_AMBIGUITY";
  blocking: boolean;
  question: string;
  whyNeeded: string;
  answerType: "TEXT" | "SINGLE_CHOICE" | "MULTI_CHOICE" | "DATE_RANGE" | "NUMBER";
  options?: string[];
  /** If provided and risk is low, this is the non-blocking default value. */
  defaultValue?: string;
  defaultRisk?: "LOW" | "MEDIUM" | "HIGH";
}

export interface DomainPack {
  packId: string;
  packVersion: string;
  domainName: string;
  /** Terms that indicate this domain (used for semantic matching, not forced). */
  keywords: string[];
  description: string;
  metrics: DomainMetric[];
  subjects: DomainSubject[];
  commonTimeRanges: TimeRange[];
  comparisonBaselines: string[];
  knownAmbiguities: DomainAmbiguity[];
  defaults: DomainDefault[];
  /**
   * Semantics of adoption:
   * - "AUTO_LOW"   : defaults with risk LOW may be applied automatically (always recorded + visible)
   * - "ASK_FIRST"  : even LOW defaults surface as clarification questions first
   */
  adoptionPolicy: "AUTO_LOW" | "ASK_FIRST";
  /** Whether this pack requires explicit semantic confirmation before any metric/default is used. */
  requiresSemanticConfirmation: boolean;
}
