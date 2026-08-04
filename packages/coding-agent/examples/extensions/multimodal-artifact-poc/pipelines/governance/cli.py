"""Governance CLI — explicit operator actions.

The agent never has shell access to this CLI and never holds write access to
the approval store. Decisions are recorded with approverSource=OPERATOR_CLI
and the OS actor of the invoking process.

All commands are gated by the Feature Resolver — when the corresponding
feature is not built or not effective the CLI refuses (exit != 0) and creates
no repository files.

Usage:
  python3 -m pipelines.governance design <profile.json> --usage "..." --target dwd.x [--pipeline-id p1]
  python3 -m pipelines.governance placement-design <profile.json> --usage "..." [--source src]
  python3 -m pipelines.governance review <schemaSpec.json> <pipelineSpec.json>
  python3 -m pipelines.governance approve <reviewId> --decision APPROVE|REQUEST_CHANGES|REJECT --comment "..."
  python3 -m pipelines.governance amend <reviewId> --schema-spec <file> --pipeline-spec <file> --reason "..."
  python3 -m pipelines.governance show <reviewId>
  python3 -m pipelines.governance sealed <specId> [--version N]
  python3 -m pipelines.governance verify
  python3 -m pipelines.governance reconcile <type> <id> <version>
  python3 -m pipelines.governance repair-ledger
"""
from __future__ import annotations

import argparse
import getpass
import json
import sys
from pathlib import Path

from pipelines.governance.repository import Repository

# feature id required per subcommand
COMMAND_FEATURES = {
    "design": ("round2.pipeline_governance", "round2.pipeline_schema_design"),
    "placement-design": ("round2.pipeline_governance", "round2.pipeline_placement_governance"),
    "review": ("round2.pipeline_governance", "round2.pipeline_schema_design",
               "round2.pipeline_spec_generation", "round2.pipeline_draft_compilation"),
    "approve": ("round2.pipeline_governance", "round2.pipeline_human_approval"),
    "cdxr-decide": ("round2.pipeline_governance", "round2.pipeline_cdxr_promotion_gate"),
    "amend": ("round2.pipeline_governance", "round2.pipeline_amendment",
              "round2.pipeline_human_approval"),
    "show": ("round2.pipeline_governance",),
    "sealed": ("round2.pipeline_governance", "round2.pipeline_human_approval"),
    "verify": ("round2.pipeline_governance",),
    "reconcile": ("round2.pipeline_governance",),
    "repair-ledger": ("round2.pipeline_governance",),
}


def _require_tty() -> None:
    """Human-only boundary: approvals must happen in a real terminal.
    Scripts/agents (piped stdin) cannot approve — decisions and comments
    are read interactively, never from command-line arguments."""
    if not sys.stdin.isatty():
        print(
            "ERROR: approval requires an interactive terminal (stdin is not a "
            "TTY) — scripts/agents cannot approve. Run the command yourself "
            "in a terminal.",
            file=sys.stderr,
        )
        sys.exit(2)


def _prompt(text: str) -> str:
    try:
        return input(text).strip()
    except EOFError:
        print("\nERROR: aborted (EOF) — approval not recorded", file=sys.stderr)
        sys.exit(2)


