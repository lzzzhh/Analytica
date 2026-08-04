---
name: analysis-presentation
description: Turn validated analysis artifacts into an analysis-focused PowerPoint deck with a narrative outline, per-slide planning contract, deterministic charts, PPTX export, and visual QA. This is the only registered PPT skill.
---

# Analysis Presentation

## Purpose

Convert validated analysis results into a concise, decision-oriented PowerPoint presentation.

## Allowed inputs

- `AnalysisResultArtifact`
- `VisualizationArtifact` references
- Optional `ReportArtifact`
- Audience, deck type, slide-count target, and template ID

## Required workflow

1. Resolve and verify source artifacts.
2. Create a narrative outline tied to findings and evidence.
3. Create a strict `SlidePlan` for every slide.
4. Reuse deterministic chart artifacts; do not recalculate or redraw values from prose.
5. Generate slides and export PPTX.
6. Render every slide to an image.
7. Run content QA and visual QA.
8. Rework only failed slides.
9. Emit a `PresentationArtifact` and manifest.

## Recommended analysis deck structure

1. Cover
2. Objective and decision context
3. Data scope and quality
4. Core metrics
5. Trends and comparisons
6. Segments or distributions
7. Key findings
8. Risks and limitations
9. Recommendations
10. Appendix

## SlidePlan minimum fields

- slide number and purpose
- title and takeaway
- source artifact references
- layout
- text blocks
- chart/image references
- source note
- speaker notes
- QA constraints

## Output contract

- `presentation.pptx`
- `narrative-outline.json`
- `slide-plan.json`
- `slide-previews/`
- `visual-qa.json`
- `presentation-manifest.json`

## Boundaries

- One slide, one primary takeaway.
- Do not invent or drift numeric values.
- Do not generate charts with an image model.
- Do not omit units or provenance.
- Do not imply causality without supported evidence.
- Fail closed when a required chart or evidence artifact is missing.

## Implementation source

Adapt the vendored `vendor/ppt-agent-skills` project. Register only this Analytica wrapper; do not also register a second presentations skill.
