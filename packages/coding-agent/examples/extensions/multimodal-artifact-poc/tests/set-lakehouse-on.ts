/** Side-effect module: enable round2.lakehouse before tools.ts loads
 *  (feature-driven registry; round2 defaults OFF at runtime). */
process.env.ENABLE_LAKEHOUSE = "true";
