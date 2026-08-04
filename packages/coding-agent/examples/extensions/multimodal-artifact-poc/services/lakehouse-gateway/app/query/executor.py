"""Query executor — read-only execution of validated plans.

Reads Iceberg tables via pyiceberg and computes with pyarrow (NO Spark/Flink
rewrite — the platform remains Python/SQL/PySpark/PyFlink; this executor is a
thin, dependency-light read path for the Query Gateway).

Result contract (spec §8):
  queryId / datasetId / datasetLayer / snapshotId / dataVersion / dataTimestamp
  / columns / rows / rowCount / qualityStatus / lineageReference / warnings

Guards:
  - execute_query only accepts a validatedQueryId (plans validated by validate_plan)
  - limit enforced (default 100, max 1000)
  - unbounded scans rejected (max_scan_rows)
  - sensitive fields masked
  - large results spilled to artifacts and returned as artifactId
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc


def _js_number(value: Any) -> str:
    """Serialize a number exactly like JSON.stringify after a JSON.parse
    round-trip in JavaScript (IEEE-754 double, shortest representation)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("not a number")
    d = float(value)
    if d != d or d in (float("inf"), float("-inf")):
        return "null"
    if d == int(d) and abs(d) < 2**53:
        return str(int(d))
    s = repr(d)
    if "e" in s:
        # ECMA-262 NumberToString: integral magnitudes < 1e21 serialize in
        # FIXED notation (e.g. 3874775481911838000), not exponential.
        mantissa, exp = s.split("e")
        e = int(exp)
        if "." in mantissa:
            int_part, frac_part = mantissa.lstrip("-").split(".")
        else:
            int_part, frac_part = mantissa.lstrip("-"), ""
        sign = "-" if mantissa.startswith("-") else ""
        digits = int_part + frac_part
        n = len(int_part) + e  # decimal point position (ECMA-262)
        if e >= 0 and n <= 21:
            return sign + digits + "0" * (n - len(digits))
        return f"{mantissa}e+{e}" if e > 0 else f"{mantissa}e-{abs(e)}"
    return s


def _js_stringify(obj: Any) -> str:
    """Minimal JSON.stringify equivalent for the artifact meta document
    (objects/arrays/strings/numbers/booleans; insertion order preserved)."""
    if isinstance(obj, dict):
        parts = [json.dumps(str(k), ensure_ascii=False) + ":" + _js_stringify(v)
                 for k, v in obj.items()]
        return "{" + ",".join(parts) + "}"
    if isinstance(obj, (list, tuple)):
        return "[" + ",".join(_js_stringify(v) for v in obj) + "]"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if obj is None:
        return "null"
    if isinstance(obj, (int, float)):
        return _js_number(obj)
    return json.dumps(str(obj), ensure_ascii=False)
import pyarrow.parquet as pq

from app.catalog.dataset_registry import DatasetRegistry
from app.config import LakehouseConfig
from app.query.plan import QueryPlan, ValidationResult

_MASK = "***"
_VALID_ID_RE = re.compile(r"^vq_[a-f0-9]{16}$")

# QueryPlan protocol aggregations → pyarrow hash function names.
_PYARROW_AGG = {"sum": "sum", "count": "count", "avg": "mean", "min": "min", "max": "max"}


@dataclass(frozen=True)
class QueryResult:
    queryId: str
    datasetId: str
    datasetLayer: str
    snapshotId: int | None = None
    dataVersion: str = ""
    dataTimestamp: str = ""
    columns: list[str] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)
    rowCount: int = 0
    qualityStatus: str = "PASS"
    lineageReference: str = ""
    warnings: list[str] = field(default_factory=list)
    artifactId: str = ""
    truncated: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "queryId": self.queryId,
            "datasetId": self.datasetId,
            "datasetLayer": self.datasetLayer,
            "snapshotId": self.snapshotId,
            "dataVersion": self.dataVersion,
            "dataTimestamp": self.dataTimestamp,
            "columns": self.columns,
            "rows": self.rows,
            "rowCount": self.rowCount,
            "qualityStatus": self.qualityStatus,
            "lineageReference": self.lineageReference,
            "warnings": self.warnings,
            "artifactId": self.artifactId,
            "truncated": self.truncated,
        }


