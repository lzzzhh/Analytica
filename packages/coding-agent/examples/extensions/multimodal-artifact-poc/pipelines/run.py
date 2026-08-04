"""Unified pipeline CLI.

Usage:
  python3 -m pipelines.run --mode batch     --profile small [--engine local|spark|flink] [--govern] [--reset]
  python3 -m pipelines.run --mode streaming --profile small [--replay events.jsonl] [--reset]
  python3 -m pipelines.run --mode hybrid    --profile medium [--reset]

Prints effective config, target warehouse, runId, per-layer row counts,
snapshot ids, stream counters; writes an execution manifest; exits non-zero
on failure. Never touches production credentials or S3.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from pipelines.common.config import PipelineConfig, load_config, profile_params, utc_now_iso


def _print_config(cfg: PipelineConfig) -> None:
    print(f"[pipeline] mode={cfg.mode} profile={cfg.profile} runId={cfg.run_id}")
    print(f"[pipeline] warehouse={cfg.warehouse}")
    print(f"[pipeline] source={cfg.source_dir}")
    print(f"[pipeline] checkpoints={cfg.checkpoints_dir}")
    print(f"[pipeline] outputs={cfg.outputs_dir}")


def _print_manifest(manifest, cfg: PipelineConfig) -> None:
    print(f"[pipeline] runId={manifest.run_id} success={manifest.success}")
    for key in sorted(manifest.layers):
        rec = manifest.layers[key]
        print(f"[pipeline]   {rec['table']}: in={rec['inputRows']} out={rec['outputRows']} snapshot={rec['snapshotId']}")
    if manifest.stream:
        print(f"[pipeline] stream counters: {json.dumps(manifest.stream)}")
    if manifest.checkpoint:
        print(f"[pipeline] checkpoint: {json.dumps(manifest.checkpoint)}")
    print(f"[pipeline] manifest: {manifest.path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipelines.run")
    parser.add_argument("--mode", choices=["batch", "streaming", "hybrid"], default="batch")
    parser.add_argument("--profile", choices=["small", "medium", "stress"], default="small")
    parser.add_argument("--engine", choices=["local", "spark", "flink"], default="local",
                        help="batch compute engine (local pyarrow / PySpark / PyFlink)")
    parser.add_argument("--govern", action="store_true",
                        help="run the engine through the governance loop (events -> runtime governance findings)")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--replay", default=None, help="path to events.jsonl for streaming replay")
    parser.add_argument("--micro-batch-size", type=int, default=25,
                        help="streaming micro-batch size (default 25)")
    parser.add_argument("--contract", type=Path,
                        help="declarative local CSV/Parquet ingestion contract")
    parser.add_argument("--warehouse", type=Path,
                        help="absolute local warehouse path (required with --contract)")
    parser.add_argument("--governance-root", type=Path,
                        help="governance repository containing the bound approval")
    parser.add_argument("--dry-run", action="store_true",
                        help="validate and print a plan without creating runtime artifacts")
    args = parser.parse_args(argv)

    if args.contract:
        if args.warehouse is None:
            parser.error("--warehouse is required with --contract")
        from pipelines.arbitrary import run_contract
        governance_root = args.governance_root or Path(
            os.environ.get("PIPELINE_GOVERNANCE_ROOT", ".data/pipeline-governance"))
        try:
            code, result = run_contract(
                args.contract.resolve(), args.warehouse.resolve(), governance_root.resolve(), args.dry_run)
        except Exception as error:  # noqa: BLE001
            print(f"[pipeline] FAILED: {type(error).__name__}: {error}", file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return code

    cfg = load_config(mode=args.mode, profile=args.profile, reset=args.reset, replay=args.replay,
                      micro_batch_size=args.micro_batch_size)
    _print_config(cfg)
    profile_params(cfg.profile)  # validate profile

    try:
        from pipelines.common.write_gate import WriteGate
        gate = WriteGate()
        if args.mode == "batch":
            from pipelines.batch.engine import engine_available, run_batch_with_engine
            if args.govern:
                from pipelines.batch.engine_governance import run_governed_batch
                manifest, findings, summary = run_governed_batch(cfg, args.engine, gate=gate)
                print(f"[pipeline] governance engine={args.engine} "
                      f"status={summary['status']} findings={len(findings)}")
                for f in findings:
                    print(f"[pipeline]   finding {f['findingId']} "
                          f"[{f['severity']}] {f['findingCode']} — {f.get('summary') or f.get('detail') or ''}")
            else:
                if not engine_available(args.engine):
                    print(f"[pipeline] engine '{args.engine}' not available in this "
                          f"Python interpreter (spark: pyspark, flink: pyflink <= 3.12)",
                          file=sys.stderr)
                    return 2
                manifest = run_batch_with_engine(cfg, args.engine, gate=gate)
        elif args.mode == "streaming":
            from pipelines.streaming.run_streaming import run_streaming
            manifest = run_streaming(cfg, gate)
        else:
            from pipelines.hybrid.run_hybrid import run_hybrid
            manifest = run_hybrid(cfg, gate)
    except Exception as e:  # noqa: BLE001
        print(f"[pipeline] FAILED: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    if not manifest.success:
        print(f"[pipeline] FAILED: {manifest.error}", file=sys.stderr)
        return 1

    _print_manifest(manifest, cfg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
