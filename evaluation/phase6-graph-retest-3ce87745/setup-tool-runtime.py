#!/opt/anaconda3/bin/python
"""Build fresh tool-evaluation fixtures against the frozen graph worktree."""
from pathlib import Path

SOURCE = Path("/Users/zhanhuilin/Documents/Analytica/evaluation/phase4-tool-calling-92cb4346/setup-runtime.py")
WORKTREE = Path("/tmp/analytica-phase6-3ce87745/checkout")
ROOT = Path(__file__).resolve().parent / "tool-calling"

ROOT.mkdir(parents=True, exist_ok=True)
code = SOURCE.read_text(encoding="utf-8")
code = code.replace(
    'WORKTREE = Path("/tmp/analytica-tool92.IH2rVI/checkout")',
    f"WORKTREE = Path({str(WORKTREE)!r})",
)
code = code.replace(
    'RUNTIME = Path(__file__).resolve().parent / "runtime"',
    f"RUNTIME = Path({str(ROOT / 'runtime')!r})",
)
code = code.replace(
    'write_json(Path(__file__).resolve().parent / "runtime-manifest.json", manifest)',
    f"write_json(Path({str(ROOT / 'runtime-manifest.json')!r}), manifest)",
)
namespace = {"__name__": "__main__", "__file__": str(SOURCE)}
exec(compile(code, str(SOURCE), "exec"), namespace)
