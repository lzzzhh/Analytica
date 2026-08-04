---
name: analysis-image
description: Generate or edit non-data creative images for report covers, presentation covers, conceptual illustrations, and backgrounds. Never use for charts or images that represent actual business metrics.
---

# Analysis Image

## Purpose

Create supporting creative visuals for analysis deliverables without representing numeric analysis results.

## Allowed purposes

- report cover
- presentation cover
- conceptual illustration
- background
- decorative visual
- edit, upscale, or remove background from an existing image artifact

## Required workflow

1. Validate purpose and output dimensions.
2. Build a prompt that excludes confidential raw data.
3. Call the configured `ImageGenerationProvider`.
4. Record provider, model, prompt hash, seed/options when available, and output hash.
5. Verify format, dimensions, and basic safety constraints.
6. Emit an `ImageArtifact` and manifest.

## Output contract

- generated or edited image
- `image-request.json`
- `provider-metadata.json`
- `image-manifest.json`

## Boundaries

- Never generate data charts, KPI panels, or tables.
- Never place fabricated numbers into an analysis deliverable.
- Never expose warehouse credentials or raw datasets to an image provider.
- Require explicit configuration before calling a network provider.
- Keep local ComfyUI/FLUX and remote providers behind the same interface.

## Implementation source

Use `vendor/openai-imagegen` as a workflow reference. Analytica must provide its own provider adapter and feature gate.
