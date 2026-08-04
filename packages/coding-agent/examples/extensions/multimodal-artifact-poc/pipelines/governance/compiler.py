"""Deterministic Compiler — generates a PipelineDraftArtifact from a
validated PipelineSpec.

The draft is a human-readable, NON-EXECUTABLE preview of the processing
steps (executable=false). It is never executed or deployed; it exists so the
human reviewer can inspect what would run. A separate execution backend would
consume an APPROVED spec — out of scope for Phase 1.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from pipelines.governance.contracts import is_valid_contract, sha256_canonical


def compile_draft(spec: dict, version: int, artifact_id: str) -> dict:
    """Build a non-executable PipelineDraftArtifact from a PipelineSpec.

    Raises ValueError when the spec is not contract-valid (compile only
    happens on validated specs).
    """
    if not is_valid_contract("pipeline-spec", spec):
        raise ValueError("refusing to compile an invalid PipelineSpec")

    lines = [
        f"# Pipeline draft (NON-EXECUTABLE preview) — spec v{version}",
        f"# pipelineId={spec.get('pipelineId')} target={spec.get('target')}",
        f"# executionMode={spec.get('executionMode')} backend={spec.get('executionBackend')}",
        f"# updateMode={spec.get('updateMode')} timeSemantics={spec.get('timeSemantics')}",
        "",
        "steps:",
    ]
    for i, step in enumerate(spec.get("steps", []), 1):
        lines.append(f"  {i}. {step.get('stepId')}: {step.get('operation')} "
                     f"({step.get('input')} -> {step.get('output')})")
    lines.append("")
    lines.append(f"keys: {spec.get('keys')}")
    lines.append(f"dedupPolicy: {spec.get('dedupPolicy')}")
    lines.append(f"watermarkPolicy: {spec.get('watermarkPolicy')}")
    lines.append(f"lateDataPolicy: {spec.get('lateDataPolicy')}")
    lines.append("")
    lines.append("# This artifact is executable=false. Approval required before any execution backend may consume it.")

    preview = "\n".join(lines)
    artifact = {
        "artifactId": artifact_id,
        "specVersion": version,
        "executable": False,
        "compiledPreview": preview,
        "contentHash": sha256_canonical({"preview": preview, "specVersion": version}),
        "compiler": "DETERMINISTIC_PYICEBERG_COMPILER",
        "compiledAt": datetime.now(timezone.utc).isoformat(),
    }
    if not is_valid_contract("pipeline-draft-artifact", artifact):
        raise ValueError("compiler produced an invalid draft artifact")
    return artifact