class ValidationSession:
    """Stores validated plans; execute_query only accepts ids from here.

    Each entry is bound to the caller (x-client-id at validate time); executing
    with a different caller is rejected. Entries expire after TTL_S.
    """

    TTL_S = 600

    def __init__(self):
        self._plans: dict[str, tuple[float, QueryPlan, str]] = {}

    def put(self, validatedQueryId: str, plan: QueryPlan, caller: str = "anon") -> None:
        self._plans[validatedQueryId] = (time.time(), plan, caller)

    def get(self, validatedQueryId: str, caller: str = "anon") -> QueryPlan | None:
        entry = self._plans.get(validatedQueryId)
        if entry is None:
            return None
        ts, plan, bound_caller = entry
        if time.time() - ts > self.TTL_S:
            self._plans.pop(validatedQueryId, None)
            return None
        if bound_caller != caller:
            # reject without deleting (review round-4 P2): deleting on a
            # mismatched caller would let any other client one-shot-DoS the
            # legitimate caller; the entry lives until TTL expiry instead.
            return None
        return plan

    def expires_at_iso(self) -> str:
        return datetime.fromtimestamp(time.time() + self.TTL_S, tz=timezone.utc).isoformat()


class QueryExecutor:
    def __init__(self, config: LakehouseConfig, registry: DatasetRegistry, session: ValidationSession):
        self.config = config
        self.registry = registry
        self.session = session

    # -- entry point --------------------------------------------------

    def execute(self, validatedQueryId: str, caller: str = "anon") -> QueryResult:
        if not _VALID_ID_RE.fullmatch(validatedQueryId):
            raise ValueError("invalid validatedQueryId format")
        plan = self.session.get(validatedQueryId, caller=caller)
        if plan is None:
            raise LookupError(f"validatedQueryId '{validatedQueryId}' not found, expired, or bound to a different caller")
        return self._run(plan, validatedQueryId)

    # -- artifact materialization (round 4: data analysis inputs) --------

    def materialize(self, validatedQueryId: str, caller: str = "anon",
                    fmt: str = "parquet") -> dict[str, Any]:
        """Materialize a validated query into an immutable analysis artifact.

        Same validation, caller binding, permission, masking, row-limit and
        scan-limit path as execute(); the difference is that the full result
        is persisted as an artifact and only metadata is returned (no rows to
        the agent). The artifact is never written back to the business
        warehouse.
        """
        if fmt not in ("parquet", "arrow"):
            raise ValueError("format must be parquet or arrow")
        if not _VALID_ID_RE.fullmatch(validatedQueryId):
            raise ValueError("invalid validatedQueryId format")
        plan = self.session.get(validatedQueryId, caller=caller)
        if plan is None:
            raise LookupError(f"validatedQueryId '{validatedQueryId}' not found, expired, or bound to a different caller")
        result = self._run(plan, validatedQueryId)

        # Never materialize a truncated (sampled) result: execute() spills
        # oversized results to a 20-row agent summary; materializing that
        # summary would silently feed the analysis subagent a sample. Fail
        # explicitly instead — the caller must raise the row/size limits or
        # use a smaller query.
        if result.truncated:
            raise ValueError(
                f"result for '{validatedQueryId}' exceeds the materialization size limit "
                f"({self.config.max_result_bytes} bytes); refusing to materialize a truncated sample"
            )

        artifacts = Path(self.config.artifacts_dir) / "inputs"
        artifacts.mkdir(parents=True, exist_ok=True)
        artifact_id = f"art_{uuid.uuid4().hex[:16]}"
        # Rebuild an Arrow table from the masked, JSON-able rows so the
        # artifact carries exactly what a caller is allowed to see.
        table = pa.Table.from_arrays(
            [pa.array([row[i] if row[i] is not None else None for row in result.rows])
             for i in range(len(result.columns))],
            names=result.columns,
        )
        if fmt == "parquet":
            path = artifacts / f"{artifact_id}.data"
            pq.write_table(table, path)
        else:
            path = artifacts / f"{artifact_id}.data"
            with pa.OSFile(str(path), "wb") as sink:
                with pa.ipc.new_file(sink, table.schema) as writer:
                    writer.write_table(table)
        content_hash = _sha256_file(path)
        meta = {
            "artifactId": artifact_id,
            "queryId": result.queryId,
            "datasetId": result.datasetId,
            "snapshotId": result.snapshotId,
            "rowCount": result.rowCount,
            "columns": result.columns,
            "contentHash": content_hash,
            "masked": True,
            "format": fmt.upper(),
            "contentType": "application/vnd.apache.parquet" if fmt == "parquet"
                           else "application/vnd.apache.arrow.file",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "expiresAt": self.session.expires_at_iso(),
        }
        registry_path = artifacts / f"{artifact_id}.json"
        registry_path.write_text(
            json.dumps(meta, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")

        # Bridge into the trusted data-analysis store layout
        # (inputs/<id>/{data,meta,COMMITTED}) so run_data_analysis sharing the
        # same DATA_ANALYSIS_ARTIFACT_ROOT resolves the artifact directly.
        # metaHash binds the governance meta to the data bytes exactly like
        # the host-side ArtifactStore.register() does: the host recomputes it
        # over JSON.stringify(parsed meta), so the canonical body string MUST
        # use JS number serialization (double round-trip; iceberg snapshot ids
        # exceed 2^53 and would otherwise break the binding).
        trusted_dir = artifacts / artifact_id
        if not (trusted_dir / "COMMITTED").exists():
            body = {
                "artifactId": artifact_id,
                "contentType": meta["contentType"],
                "rowCount": result.rowCount,
                "columns": list(result.columns),
                "contentHash": content_hash,
                "queryId": result.queryId,
                "snapshotId": result.snapshotId,
                "masked": True,
                "createdAt": meta["createdAt"],
            }
            body_json = _js_stringify(body)
            meta_hash = hashlib.sha256(
                (body_json + ":" + content_hash).encode("utf-8")).hexdigest()
            stored = dict(body)
            stored["metaHash"] = meta_hash
            tmp_dir = artifacts / f".{artifact_id}.tmp-gw"
            shutil.rmtree(tmp_dir, ignore_errors=True)
            tmp_dir.mkdir(parents=True)
            try:
                (tmp_dir / "data").write_bytes(path.read_bytes())
                (tmp_dir / "meta").write_text(
                    json.dumps(stored, separators=(",", ":"), ensure_ascii=False),
                    encoding="utf-8")
                trusted_dir.mkdir(parents=True, exist_ok=True)
                os.replace(tmp_dir / "data", trusted_dir / "data")
                os.replace(tmp_dir / "meta", trusted_dir / "meta")
                (trusted_dir / "COMMITTED").write_text(meta_hash, encoding="utf-8")
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)

        return {**meta, "artifactPath": str(path)}  # stripped by the API route

    # -- execution ----------------------------------------------------

    def _run(self, plan: QueryPlan, validatedQueryId: str) -> QueryResult:
        qid = f"q_{uuid.uuid4().hex[:16]}"
        warnings: list[str] = []
        dataset = self.registry.get(plan.datasetId)
        if dataset is None:
            raise LookupError(f"dataset '{plan.datasetId}' not found")
        catalog = self.registry._get_catalog()
        if not catalog:
            raise RuntimeError(f"catalog unavailable: {self.registry.catalog_error or 'unknown'}")

        started = time.time()
        table = catalog.load_table(dataset.table_name)
        snapshot = table.current_snapshot()
        snapshot_id = snapshot.snapshot_id if snapshot else None
        data_timestamp = (
            datetime.fromtimestamp(snapshot.timestamp_ms / 1000, tz=timezone.utc).isoformat()
            if snapshot else ""
        )
        data_version = f"v{snapshot_id}" if snapshot_id else ""

        # Scan with pushdown: filters compiled to pyiceberg expressions, fields
        # projected at scan level, and the scan size estimated from metadata
        # (plan_files) BEFORE loading any data. This bounds cost even when the
        # table is large: rows > max_scan_rows are rejected without a full read.
        row_filter = self._build_row_filter(plan, table.schema())
        scan_fields = self._scan_fields(plan, table)
        # NOTE: pyiceberg rejects row_filter=None (default is AlwaysTrue) —
        # omit the argument when there is nothing to push down.
        scan_kwargs: dict[str, Any] = {"snapshot_id": snapshot_id,
                                       "selected_fields": scan_fields or None}
        if row_filter is not None:
            scan_kwargs["row_filter"] = row_filter
        scan = table.scan(**scan_kwargs)
        est_rows = sum(task.file.record_count for task in scan.plan_files())
        if est_rows > self.config.max_scan_rows:
            raise ValueError(f"scan would read {est_rows} rows > max_scan_rows {self.config.max_scan_rows}")
        tbl = scan.to_arrow()

        # Apply filters again on the scanned frame (idempotent; columns dropped
        # by projection are skipped) so in-memory results always match the plan.
        tbl = self._apply_filters(tbl, plan)
        warnings.extend(self._warn_masked(tbl, plan))

        # Compute projections / aggregations
        eav_label = self.config.sensitive_label_column
        eav_value = self.config.sensitive_value_column
        hide_label = False  # EAV safety: label attached for masking, removed after
        has_agg = any(s.aggregation for s in plan.select)
        if has_agg:
            # EAV safety: classify and mask sensitive value cells BEFORE
            # aggregating — pyarrow renames the column (field_value_min), so
            # post-hoc masking cannot recognize it, and min/max on strings
            # would otherwise return the raw sensitive value.
            tbl = self._mask_eav_pre_agg(tbl)
            groups = [d for d in plan.dimensions if d in tbl.column_names]
            # pyarrow 19: (col, func) pairs only — the 3-tuple (col, func, name)
            # form is deprecated (name must be FunctionOptions now).
            # protocol name "avg" maps to pyarrow's "mean" hash function.
            aggs = [(s.field, _PYARROW_AGG.get(s.aggregation, s.aggregation))
                    for s in plan.select if s.aggregation]
            result = tbl.group_by(groups).aggregate(aggs)
            rename = {}
            for s in plan.select:
                if s.aggregation:
                    default = f"{s.field}_{s.aggregation}"  # pyarrow: "<col>_<func>"
                    target = s.alias or default
                    if default in result.column_names and default != target:
                        rename[default] = target
            if rename:
                result = result.rename_columns([rename.get(c, c) for c in result.column_names])
        else:
            wanted = [s.field for s in plan.select] if plan.select else tbl.column_names
            wanted = [w for w in wanted if w in tbl.column_names]
            # EAV safety: when only the value column is projected, internally
            # attach the label column so value-level masking still applies
            # (the label column is removed again after masking). Without this a
            # query "select field_value where field_name = id_number" would leak
            # the raw sensitive value — masking needs the label to classify rows.
            if (eav_label in tbl.column_names and eav_value in wanted
                    and eav_label not in wanted):
                wanted.append(eav_label)
                hide_label = True
            result = tbl.select(wanted)

        # Enforce limit
        result = result.slice(0, plan.limit)

        # Serialize (mask sensitive fields — column-level + EAV value-level)
        columns = list(result.column_names)
        rows: list[list[Any]] = []
        for r in result.to_pylist():
            row = []
            for c in columns:
                v = r[c]
                if c in self.config.sensitive_fields and v is not None:
                    v = _MASK
                row.append(v)
            rows.append(row)
        rows = mask_rows(
            columns, rows, self.config.sensitive_fields,
            label_col=self.config.sensitive_label_column,
            value_col=self.config.sensitive_value_column,
        )
        if hide_label:
            li = columns.index(eav_label)
            columns.pop(li)
            rows = [r[:li] + r[li + 1:] for r in rows]
        rows = [[_jsonable(v) for v in row] for row in rows]

        row_count = len(rows)
        artifact_id = ""
        truncated = False
        body = {"columns": columns, "rows": rows}
        if len(json.dumps(body, ensure_ascii=False, default=str)) > self.config.max_result_bytes:
            # Spill to artifacts: agent context gets a summary only
            artifacts = Path(self.config.artifacts_dir)
            artifacts.mkdir(parents=True, exist_ok=True)
            artifact_path = artifacts / f"{qid}.json"
            artifact_path.write_text(json.dumps(body, ensure_ascii=False, default=str), encoding="utf-8")
            artifact_id = f"artifact://{artifact_path.name}"
            truncated = True
            rows = rows[:20]  # summary slice for the agent
            warnings.append(f"result spilled to {artifact_id}; agent receives a 20-row summary")

        elapsed_ms = int((time.time() - started) * 1000)
        if elapsed_ms > self.config.max_execution_ms:
            # NOTE (review round-4 P1/P2): this is a POST-HOC budget warning,
            # NOT a timeout enforcement — the scan already completed. Real
            # enforcement needs worker/process-level cancellation or an
            # engine-side query timeout; out of scope for the local PoC.
            warnings.append(f"execution took {elapsed_ms}ms (budget {self.config.max_execution_ms}ms)")

        quality_status = self._quality_status(dataset, tbl)

        return QueryResult(
            queryId=qid,
            datasetId=dataset.dataset_id,
            datasetLayer=dataset.layer,
            snapshotId=snapshot_id,
            dataVersion=data_version,
            dataTimestamp=data_timestamp,
            columns=columns,
            rows=rows,
            rowCount=row_count,
            qualityStatus=quality_status,
            lineageReference=f"lineage://{dataset.dataset_id}?snapshot={snapshot_id or 'none'}",
            warnings=warnings,
            artifactId=artifact_id,
            truncated=truncated,
        )

    # -- helpers ------------------------------------------------------

    def _build_row_filter(self, plan: QueryPlan, schema) -> Any | None:
        """Compile plan filters into pyiceberg expressions for scan pushdown."""
        from pyiceberg import expressions as E
        known = {f.name for f in schema.fields}
        parts = []
        for f in plan.filters:
            if f.field not in known:
                continue
            col, op, v = f.field, f.operator, f.value
            if op == "eq":
                e: Any = E.EqualTo(col, v)
            elif op == "neq":
                e = E.NotEqualTo(col, v)
            elif op == "gt":
                e = E.GreaterThan(col, v)
            elif op == "gte":
                e = E.GreaterThanOrEqual(col, v)
            elif op == "lt":
                e = E.LessThan(col, v)
            elif op == "lte":
                e = E.LessThanOrEqual(col, v)
            elif op == "between" and isinstance(v, list) and len(v) == 2:
                e = E.And(E.GreaterThanOrEqual(col, v[0]), E.LessThanOrEqual(col, v[1]))
            elif op == "in" and isinstance(v, list):
                e = E.In(col, v)
            elif op == "is_null":
                e = E.IsNull(col)
            elif op == "is_not_null":
                e = E.NotNull(col)
            else:
                continue
            parts.append(e)
        if not parts:
            return None
        return E.And(*parts) if len(parts) > 1 else parts[0]

    def _scan_fields(self, plan: QueryPlan, table) -> list[str] | None:
        """Columns needed downstream (projection + aggregation + filters).

        EAV safety: whenever the EAV value column is referenced, the label
        column is attached internally too — masking must be able to classify
        each row even when the query never filters/projects the label (a
        filter on an unrelated column like image_id/created_at must not make
        sensitive values unmaskable)."""
        wanted = ([s.field for s in plan.select]
                  + list(plan.dimensions or [])
                  + [f.field for f in plan.filters])
        if (self.config.sensitive_label_column in wanted
                or self.config.sensitive_value_column in wanted):
            wanted.append(self.config.sensitive_label_column)
        known = {f.name for f in table.schema().fields}
        fields = [c for c in dict.fromkeys(wanted) if c in known]
        return fields or None

    def _mask_eav_pre_agg(self, tbl: pa.Table) -> pa.Table:
        """Row-level EAV classification on the scanned frame (pre-aggregation).

        Masks value cells whose label is sensitive, so an aggregated EAV value
        column can never leak a sensitive string through the renamed result
        column. Applies to string value columns (the PoC EAV shape); numeric
        EAV value columns are out of scope for row classification."""
        label_col = self.config.sensitive_label_column
        value_col = self.config.sensitive_value_column
        if label_col not in tbl.column_names or value_col not in tbl.column_names:
            return tbl
        labels = tbl.column(label_col)
        values = tbl.column(value_col)
        if not pa.types.is_string(values.type):
            return tbl
        if not pa.types.is_string(labels.type):
            labels = pc.cast(labels, pa.string())
        sensitive = pa.array([s.lower() for s in self.config.sensitive_fields])
        is_sensitive = pc.fill_null(pc.is_in(pc.utf8_lower(labels), sensitive), False)
        masked = pc.if_else(is_sensitive, pa.scalar("***", type=pa.string()), values)
        return tbl.set_column(tbl.schema.get_field_index(value_col), value_col, masked)

    def _apply_filters(self, tbl: pa.Table, plan: QueryPlan) -> pa.Table:
        expr: Any = None
        for f in plan.filters:
            col = pc.field(f.field)
            if f.field not in tbl.column_names:
                continue
            pa_type = tbl.schema.field(f.field).type
            if f.operator == "is_null":
                e = pc.is_null(col)
            elif f.operator == "is_not_null":
                e = pc.is_valid(col)
            elif f.operator == "between":
                lo, hi = f.value
                e = (col >= _to_scalar(lo, pa_type)) & (col <= _to_scalar(hi, pa_type))
            elif f.operator == "in":
                e = pc.is_in(col, pa.array([_to_scalar(v, pa_type) for v in f.value]))
            else:
                op = {
                    "eq": lambda: col == _to_scalar(f.value, pa_type),
                    "neq": lambda: col != _to_scalar(f.value, pa_type),
                    "gt": lambda: col > _to_scalar(f.value, pa_type),
                    "gte": lambda: col >= _to_scalar(f.value, pa_type),
                    "lt": lambda: col < _to_scalar(f.value, pa_type),
                    "lte": lambda: col <= _to_scalar(f.value, pa_type),
                }[f.operator]
                e = op()
            expr = e if expr is None else (expr & e)
        if expr is not None:
            return tbl.filter(expr)
        return tbl

    def _warn_masked(self, tbl: pa.Table, plan: QueryPlan) -> list[str]:
        touched = {s.field for s in plan.select} | set(plan.dimensions) | {f.field for f in plan.filters}
        sensitive = sorted(touched & set(self.config.sensitive_fields))
        warnings = []
        if sensitive:
            warnings.append(f"sensitive fields masked in result: {', '.join(sensitive)}")
        if (self.config.sensitive_label_column in touched
                and self.config.sensitive_value_column in touched):
            warnings.append(f"EAV sensitive values masked ({self.config.sensitive_value_column})")
        return warnings

    def _quality_status(self, dataset, scanned: pa.Table) -> str:
        """Deterministic quality gate on the scanned data (see app.quality)."""
        from app.quality.checks import assess_scan_quality
        return assess_scan_quality(scanned, self.config)


def _sha256_file(path: Path) -> str:
    """SHA-256 of a file (artifact content hash)."""
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _to_scalar(value: Any, pa_type: Any) -> pa.Scalar:
    """Convert a JSON value to a pyarrow scalar compatible with the column type."""
    if isinstance(value, str):
        try:
            return pa.scalar(value, type=pa_type)
        except Exception:
            # date32/timestamp scalars may not parse ISO strings — fall back
            # to python datetime objects.
            import datetime as _dt
            for ctor in (_dt.date.fromisoformat, _dt.datetime.fromisoformat):
                try:
                    return pa.scalar(ctor(value), type=pa_type)
                except Exception:
                    continue
    try:
        return pa.scalar(value, type=pa_type)
    except Exception:
        return pa.scalar(value)


def mask_rows(
    columns: list[str],
    rows: list[list[Any]],
    sensitive_fields: tuple[str, ...],
    label_col: str | None = None,
    value_col: str | None = None,
) -> list[list[Any]]:
    """Mask sensitive values.

    - Column-level: any column whose name is in sensitive_fields → masked.
    - EAV value-level: when the table has a label/value pair (e.g.
      field_name/field_value in ocr_result), a value cell is masked when its
      row's label matches a sensitive field name (id_number, phone, …).
    """
    label_idx = columns.index(label_col) if label_col and label_col in columns else -1
    value_idx = columns.index(value_col) if value_col and value_col in columns else -1
    sensitive = set(sensitive_fields)

    masked: list[list[Any]] = []
    for row in rows:
        out = list(row)
        for i, c in enumerate(columns):
            if out[i] is not None and c in sensitive:
                out[i] = _MASK
        if label_idx >= 0 and value_idx >= 0:
            label = out[label_idx]
            if isinstance(label, str) and label.lower() in sensitive and out[value_idx] is not None:
                out[value_idx] = _MASK
        masked.append(out)
    return masked


def _jsonable(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, bytes):
        return v.decode("utf-8", errors="replace")
    return str(v)
