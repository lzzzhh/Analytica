---
name: analysis-visualization
description: Create deterministic charts, tables, relationship diagrams, and data infographics from a validated AnalysisResultArtifact. Use for visualizing analysis results as SVG or PNG. Never use a generative image model for numeric charts.
---

# Analysis Visualization

## Purpose

Convert validated analysis artifacts into deterministic visual artifacts. This is the single Analytica skill for data-driven visual output.

## Allowed inputs

- `AnalysisResultArtifact`
- `ChartRequest`
- Optional approved theme configuration
- Optional previously generated `ChartArtifact`

Never accept model-authored arrays of business numbers when an artifact ID is available. Resolve values from the immutable artifact.

## Modes

- `chart`: statistical and analytical charts
- `table`: formatted data tables
- `relationship`: graphs, flows, and lineage-like diagrams
- `infographic`: evidence-based information design

## Required workflow

1. Resolve `artifactId` through the Artifact Registry.
2. Verify hash, schema, review status, and provenance.
3. Select an appropriate deterministic visualization type.
4. Preserve exact values, units, labels, and denominators.
5. Generate SVG first when supported.
6. Optionally render PNG from the SVG/specification.
7. Validate dimensions, labels, units, source note, and data fidelity.
8. Write a `VisualizationArtifact` and manifest.

## Output contract

Required files:

- visual output: `.svg` or `.png`
- `visualization-spec.json`
- `visualization-manifest.json`

The manifest must include:

- source artifact ID and hash
- query IDs and snapshot IDs
- renderer and version
- selected chart type
- output hash
- validation results

## Boundaries

- Do not query the warehouse.
- Do not recalculate the analysis.
- Do not invent missing values.
- Do not silently round or alter units.
- Do not imply causation from association.
- Do not use image generation for charts containing real metrics.
- Fail closed on missing provenance or schema mismatch.

## Implementation source

Adapt the vendored AntV chart and infographic skills under `vendor/antvis/`. Register only this Analytica wrapper skill.
