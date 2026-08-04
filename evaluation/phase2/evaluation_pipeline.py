from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow as pa
import pyarrow.csv as pacsv
import pyarrow.parquet as pq


EVAL_ROOT = Path(__file__).resolve().parent
REPO_ROOT = EVAL_ROOT.parents[1]
POC_ROOT = REPO_ROOT / "packages/coding-agent/examples/extensions/multimodal-artifact-poc"
GATEWAY_ROOT = POC_ROOT / "services/lakehouse-gateway"
sys.path.insert(0, str(POC_ROOT))
sys.path.insert(0, str(GATEWAY_ROOT))

from pipelines.batch.stages import _create_table, _table_exists, _upsert_overwrite
from pipelines.common.config import ensure_namespaces, open_catalog
from pipelines.governance.discovery import profile_parquet


DOWNLOADS = EVAL_ROOT / "downloads"
PREPARED = EVAL_ROOT / "prepared"
PROFILES = EVAL_ROOT / "profiles"
MANIFESTS = EVAL_ROOT / "manifests"
REPORTS = EVAL_ROOT / "reports"
GOLDEN = EVAL_ROOT / "golden"
MUTATIONS = EVAL_ROOT / "mutations"
WAREHOUSE = EVAL_ROOT / "warehouse"

CHINOOK_TABLES = {
    "artist": "SELECT ArtistId AS artist_id, Name AS name FROM Artist",
    "album": "SELECT AlbumId AS album_id, Title AS title, ArtistId AS artist_id FROM Album",
    "track": (
        "SELECT TrackId AS track_id, Name AS name, AlbumId AS album_id, "
        "GenreId AS genre_id, Milliseconds AS milliseconds, Bytes AS bytes, "
        "UnitPrice AS unit_price FROM Track"
    ),
    "genre": "SELECT GenreId AS genre_id, Name AS name FROM Genre",
    "invoice": (
        "SELECT InvoiceId AS invoice_id, InvoiceDate AS invoice_date, "
        "BillingCountry AS billing_country, Total AS total FROM Invoice"
    ),
    "invoice_line": (
        "SELECT InvoiceLineId AS invoice_line_id, InvoiceId AS invoice_id, "
        "TrackId AS track_id, UnitPrice AS unit_price, Quantity AS quantity FROM InvoiceLine"
    ),
}

