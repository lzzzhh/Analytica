---
name: analysis-report
description: Generate a complete analysis report from validated Analytica artifacts in Markdown, HTML, DOCX, or PDF. Use one report workflow regardless of export format; DOCX and PDF are implementation backends, not separate user-visible skills.
---

# Analysis Report

## Purpose

Produce a traceable analysis report from immutable result, evidence, chart, and execution artifacts.

## Supported formats

- Markdown
- HTML
- DOCX
- PDF

## Allowed inputs

- `AnalysisResultArtifact`
- Optional `VisualizationArtifact` references
- `ExecutionManifest`
- Data-quality findings
- User-selected title, detail level, and template ID

## Canonical report structure

1. Cover and document metadata
2. Executive summary
3. Analysis objective
4. Data scope and snapshots
5. Core metrics
6. Charts and tables
7. Findings
8. Methodology
9. Data quality, assumptions, and limitations
10. Recommendations
11. Evidence and provenance
12. Appendices

## Required workflow

1. Resolve and verify all referenced artifacts.
2. Build a format-neutral `ReportPlan`.
3. Build canonical report content from the plan.
4. Render the requested format.
5. Set title, author, version, timestamps, and provenance metadata.
6. For DOCX: use named Word styles and preserve live fields where applicable.
7. For PDF: embed a CJK-capable font when Chinese is present.
8. Render DOCX/PDF pages for visual QA.
9. Extract text for content-order QA.
10. Emit a `ReportArtifact` and `report-manifest.json`.

## Output contract

Depending on request:

- `report.md`
- `report.html`
- `report.docx`
- `report.pdf`
- `page-previews/`
- `report-plan.json`
- `report-manifest.json`
- `qa-results.json`

## Boundaries

- Do not fetch raw business data.
- Do not recompute metrics.
- Do not write claims that lack an evidence reference.
- Clearly label assumptions and unreviewed findings.
- Preserve exact values and units from source artifacts.
- Do not claim visual QA passed unless pages were actually rendered and checked.

## Implementation source

Adapt DOCX and PDF implementation patterns from `vendor/suna/docx`, `vendor/suna/pdf`, and `vendor/suna/design-foundations`. Replace Kortix-specific paths, branding, and metadata with Analytica configuration. The vendored Suna material is Elastic License 2.0; keep its license and notices.
