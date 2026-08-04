#!/opt/anaconda3/bin/python
"""Run the frozen 14-dataset blind Pipeline harness at the isolated graph commit."""
from pathlib import Path

SOURCE = Path("/Users/zhanhuilin/Documents/Analytica/evaluation/phase2-retest/run_blind_retest.py")
WORKTREE = Path("/tmp/analytica-phase6-3ce87745/checkout")
OUTPUT = Path(__file__).resolve().parent / "pipeline"

code = SOURCE.read_text(encoding="utf-8")
code = code.replace(
    "REPO = Path(__file__).resolve().parents[2]",
    f"REPO = Path({str(WORKTREE)!r})",
)
code = code.replace(
    "EVAL = Path(__file__).resolve().parent",
    f"EVAL = Path({str(SOURCE.parent)!r})",
)
code = code.replace(
    'ARTIFACTS = EVAL / "artifacts"',
    f"ARTIFACTS = Path({str(OUTPUT)!r})",
)
namespace = {"__name__": "__main__", "__file__": str(SOURCE)}
exec(compile(code, str(SOURCE), "exec"), namespace)
