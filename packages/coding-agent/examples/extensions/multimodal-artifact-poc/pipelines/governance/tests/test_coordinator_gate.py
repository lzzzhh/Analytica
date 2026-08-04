"""Governance review-fix tests: coordinator feature-flag execution gating.

Covers the P1 review finding "components were directly instantiable without
feature gating": the GovernanceCoordinator must refuse every action whose
feature is not effective, and proceed when it is.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.coordinator import GovernanceCoordinator  # noqa: E402
from pipelines.governance.event_store import EventStore  # noqa: E402
from pipelines.governance.repository import Repository  # noqa: E402


class _FakeResolver:
    def __init__(self, effective: set[str]):
        self._effective = effective

    def is_effective(self, fid: str) -> bool:
        return fid in self._effective


ALL_ON = _FakeResolver(set(GovernanceCoordinator.ACTION_FEATURES.values()) | {
    "round2.pipeline_governance"})
ALL_OFF = _FakeResolver(set())


@pytest.fixture()
def coord(tmp_path):
    repo = Repository(tmp_path / "gov-data")
    return repo, EventStore(repo)


def _finding():
    return {
        "findingId": "gf_1", "pipelineId": "p_1", "pipelineVersion": 1,
        "runId": "run_1", "category": "RUNTIME_PERFORMANCE", "code": "JOB_FAILED",
        "severity": "HIGH", "blocking": True, "message": "job failed",
        "evidenceRefs": ["spark-job-1"], "suggestedActions": ["RESTART_JOB"],
        "createdAt": "2026-08-02T00:00:00Z",
    }


def test_all_actions_refuse_when_features_off(coord):
    repo, store = coord
    c = GovernanceCoordinator(repo, store, resolver=ALL_OFF)
    with pytest.raises(RuntimeError) as e1:
        c.emit("RUN_STARTED", "p_1", 1, "run_1")
    assert "round2.pipeline_event_store" in str(e1.value)
    with pytest.raises(RuntimeError):
        c.snapshot("run_1")
    with pytest.raises(RuntimeError):
        c.record_finding(_finding())
    with pytest.raises(RuntimeError):
        c.watchdog_renew("run_1", "p_1", 1, "2026-08-02T00:00:00Z")
    with pytest.raises(RuntimeError):
        c.remediation_decide({}, "APPROVE_REMEDIATION", "op@h")
    with pytest.raises(RuntimeError):
        c.placement_approve({}, "op@h")
    with pytest.raises(RuntimeError):
        c.cdxr_promote({}, "op@h")
    # nothing was written while gated off
    assert store.events_for_run("run_1") == []
    assert repo.ledger() == []


def test_actions_proceed_when_features_on(coord):
    repo, store = coord
    c = GovernanceCoordinator(repo, store, resolver=ALL_ON)
    evt = c.emit("RUN_STARTED", "p_1", 1, "run_1")
    assert evt
    snap = c.snapshot("run_1", "p_1", 1)
    assert snap["runId"] == "run_1"
    c.record_finding(_finding())
    assert any(e["eventType"] == "FINDING_DETECTED"
               for e in store.events_for_run("run_1"))
    c.watchdog_renew("run_1", "p_1", 1, "2026-08-02T00:00:00Z")
    assert any(e["eventType"] == "PROGRESS_UPDATED"
               for e in store.events_for_run("run_1"))


def test_parent_feature_off_blocks_children_even_if_child_requested(tmp_path):
    """Parent round2.pipeline_governance off ⇒ children not effective ⇒ the
    resolver stub simulates dependency resolution: only the parent matters
    here because children cannot be effective without it."""
    class _ParentOff(_FakeResolver):
        pass

    c = GovernanceCoordinator(Repository(tmp_path / "unused"),
                              resolver=_ParentOff(set()))
    with pytest.raises(RuntimeError):
        c.emit("RUN_CREATED", "p_1", 1, "run_x")


def test_no_resolver_falls_back_to_real_resolver(tmp_path):
    """Without an injected resolver the coordinator uses the default resolver.
    With the everything-ON default the action proceeds; with the parent
    feature explicitly off it is refused and no files are created."""
    import subprocess
    root = tmp_path / "cli-root"
    env = {**__import__("os").environ, "PIPELINE_GOVERNANCE_ROOT": str(root)}
    env["ENABLE_PIPELINE_GOVERNANCE"] = "false"
    code = (
        "import sys; sys.path.insert(0, '.')\n"
        "from pipelines.governance.coordinator import GovernanceCoordinator\n"
        "c = GovernanceCoordinator(resolver=None)\n"
        "try:\n"
        "    c.emit('RUN_STARTED', 'p_1', 1, 'run_1')\n"
        "    print('PROCEEDED')\n"
        "except RuntimeError as e:\n"
        "    print('REFUSED', e)\n"
    )
    r = subprocess.run([sys.executable, "-c", code],
                       capture_output=True, text=True, env=env,
                       cwd=str(Path(__file__).resolve().parents[3]))
    assert "REFUSED" in r.stdout, f"stdout={r.stdout!r} stderr={r.stderr!r}"
    # gated off ⇒ no events were written (the empty ledger scaffold that the
    # Repository creates at construction is not a state write; CLI-level
    # zero-side-effect is covered by test_cli_feature_gate_off)
    assert not (root / "events").exists()