def _feature_gate(cmd: str) -> None:
    """Refuse to run when required features are not effective. Reads through
    the Feature Resolver only (never raw ENABLE_*)."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "lakehouse-gateway"))
        from app.features import get_default_resolver
    except Exception as e:  # pragma: no cover - env issue
        print(f"ERROR: cannot load feature resolver: {e}", file=sys.stderr)
        sys.exit(2)
    resolver = get_default_resolver()
    missing = [fid for fid in COMMAND_FEATURES[cmd] if not resolver.is_effective(fid)]
    if missing:
        print(f"ERROR: FEATURE_DISABLED: {', '.join(missing)} — '{cmd}' is not available", file=sys.stderr)
        sys.exit(2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipelines.governance")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_design = sub.add_parser("design", help="run the Agent DESIGN step: LLM caller "
                                             "proposes business semantics from a profile")
    p_design.add_argument("profile", type=Path, help="SourceDatasetProfile JSON")
    p_design.add_argument("--usage", required=True, help="target dataset usage")
    p_design.add_argument("--target", required=True, help="target dataset name (e.g. dwd.x)")
    p_design.add_argument("--pipeline-id", default="pipeline_1")
    p_design.add_argument("--version", type=int, default=1)

    p_placement = sub.add_parser("placement-design", help="run the Agent PLACEMENT role: "
                                                          "propose target layer from a profile")
    p_placement.add_argument("profile", type=Path, help="SourceDatasetProfile JSON")
    p_placement.add_argument("--usage", required=True, help="dataset usage")
    p_placement.add_argument("--source", default="source", help="source dataset name")
    p_placement.add_argument("--version", type=int, default=1)

    p_review = sub.add_parser("review", help="create a review package from two spec JSONs")
    p_review.add_argument("schema_spec", type=Path)
    p_review.add_argument("pipeline_spec", type=Path)
    p_review.add_argument("--requester", default="operator")

    p_approve = sub.add_parser(
        "approve",
        help="INTERACTIVE approval (terminal only): shows the review, prompts "
             "for the decision and comment. Scripts cannot approve.")
    p_approve.add_argument("review_id")

    p_cdxr = sub.add_parser(
        "cdxr-decide",
        help="INTERACTIVE CDXR feature-promotion decision (terminal only)")
    p_cdxr.add_argument("review_id")

    p_amend = sub.add_parser("amend", help="open an amendment from a CHANGES_REQUESTED review")
    p_amend.add_argument("review_id")
    p_amend.add_argument("--schema-spec", type=Path, required=True)
    p_amend.add_argument("--pipeline-spec", type=Path, required=True)
    p_amend.add_argument("--reason", required=True)

    p_show = sub.add_parser("show", help="show a review package")
    p_show.add_argument("review_id")

    p_sealed = sub.add_parser("sealed", help="list sealed approved specs for a specId")
    p_sealed.add_argument("spec_id")
    p_sealed.add_argument("--version", type=int, default=None)

    sub.add_parser("verify", help="run the repository integrity scan")

    p_reconcile = sub.add_parser("reconcile", help="record an orphan object as recovered")
    p_reconcile.add_argument("type", choices=["schema-spec", "pipeline-spec", "pipeline-draft-artifact",
                                              "approval-decision", "pipeline-amendment", "approved-pipeline-spec"])
    p_reconcile.add_argument("id")
    p_reconcile.add_argument("version", type=int)

    sub.add_parser("repair-ledger", help="drop a truncated final ledger line (explicit)")

    args = parser.parse_args(argv)

    # feature gate BEFORE any repository access
    _feature_gate(args.cmd)

    from pipelines.governance.flow import GovernancePhase1
    g = GovernancePhase1(Repository())

    try:
        if args.cmd == "design":
            profile = json.loads(args.profile.read_text(encoding="utf-8"))
            from pipelines.governance.agent_caller import caller_from_env
            from pipelines.governance.schema_designer import SchemaDesigner
            d = SchemaDesigner(caller=caller_from_env())
            r = d.design(profile, args.usage, args.pipeline_id, args.target,
                         version=args.version)
            if not r.get("ok"):
                print(f"ERROR: design failed: {r.get('error')}", file=sys.stderr)
                for issue in r.get("issues", []):
                    print(f"  {issue.get('code')}: {issue.get('message', '')}", file=sys.stderr)
                return 2
            print(json.dumps(r["schemaSpec"], ensure_ascii=False, indent=2))
            print("---PIPELINE---")
            print(json.dumps(r["pipelineSpec"], ensure_ascii=False, indent=2))
            return 0

        if args.cmd == "placement-design":
            profile = json.loads(args.profile.read_text(encoding="utf-8"))
            from pipelines.governance.agent_caller import caller_from_env
            from pipelines.governance.placement_designer import PlacementDesigner
            d = PlacementDesigner(caller=caller_from_env())
            r = d.design(profile, args.source, args.usage, version=args.version)
            if not r.get("ok"):
                print(f"ERROR: placement design failed: {r.get('error')}", file=sys.stderr)
                for issue in r.get("issues", []):
                    print(f"  {issue}", file=sys.stderr)
                return 2
            print(json.dumps(r["plan"], ensure_ascii=False, indent=2))
            return 0

        if args.cmd == "review":
            schema = json.loads(args.schema_spec.read_text(encoding="utf-8"))
            pipeline = json.loads(args.pipeline_spec.read_text(encoding="utf-8"))
            review = g.create_review_package(schema, pipeline, requester=args.requester)
            print(f"reviewId={review['reviewId']}")
            print(f"state={g.state_of(review)}")
            print(f"issues={json.dumps(review['validationIssues'], ensure_ascii=False)}")
            if review["pipelineDraftArtifact"]:
                print(f"draftArtifact={review['pipelineDraftArtifact']['artifactId']} "
                      f"executable={review['pipelineDraftArtifact']['executable']}")
            print(f"contentHash={review['contentHash']}")
            return 0

        if args.cmd == "approve":
            _require_tty()
            review = g.repo.get_review(args.review_id)
            if review is None:
                print(f"review {args.review_id} not found", file=sys.stderr)
                return 1
            print(f"--- review {args.review_id} ---")
            print(f"state: {g.state_of(review)}")
            print(f"requester: {review.get('requester', '?')}")
            print(f"contentHash: {review.get('contentHash', '')[:24]}...")
            for issue in review.get("validationIssues", [])[:5]:
                print(f"issue: {issue.get('code')}: {issue.get('message', '')[:80]}")
            print()
            decision = _prompt("决策 [APPROVE/REQUEST_CHANGES/REJECT]: ").upper()
            if decision not in ("APPROVE", "REQUEST_CHANGES", "REJECT"):
                print(f"ERROR: invalid decision '{decision}'", file=sys.stderr)
                return 2
            comment = _prompt("意见 comment（可空）: ")
            confirm = _prompt(f"确认以 '{decision}' 提交审批？[y/N]: ").lower()
            if confirm not in ("y", "yes"):
                print("已取消，审批未记录", file=sys.stderr)
                return 1
            os_actor = f"{getpass.getuser()}@{__import__('socket').gethostname()}"
            approval = g.approve(args.review_id, decision, os_actor=os_actor,
                                 comment=comment)
            print(f"approvalId={approval['approvalId']} decision={approval['decision']}")
            print(f"approverSource={approval['approverSource']} osActor={approval['osActor']}")
            if decision == "APPROVE":
                sealed = g.seal_approved(args.review_id, approval)
                print(f"sealed specId={sealed['specId']} v{sealed['version']}")
                print(f"  schemaSpecHash={sealed['schemaSpecHash'][:20]}...")
                print(f"  pipelineSpecHash={sealed['pipelineSpecHash'][:20]}...")
                print(f"  draftArtifactHash={sealed['draftArtifactHash'][:20]}...")
                print(f"  reviewPackageHash={sealed['reviewPackageHash'][:20]}...")
            return 0

        if args.cmd == "cdxr-decide":
            _require_tty()
            from pipelines.governance.cdxr_gate import CdxrPromotionGate
            gate_cdxr = CdxrPromotionGate(g.repo)
            obj = g.repo.get("feature-promotion-review", args.review_id, 1)
            if obj is None:
                print(f"CDXR review {args.review_id} not found", file=sys.stderr)
                return 1
            review = obj.content
            print(f"--- CDXR review {args.review_id} ---")
            print(f"dataset: {review.get('datasetAndSnapshot')}")
            print(f"cdxr status: {review.get('cdxrAssessment', {}).get('status')}")
            print(f"summary: {review.get('cdxrAssessment', {}).get('summary', '')[:120]}")
            print()
            decision = _prompt("决策 [APPROVE/ACCEPT_WITH_WAIVER/REJECT/REQUEST_FEATURE_CHANGES]: ").upper()
            comment = ""
            if decision == "ACCEPT_WITH_WAIVER":
                comment = _prompt("waiver 原因（必填）: ")
                if not comment:
                    print("ERROR: ACCEPT_WITH_WAIVER requires a comment", file=sys.stderr)
                    return 2
            elif decision not in ("APPROVE", "REJECT", "REQUEST_FEATURE_CHANGES"):
                print(f"ERROR: invalid decision '{decision}'", file=sys.stderr)
                return 2
            confirm = _prompt(f"确认以 '{decision}' 提交？[y/N]: ").lower()
            if confirm not in ("y", "yes"):
                print("已取消", file=sys.stderr)
                return 1
            os_actor = f"{getpass.getuser()}@{__import__('socket').gethostname()}"
            decided = gate_cdxr.decide(args.review_id, decision, os_actor=os_actor,
                                       comment=comment)
            print(f"status={decided['status']} decision={decided['decision']}")
            return 0

        if args.cmd == "amend":
            os_actor = f"{getpass.getuser()}@{__import__('socket').gethostname()}"
            # the approval that requested changes is the latest REQUEST_CHANGES
            # decision bound to this review
            approval = g.latest_changes_requested_approval(args.review_id)
            if approval is None:
                print(f"ERROR: review {args.review_id} has no REQUEST_CHANGES decision to amend from",
                      file=sys.stderr)
                return 1
            schema = json.loads(args.schema_spec.read_text(encoding="utf-8"))
            pipeline = json.loads(args.pipeline_spec.read_text(encoding="utf-8"))
            new_review = g.request_changes(args.review_id, approval, schema, pipeline,
                                           reason=args.reason)
            print(f"newReviewId={new_review['reviewId']} newVersion={new_review['pipelineSpec']['version']}")
            print(f"draftExecutable={new_review['pipelineDraftArtifact']['executable']}")
            print(f"issues={json.dumps(new_review['validationIssues'], ensure_ascii=False)}")
            return 0

        if args.cmd == "show":
            review = g.repo.get_review(args.review_id)
            if review is None:
                print(f"review {args.review_id} not found", file=sys.stderr)
                return 1
            print(json.dumps(review, ensure_ascii=False, indent=2))
            return 0

        if args.cmd == "sealed":
            obj = g.repo.get("approved-pipeline-spec", args.spec_id, args.version)
            if obj is None:
                print(f"no sealed spec {args.spec_id} v{args.version}", file=sys.stderr)
                return 1
            print(json.dumps(obj.content, ensure_ascii=False, indent=2))
            return 0

        if args.cmd == "verify":
            from pipelines.governance.repository import IntegrityError
            try:
                issues = g.repo.integrity_scan()
            except IntegrityError as e:
                print(f"ERROR: {e}", file=sys.stderr)
                return 1
            if not issues:
                print("integrity: OK")
                return 0
            for i in issues:
                print(f"{i.code}: {i.detail}")
            return 1

        if args.cmd == "reconcile":
            issue = g.repo.reconcile(args.type, args.id, args.version)
            print(f"{issue.code}: {issue.detail}")
            return 0

        if args.cmd == "repair-ledger":
            issue = g.repo.repair_ledger_tail()
            print(f"{issue.code}: {issue.detail}")
            return 0
    except (ValueError, FileNotFoundError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    except Exception as e:  # IntegrityError and friends
        print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