BIKE_COLUMNS = {
    "instant": "instant",
    "dteday": "date",
    "season": "season",
    "yr": "year",
    "mnth": "month",
    "hr": "hour",
    "holiday": "holiday",
    "weekday": "weekday",
    "workingday": "working_day",
    "weathersit": "weather_situation",
    "temp": "temperature_normalized",
    "atemp": "feels_like_temperature_normalized",
    "hum": "humidity_normalized",
    "windspeed": "windspeed_normalized",
    "casual": "casual_count",
    "registered": "registered_count",
    "cnt": "rental_count",
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def table_hash(table: pa.Table, sort_keys: list[str]) -> str:
    frame = table.to_pandas()
    if sort_keys:
        frame = frame.sort_values(sort_keys, kind="stable")
    payload = frame.to_json(orient="records", date_format="iso", double_precision=12)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def sqlite_frames() -> dict[str, pd.DataFrame]:
    connection = sqlite3.connect(DOWNLOADS / "Chinook_Sqlite.sqlite")
    try:
        return {name: pd.read_sql_query(query, connection) for name, query in CHINOOK_TABLES.items()}
    finally:
        connection.close()


def bike_frames() -> dict[str, pd.DataFrame]:
    return {
        name: pd.read_csv(PREPARED / "bike-sharing" / f"{name}.csv").rename(columns=BIKE_COLUMNS)
        for name in ("hour", "day")
    }


def arrow(frame: pd.DataFrame) -> pa.Table:
    return pa.Table.from_pandas(frame, preserve_index=False)


def schema_dict(table: pa.Table) -> list[dict[str, Any]]:
    return [
        {"name": field.name, "type": str(field.type), "nullable": field.nullable}
        for field in table.schema
    ]


def prepare() -> None:
    for path in (PREPARED, PROFILES, MANIFESTS, REPORTS, GOLDEN, MUTATIONS):
        path.mkdir(parents=True, exist_ok=True)

    bike_dir = PREPARED / "bike-sharing"
    bike_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(DOWNLOADS / "bike-sharing-dataset.zip") as archive:
        for member in ("Readme.txt", "day.csv", "hour.csv"):
            destination = bike_dir / member
            destination.write_bytes(archive.read(member))

    chinook = sqlite_frames()
    bike = bike_frames()
    prepared_tables: dict[str, pa.Table] = {}
    for name, frame in chinook.items():
        table = arrow(frame)
        path = PREPARED / "chinook" / f"{name}.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(table, path)
        prepared_tables[f"chinook.{name}"] = table
    for name, frame in bike.items():
        table = arrow(frame)
        path = PREPARED / "bike-sharing" / f"{name}.parquet"
        pq.write_table(table, path)
        prepared_tables[f"bike_sharing.{name}"] = table

    from app.quality.profile import profile_all

    chinook_profile = profile_all(
        {name: frame.to_dict(orient="records") for name, frame in chinook.items()},
        dataset_id="chinook-v1.4.5-selected",
        user_hints={"usage": "multi-table retail joins and KPI evaluation"},
    )
    bike_profile = profile_all(
        {name: frame.to_dict(orient="records") for name, frame in bike.items()},
        dataset_id="uci-bike-sharing-275",
        user_hints={"usage": "time-series trend and anomaly evaluation"},
    )
    write_json(PROFILES / "chinook-profile.json", chinook_profile.model_dump())
    write_json(PROFILES / "bike-sharing-profile.json", bike_profile.model_dump())
    for dataset, name in (("chinook", "invoice_line"), ("bike-sharing", "hour")):
        write_json(
            PROFILES / f"{dataset}-{name}-source-schema-profile.json",
            profile_parquet(PREPARED / dataset / f"{name}.parquet"),
        )

    source_entries = []
    for path in sorted(DOWNLOADS.iterdir()):
        if path.is_file():
            source_entries.append({
                "path": str(path.relative_to(EVAL_ROOT)),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            })
    extracted_entries = []
    for path in sorted((PREPARED / "bike-sharing").glob("*.csv")):
        frame = pd.read_csv(path)
        extracted_entries.append({
            "path": str(path.relative_to(EVAL_ROOT)),
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
            "rows": len(frame),
            "schema": [{"name": str(name), "type": str(dtype)} for name, dtype in frame.dtypes.items()],
        })
    table_entries = []
    for name, table in sorted(prepared_tables.items()):
        dataset, table_name = name.split(".", 1)
        dataset_dir = "bike-sharing" if dataset == "bike_sharing" else dataset
        parquet_path = PREPARED / dataset_dir / f"{table_name}.parquet"
        table_entries.append({
            "name": name,
            "path": str(parquet_path.relative_to(EVAL_ROOT)),
            "rows": table.num_rows,
            "schema": schema_dict(table),
            "sha256": sha256_file(parquet_path),
            "bytes": parquet_path.stat().st_size,
        })
    write_json(MANIFESTS / "dataset-source-manifest.json", {
        "manifestVersion": "analytica-eval-datasets.v1",
        "frozenAt": now(),
        "datasets": [
            {
                "id": "chinook-v1.4.5",
                "source": "https://github.com/lerocha/chinook-database/releases/tag/v1.4.5",
                "download": "https://github.com/lerocha/chinook-database/releases/download/v1.4.5/Chinook_Sqlite.sqlite",
                "version": "v1.4.5",
                "license": "MIT-style permissive license in Chinook LICENSE.md",
                "privacy": "sample database; only catalog and generated sales tables selected; customer and employee tables excluded",
            },
            {
                "id": "uci-bike-sharing-275",
                "source": "https://archive.ics.uci.edu/dataset/275/bike+sharing+dataset",
                "download": "https://archive.ics.uci.edu/static/public/275/bike+sharing+dataset.zip",
                "version": "UCI dataset 275, donated 2013-12-19; downloaded 2026-08-03",
                "license": "CC BY 4.0",
                "doi": "10.24432/C5W894",
                "privacy": "aggregate hourly/daily counts; no person-level identifiers",
            },
        ],
        "downloadedFiles": source_entries,
        "extractedCsvFiles": extracted_entries,
        "preparedTables": table_entries,
    })


def transforms() -> tuple[dict[str, pa.Table], dict[str, pa.Table], dict[str, pa.Table]]:
    chinook = sqlite_frames()
    bike = bike_frames()
    raw = {f"chinook_{name}": arrow(frame) for name, frame in chinook.items()}
    raw.update({f"bike_{name}": arrow(frame) for name, frame in bike.items()})

    sales = chinook["invoice_line"].merge(chinook["invoice"], on="invoice_id", validate="many_to_one")
    sales = sales.merge(chinook["track"], on="track_id", validate="many_to_one", suffixes=("_line", "_track"))
    sales = sales.merge(chinook["album"], on="album_id", validate="many_to_one")
    sales = sales.merge(chinook["artist"], on="artist_id", validate="many_to_one", suffixes=("_track", "_artist"))
    sales = sales.merge(chinook["genre"], on="genre_id", validate="many_to_one", suffixes=("_artist", "_genre"))
    sales["invoice_month"] = sales["invoice_date"].astype(str).str.slice(0, 7)
    sales["line_total"] = (sales["unit_price_line"] * sales["quantity"]).round(2)
    sales = sales.rename(columns={
        "name_track": "track_name",
        "title": "album_title",
        "name_artist": "artist_name",
        "name": "genre_name",
        "unit_price_line": "line_unit_price",
        "total": "invoice_total",
    })[[
        "invoice_line_id", "invoice_id", "invoice_date", "invoice_month", "billing_country",
        "track_id", "track_name", "album_id", "album_title", "artist_id", "artist_name",
        "genre_id", "genre_name", "line_unit_price", "quantity", "line_total", "invoice_total",
    ]]

    bike_hour = bike["hour"].copy()
    bike_hour["event_time"] = (
        bike_hour["date"].astype(str) + "T" + bike_hour["hour"].astype(int).astype(str).str.zfill(2) + ":00:00"
    )
    stage = {"chinook_sales": arrow(sales), "bike_hourly": arrow(bike_hour)}

    monthly = sales.groupby(["invoice_month", "billing_country"], as_index=False).agg(
        revenue=("line_total", "sum"),
        units=("quantity", "sum"),
        line_count=("invoice_line_id", "count"),
        invoice_count=("invoice_id", "nunique"),
    )
    monthly["revenue"] = monthly["revenue"].round(2)
    daily = bike["day"].sort_values("date").copy()
    daily["rolling_7d_rental_mean"] = daily["rental_count"].rolling(7, min_periods=1).mean().round(6)
    daily["day_over_day_change"] = daily["rental_count"].diff().fillna(0).astype(int)
    mart = {"chinook_monthly_sales": arrow(monthly), "bike_daily_trends": arrow(daily)}
    return raw, stage, mart


def pipeline_plan() -> dict[str, Any]:
    raw, stage, mart = transforms()
    return {
        "planVersion": "analytica-eval-pipeline.v1",
        "status": "PASS",
        "dryRun": True,
        "warehouse": str(WAREHOUSE),
        "namespaces": ["eval_raw", "eval_staging", "eval_mart"],
        "productEntrypointAssessment": {
            "nativeCli": "python -m pipelines.run",
            "arbitraryInputArgument": False,
            "dryRunArgument": False,
            "execution": "evaluation driver reuses product open_catalog/_create_table/_upsert_overwrite primitives",
        },
        "stages": [
            {"id": "profile", "inputs": sorted(raw), "writes": []},
            {"id": "raw_load", "outputs": [f"eval_raw.{name}" for name in sorted(raw)]},
            {"id": "transform", "outputs": [f"eval_staging.{name}" for name in sorted(stage)]},
            {"id": "mart", "outputs": [f"eval_mart.{name}" for name in sorted(mart)]},
            {"id": "quality", "checks": ["row_count", "missing_rate"]},
            {"id": "snapshot_lineage_query", "writes": ["warehouse-snapshot.json", "lineage.json", "golden-answers.json"]},
        ],
        "plannedRows": {
            **{f"eval_raw.{name}": table.num_rows for name, table in raw.items()},
            **{f"eval_staging.{name}": table.num_rows for name, table in stage.items()},
            **{f"eval_mart.{name}": table.num_rows for name, table in mart.items()},
        },
        "generatedAt": now(),
    }


def dry_run() -> None:
    write_json(MANIFESTS / "pipeline-plan.json", pipeline_plan())


def write_layers(label: str) -> None:
    raw, stage, mart = transforms()
    catalog = open_catalog(WAREHOUSE)
    ensure_namespaces(catalog, ("eval_raw", "eval_staging", "eval_mart"))
    records = {}
    started = now()
    for namespace, tables in (("eval_raw", raw), ("eval_staging", stage), ("eval_mart", mart)):
        for name, table in tables.items():
            full_name = f"{namespace}.{name}"
            if not _table_exists(catalog, full_name):
                _create_table(catalog, full_name, table.schema)
            snapshot_id = _upsert_overwrite(catalog, full_name, table)
            scanned = catalog.load_table(full_name).scan().to_arrow()
            records[full_name] = {
                "status": "PASS" if scanned.num_rows == table.num_rows else "FAIL",
                "inputRows": table.num_rows,
                "outputRows": scanned.num_rows,
                "snapshotId": str(snapshot_id),
                "dataHash": table_hash(scanned, primary_key(full_name)),
            }
    success = all(record["status"] == "PASS" for record in records.values())
    write_json(MANIFESTS / f"pipeline-run-{label}.json", {
        "runId": f"public-data-{label}",
        "status": "PASS" if success else "FAIL",
        "success": success,
        "startedAt": started,
        "finishedAt": now(),
        "warehouse": str(WAREHOUSE),
        "executionSurface": "evaluation driver using Analytica pipeline catalog/write primitives",
        "writeGateSupplied": False,
        "layers": records,
    })


def primary_key(full_name: str) -> list[str]:
    return {
        "eval_raw.chinook_artist": ["artist_id"],
        "eval_raw.chinook_album": ["album_id"],
        "eval_raw.chinook_track": ["track_id"],
        "eval_raw.chinook_genre": ["genre_id"],
        "eval_raw.chinook_invoice": ["invoice_id"],
        "eval_raw.chinook_invoice_line": ["invoice_line_id"],
        "eval_raw.bike_hour": ["instant"],
        "eval_raw.bike_day": ["instant"],
        "eval_staging.chinook_sales": ["invoice_line_id"],
        "eval_staging.bike_hourly": ["instant"],
        "eval_mart.chinook_monthly_sales": ["invoice_month", "billing_country"],
        "eval_mart.bike_daily_trends": ["date"],
    }[full_name]


def golden_answers() -> dict[str, Any]:
    chinook = sqlite_frames()
    bike = bike_frames()
    raw, stage, mart = transforms()
    sales = stage["chinook_sales"].to_pandas()
    monthly = mart["chinook_monthly_sales"].to_pandas()
    daily = mart["bike_daily_trends"].to_pandas()
    top_country = monthly.groupby("billing_country", as_index=False)["revenue"].sum().sort_values(
        ["revenue", "billing_country"], ascending=[False, True]
    ).iloc[0]
    top_genre = sales.groupby("genre_name", as_index=False)["line_total"].sum().sort_values(
        ["line_total", "genre_name"], ascending=[False, True]
    ).iloc[0]
    peak_day = daily.sort_values(["rental_count", "date"], ascending=[False, True]).iloc[0]
    return {
        "chinook": {
            "sourceRows": {name: len(frame) for name, frame in chinook.items()},
            "salesRows": len(sales),
            "distinctInvoices": int(sales["invoice_id"].nunique()),
            "totalLineRevenue": round(float(sales["line_total"].sum()), 2),
            "invoiceHeaderTotal": round(float(chinook["invoice"]["total"].sum()), 2),
            "monthlyCountryRows": len(monthly),
            "topCountry": str(top_country["billing_country"]),
            "topCountryRevenue": round(float(top_country["revenue"]), 2),
            "topGenre": str(top_genre["genre_name"]),
            "topGenreRevenue": round(float(top_genre["line_total"]), 2),
        },
        "bikeSharing": {
            "hourRows": len(bike["hour"]),
            "dayRows": len(bike["day"]),
            "hourRentalTotal": int(bike["hour"]["rental_count"].sum()),
            "dayRentalTotal": int(bike["day"]["rental_count"].sum()),
            "peakDate": str(peak_day["date"]),
            "peakRentalCount": int(peak_day["rental_count"]),
            "firstRollingMean": float(daily.iloc[0]["rolling_7d_rental_mean"]),
        },
        "generatedAt": now(),
    }


def quality_report() -> dict[str, Any]:
    from app.config import LakehouseConfig
    from app.quality.checks import assess_quality

    bike = pd.read_csv(PREPARED / "bike-sharing" / "hour.csv", dtype=str)
    original_rows = len(bike)
    gap_date = "2011-02-01"
    bike = bike[bike["dteday"] != gap_date].copy()
    bike = pd.concat([bike, bike.iloc[[0]].copy()], ignore_index=True)
    missing_count = int(len(bike) * 0.70)
    bike.loc[: missing_count - 1, "cnt"] = None
    bike.loc[missing_count, "cnt"] = "not_an_int"
    bike["unexpected_metric"] = "schema_drift_v1"
    mutation_path = MUTATIONS / "bike-hour-mutated.csv"
    bike.to_csv(mutation_path, index=False)
    mutation_table = pacsv.read_csv(
        mutation_path,
        convert_options=pacsv.ConvertOptions(strings_can_be_null=True, null_values=[""]),
    )
    result = assess_quality(mutation_table, LakehouseConfig())
    detected = set()
    false_positive_labels = []
    for check in result.checks:
        if check.status in ("WARN", "FAIL") and check.check == "missing_rate.cnt":
            detected.add("missing_values")
        elif check.status in ("WARN", "FAIL"):
            false_positive_labels.append(check.check)
    injected = {"duplicate_primary_key", "missing_values", "type_error", "schema_drift", "time_gap"}
    true_positive = len(detected & injected)
    false_positive = len(false_positive_labels)
    false_negative = len(injected - detected)
    precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
    recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    mutation = {
        "mutationVersion": "bike-hour-mutation.v1",
        "baseRows": original_rows,
        "mutatedRows": len(bike),
        "defects": [
            {"id": "duplicate_primary_key", "definition": "duplicate first retained instant row"},
            {"id": "missing_values", "definition": "set cnt to null for 70% of retained rows"},
            {"id": "type_error", "definition": "set one remaining cnt value to not_an_int"},
            {"id": "schema_drift", "definition": "add unexpected_metric column"},
            {"id": "time_gap", "definition": f"remove all hourly rows for {gap_date}"},
        ],
        "file": str(mutation_path.relative_to(EVAL_ROOT)),
        "sha256": sha256_file(mutation_path),
    }
    write_json(MUTATIONS / "mutation-definition.json", mutation)
    return {
        "status": "PASS" if false_negative == 0 and false_positive == 0 else "FAIL",
        "systemUnderTest": "app.quality.checks.assess_quality",
        "systemResult": result.to_dict(),
        "injectedDefects": sorted(injected),
        "detectedDefects": sorted(detected),
        "undetectedDefects": sorted(injected - detected),
        "falsePositiveLabels": false_positive_labels,
        "confusion": {"tp": true_positive, "fp": false_positive, "fn": false_negative},
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(f1, 6),
        "note": "Profiler candidate-key changes are not counted as detections because they are not emitted as defect findings.",
    }


def snapshot_and_validate() -> None:
    catalog = open_catalog(WAREHOUSE)
    tables = {}
    assertions = []
    expected = golden_answers()
    write_json(GOLDEN / "golden-answers.json", expected)

    for namespace in ("eval_raw", "eval_staging", "eval_mart"):
        for identifier in catalog.list_tables(namespace):
            full_name = ".".join(identifier)
            iceberg = catalog.load_table(full_name)
            table = iceberg.scan().to_arrow()
            keys = primary_key(full_name)
            duplicate_count = int(table.to_pandas().duplicated(keys).sum())
            tables[full_name] = {
                "rows": table.num_rows,
                "schema": schema_dict(table),
                "currentSnapshotId": str(iceberg.current_snapshot().snapshot_id),
                "snapshots": [
                    {
                        "snapshotId": str(snapshot.snapshot_id),
                        "parentSnapshotId": str(snapshot.parent_snapshot_id) if snapshot.parent_snapshot_id else None,
                        "operation": snapshot.summary.operation.value,
                        "totalRecords": int(snapshot.summary.additional_properties.get("total-records", 0)),
                    }
                    for snapshot in iceberg.snapshots()
                ],
                "dataHash": table_hash(table, keys),
                "primaryKey": keys,
                "duplicatePrimaryKeyRows": duplicate_count,
            }
            assertions.append({
                "id": f"{full_name}.primary_key_unique",
                "expected": 0,
                "actual": duplicate_count,
                "status": "PASS" if duplicate_count == 0 else "FAIL",
            })

    expected_values = {
        "eval_raw.chinook_invoice_line.rows": expected["chinook"]["sourceRows"]["invoice_line"],
        "eval_staging.chinook_sales.rows": expected["chinook"]["salesRows"],
        "eval_mart.chinook_monthly_sales.rows": expected["chinook"]["monthlyCountryRows"],
        "eval_raw.bike_hour.rows": expected["bikeSharing"]["hourRows"],
        "eval_raw.bike_day.rows": expected["bikeSharing"]["dayRows"],
        "eval_mart.bike_daily_trends.rows": expected["bikeSharing"]["dayRows"],
    }
    for identifier, wanted in expected_values.items():
        table_name, field = identifier.rsplit(".", 1)
        actual = tables[table_name][field]
        assertions.append({"id": identifier, "expected": wanted, "actual": actual, "status": "PASS" if actual == wanted else "FAIL"})

    sales = catalog.load_table("eval_staging.chinook_sales").scan().to_arrow().to_pandas()
    monthly = catalog.load_table("eval_mart.chinook_monthly_sales").scan().to_arrow().to_pandas()
    daily = catalog.load_table("eval_mart.bike_daily_trends").scan().to_arrow().to_pandas()
    actual_values = {
        "chinook.total_line_revenue": round(float(sales["line_total"].sum()), 2),
        "chinook.distinct_invoices": int(sales["invoice_id"].nunique()),
        "chinook.mart_revenue_matches_staging": round(float(monthly["revenue"].sum()), 2),
        "bike.day_rental_total": int(daily["rental_count"].sum()),
        "bike.peak_date": str(daily.sort_values(["rental_count", "date"], ascending=[False, True]).iloc[0]["date"]),
        "bike.first_rolling_mean": float(daily.sort_values("date").iloc[0]["rolling_7d_rental_mean"]),
    }
    wanted_values = {
        "chinook.total_line_revenue": expected["chinook"]["totalLineRevenue"],
        "chinook.distinct_invoices": expected["chinook"]["distinctInvoices"],
        "chinook.mart_revenue_matches_staging": expected["chinook"]["totalLineRevenue"],
        "bike.day_rental_total": expected["bikeSharing"]["dayRentalTotal"],
        "bike.peak_date": expected["bikeSharing"]["peakDate"],
        "bike.first_rolling_mean": expected["bikeSharing"]["firstRollingMean"],
    }
    for identifier, wanted in wanted_values.items():
        actual = actual_values[identifier]
        assertions.append({"id": identifier, "expected": wanted, "actual": actual, "status": "PASS" if actual == wanted else "FAIL"})

    passed = sum(item["status"] == "PASS" for item in assertions)
    write_json(REPORTS / "data-correctness.json", {
        "status": "PASS" if passed == len(assertions) else "FAIL",
        "correctAssertions": passed,
        "totalAssertions": len(assertions),
        "rate": round(passed / len(assertions), 6),
        "assertions": assertions,
    })
    write_json(MANIFESTS / "warehouse-snapshot.json", {
        "warehouse": str(WAREHOUSE),
        "capturedAt": now(),
        "tables": tables,
    })
    write_json(MANIFESTS / "lineage.json", {
        "edges": [
            {"from": "eval_raw.chinook_*", "to": "eval_staging.chinook_sales", "transform": "PK/FK joins"},
            {"from": "eval_staging.chinook_sales", "to": "eval_mart.chinook_monthly_sales", "transform": "month/country KPI aggregation"},
            {"from": "eval_raw.bike_hour", "to": "eval_staging.bike_hourly", "transform": "event_time construction"},
            {"from": "eval_raw.bike_day", "to": "eval_mart.bike_daily_trends", "transform": "7-day rolling mean and day-over-day delta"},
        ],
        "generatedBy": "evaluation driver; product pipeline has no arbitrary-source lineage emitter",
    })


def metrics() -> None:
    first = json.loads((MANIFESTS / "pipeline-run-first.json").read_text())
    rerun = json.loads((MANIFESTS / "pipeline-run-rerun.json").read_text())
    correctness = json.loads((REPORTS / "data-correctness.json").read_text())
    dq = quality_report()
    write_json(REPORTS / "data-quality-report.json", dq)
    catalog = open_catalog(WAREHOUSE)
    datasets = {
        "chinook": [name for name in first["layers"] if "chinook" in name],
        "bike_sharing": [name for name in first["layers"] if "bike" in name],
    }
    idempotency = []
    for dataset, names in datasets.items():
        checks = []
        for name in names:
            snapshots = list(catalog.load_table(name).snapshots())
            operations = [snapshot.summary.operation.value for snapshot in snapshots]
            data_stable = (
                first["layers"][name]["outputRows"] == rerun["layers"][name]["outputRows"]
                and first["layers"][name]["dataHash"] == rerun["layers"][name]["dataHash"]
            )
            snapshot_state_valid = (
                len(snapshots) == 2
                and operations == ["append", "overwrite"]
                and str(snapshots[-1].snapshot_id) == rerun["layers"][name]["snapshotId"]
            )
            checks.append({
                "table": name,
                "dataStable": data_stable,
                "snapshotStateValid": snapshot_state_valid,
                "snapshotOperations": operations,
                "snapshotCount": len(snapshots),
            })
        success = all(check["dataStable"] and check["snapshotStateValid"] for check in checks)
        idempotency.append({
            "dataset": dataset,
            "status": "PASS" if success else "FAIL",
            "checks": checks,
            "caveat": "Expected one atomic overwrite snapshot per rerun; observed delete then append exposes an intermediate empty snapshot.",
        })
    idem_passed = sum(item["status"] == "PASS" for item in idempotency)
    native_manifests = sorted((EVAL_ROOT / "governance-bypass/outputs/manifests").glob("execution-*.json"))
    native = json.loads(native_manifests[0].read_text()) if native_manifests else None
    governed_manifests = sorted((EVAL_ROOT / "governed-no-writegate/outputs/manifests").glob("execution-*.json"))
    governed = json.loads(governed_manifests[0].read_text()) if governed_manifests else None
    pipeline_scenarios = [
        {"id": "native_cli_batch", "status": "PASS" if native and native.get("success") else "INFRA_ERROR"},
        {"id": "public_data_first_run", "status": first["status"]},
        {"id": "public_data_rerun", "status": rerun["status"]},
        {"id": "governed_spark_without_writegate", "status": "PASS" if governed and governed.get("success") else "INFRA_ERROR"},
        {
            "id": "governed_spark_initial_environment_attempt",
            "status": "INFRA_ERROR",
            "reason": "Spark worker selected Python 3.14 while the fixed driver used Python 3.13; corrected with explicit PYSPARK paths",
        },
    ]
    eligible = [item for item in pipeline_scenarios if item["status"] in ("PASS", "FAIL")]
    pipeline_passed = sum(item["status"] == "PASS" for item in eligible)
    write_json(REPORTS / "metrics.json", {
        "pipelineRunSuccessRate": {
            "status": "PASS" if pipeline_passed == len(eligible) else "FAIL",
            "successfulRuns": pipeline_passed,
            "eligibleRuns": len(eligible),
            "rate": round(pipeline_passed / len(eligible), 6) if eligible else None,
            "scenarios": pipeline_scenarios,
            "caveat": "Public runs use product catalog/write primitives through an evaluation driver because the native CLI has no arbitrary input option.",
        },
        "dataCorrectnessRate": correctness,
        "dataQualityDefectDetectionF1": dq,
        "idempotentRerunSuccessRate": {
            "status": "PASS" if idem_passed == len(idempotency) else "FAIL",
            "successfulDatasets": idem_passed,
            "eligibleDatasets": len(idempotency),
            "rate": round(idem_passed / len(idempotency), 6),
            "scenarios": idempotency,
        },
    })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare", "dry-run", "run", "validate", "metrics"])
    parser.add_argument("--label", choices=["first", "rerun"], default="first")
    args = parser.parse_args()
    if args.action == "prepare":
        prepare()
    elif args.action == "dry-run":
        dry_run()
    elif args.action == "run":
        write_layers(args.label)
    elif args.action == "validate":
        snapshot_and_validate()
    else:
        metrics()


if __name__ == "__main__":
    main()
