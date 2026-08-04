/** Side-effect module: enable the CDXR training tool feature before tools.ts
 *  loads. round3.cdxr_training depends on round2.lakehouse, so the lakehouse
 *  feature must be on as well (feature-driven registry). The legacy
 *  ENABLE_CDXR_TRAINING_TOOL env alias is honored centrally by the resolver. */
process.env.ENABLE_LAKEHOUSE = "true";
process.env.ENABLE_CDXR_TRAINING_TOOL = "true";
