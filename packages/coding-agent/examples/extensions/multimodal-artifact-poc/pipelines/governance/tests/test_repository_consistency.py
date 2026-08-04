"""Repository consistency tests — P0 fixes from consolidated review:

- no-clobber publish: os.link EEXIST, not cooperative exists() check
- fail-closed append: writes rejected while the ledger tail is damaged
- repair_ledger_tail: locked recheck + atomic repair, no lost appends
- reconcile: scan + backfill inside the lock
"""
import json
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from pipelines.governance.repository import IntegrityError, Repository  # noqa: E402


@pytest.fixture()
def repo(tmp_path) -> Repository:
    return Repository(tmp_path / "gov-data")


def _put(repo: Repository, obj_type: str, obj_id: str, version: int = 1, **extra) -> None:
    repo.put(obj_type, obj_id, version, {"id": obj_id, "v": version, **extra})


class TestNoClobberPublish:
    def test_double_put_rejected(self, repo):
        _put(repo, "schema-spec", "a", 1)
        with pytest.raises(ValueError, match="already exists"):
            _put(repo, "schema-spec", "a", 1)

    def test_concurrent_same_object_single_winner(self, repo, tmp_path):
        """32 threads race to publish the same object+version → exactly one
        commit, everyone else gets a no-clobber conflict."""
        winners = []
        errors: list[str] = []
        lock = threading.Lock()

        def worker(i: int) -> None:
            try:
                repo.put("schema-spec", "race", 1, {"id": "race", "w": i})
                with lock:
                    winners.append(i)
            except ValueError as e:
                with lock:
                    errors.append(str(e))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(32)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(winners) == 1, f"exactly one winner, got {len(winners)}"
        assert len(errors) == 31
        obj = repo.get("schema-spec", "race", 1)
        assert obj is not None
        assert obj.content["w"] == winners[0]

    def test_concurrent_different_objects_all_succeed(self, repo):
        """32 threads publishing DIFFERENT objects all succeed (per-object
        parallelism is a later optimization; correctness = all committed)."""
        ok = []
        lock = threading.Lock()

        def worker(i: int) -> None:
            try:
                _put(repo, "schema-spec", f"obj_{i}", 1)
                with lock:
                    ok.append(i)
            except Exception:  # noqa: BLE001
                pass

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(32)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert len(ok) == 32


class TestFailClosedAppend:
    def _corrupt_tail(self, repo: Repository) -> None:
        with open(repo.ledger_path, "a", encoding="utf-8") as f:
            f.write('{"type":"schema-spec","id":"par')  # truncated line
            f.flush()

    def test_append_rejected_while_tail_damaged(self, repo):
        _put(repo, "schema-spec", "a", 1)
        self._corrupt_tail(repo)
        with pytest.raises(IntegrityError, match="REPAIR_REQUIRED"):
            _put(repo, "schema-spec", "b", 1)

    def test_repair_then_append_ok(self, repo):
        _put(repo, "schema-spec", "a", 1)
        self._corrupt_tail(repo)
        repo.repair_ledger_tail()
        _put(repo, "schema-spec", "b", 1)  # must not raise
        assert repo.get("schema-spec", "b", 1) is not None


class TestRepairAtomicity:
    def test_repair_preserves_valid_lines(self, repo):
        _put(repo, "schema-spec", "a", 1)
        _put(repo, "schema-spec", "b", 1)
        with open(repo.ledger_path, "a", encoding="utf-8") as f:
            f.write('{"type":"pipeline-spec","id":"par')
        repo.repair_ledger_tail()
        entries = repo.ledger()
        assert len(entries) == 2
        assert entries[0]["id"] == "a"
        assert entries[1]["id"] == "b"

    def test_repair_noop_when_intact(self, repo):
        _put(repo, "schema-spec", "a", 1)
        with pytest.raises(IntegrityError, match="no truncated"):
            repo.repair_ledger_tail()

    def test_reconcile_inside_lock(self, repo):
        """An object present on disk without a ledger entry is reconciled
        exactly once; a second reconcile is refused (not an orphan anymore)."""
        _put(repo, "schema-spec", "a", 1)
        # simulate orphan: manually create object without ledger entry
        import shutil
        obj_dir = repo.objects_dir / "schema-spec"
        obj_dir.mkdir(parents=True, exist_ok=True)
        orphan = obj_dir / "orphan@1.json"
        orphan.write_text(json.dumps({"id": "orphan"}), encoding="utf-8")
        issue = repo.reconcile("schema-spec", "orphan", 1)
        assert issue.code == "ORPHAN_OBJECT"
        with pytest.raises(IntegrityError, match="not an orphan"):
            repo.reconcile("schema-spec", "orphan", 1)


class TestHashVerification:
    def test_content_hash_mismatch_detected(self, repo):
        _put(repo, "schema-spec", "a", 1)
        # tamper with the object on disk (keep it valid JSON, different content)
        target = repo._path("schema-spec", "a", 1)
        target.write_text('{"id": "a", "v": 1, "tampered": true}\n', encoding="utf-8")
        codes = {i.code for i in repo.integrity_scan()}
        assert "CONTENT_HASH_MISMATCH" in codes

    def test_duplicate_ledger_entry_detected(self, repo):
        _put(repo, "schema-spec", "a", 1)
        # duplicate the ledger line manually
        with open(repo.ledger_path, "a", encoding="utf-8") as f:
            f.write(open(repo.ledger_path, encoding="utf-8").read())
        codes = {i.code for i in repo.integrity_scan()}
        assert "DUPLICATE_LEDGER_ENTRY" in codes
