"""Lakehouse Gateway configuration — env-driven, no hardcoded secrets.

Local mode (default, no AWS credentials required):
    LAKEHOUSE_MODE=local
    LAKEHOUSE_WAREHOUSE_PATH=./.data/warehouse
    LAKEHOUSE_CATALOG_TYPE=local

Cloud mode:
    LAKEHOUSE_MODE=aws
    LAKEHOUSE_S3_WAREHOUSE=s3://<bucket>/<prefix>
    LAKEHOUSE_CATALOG_TYPE=glue      (or hadoop)
    AWS_REGION=...

Buckets / regions / accounts / keys are NEVER hardcoded here; everything
comes from the environment.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from app.storage.profile import CatalogBackend, StorageBackend, StorageProfile


@dataclass(frozen=True)
class LakehouseConfig:
    """Gateway configuration derived from environment (or defaults)."""

    mode: str = "local"                       # "local" | "aws"
    warehouse_path: str = ".data/warehouse"   # local filesystem path or s3:// URI
    catalog_type: str = "local"               # "local" (hadoop, file://) | "glue" | "hadoop"
    region: str = "us-east-1"
    gateway_url: str = "http://localhost:8001"
    # Query limits (defaults per spec; overridable via env)
    default_limit: int = 100
    max_limit: int = 1000
    max_scan_rows: int = 1_000_000
    max_execution_ms: int = 30_000
    allow_ods: bool = False                   # ODS layer access is denied by default
    max_result_bytes: int = 256 * 1024        # results above this are spilled to artifacts
    artifacts_dir: str = str(Path.home() / ".pi" / "artifacts" / "data-analysis")
    # Field names treated as sensitive (masked in results)
    sensitive_fields: tuple[str, ...] = ("customer_id", "borrower_id", "account_number",
                                         "card_number", "phone", "email", "id_number",
                                         "ssn", "id_card")
    # EAV-style tables (label/value pairs, e.g. ocr_result): when the label
    # column's value matches a sensitive field name, the value column is masked.
    sensitive_label_column: str = "field_name"
    sensitive_value_column: str = "field_value"
    # Extra read-only safety (rejected patterns / SQL keywords — informational)
    forbidden_sql_keywords: tuple[str, ...] = ("insert", "update", "delete", "drop",
                                               "truncate", "alter", "merge", "grant",
                                               "revoke", "create", "replace", "vacuum")

    @classmethod
    def from_env(cls) -> "LakehouseConfig":
        mode = os.environ.get("LAKEHOUSE_MODE", "local")
        catalog_type = os.environ.get("LAKEHOUSE_CATALOG_TYPE", "local")
        if mode == "aws":
            warehouse = os.environ.get("LAKEHOUSE_S3_WAREHOUSE", "")
            if not warehouse:
                raise ValueError("LAKEHOUSE_MODE=aws requires LAKEHOUSE_S3_WAREHOUSE (s3://...)")
            if catalog_type not in ("glue", "hadoop"):
                catalog_type = "glue"
            warehouse_path = warehouse
        else:
            warehouse_path = os.environ.get(
                "LAKEHOUSE_WAREHOUSE_PATH",
                str(Path.cwd() / ".data" / "warehouse"),
            )
            catalog_type = "local"
        return cls(
            mode=mode,
            warehouse_path=warehouse_path,
            catalog_type=catalog_type,
            region=os.environ.get("AWS_REGION", "us-east-1"),
            gateway_url=os.environ.get("LAKEHOUSE_GATEWAY_URL", "http://localhost:8001"),
            default_limit=int(os.environ.get("LAKEHOUSE_DEFAULT_LIMIT", "100")),
            max_limit=int(os.environ.get("LAKEHOUSE_MAX_LIMIT", "1000")),
            max_scan_rows=int(os.environ.get("LAKEHOUSE_MAX_SCAN_ROWS", "1000000")),
            max_execution_ms=int(os.environ.get("LAKEHOUSE_MAX_EXECUTION_MS", "30000")),
            allow_ods=os.environ.get("LAKEHOUSE_ALLOW_ODS", "false").lower() == "true",
            max_result_bytes=int(os.environ.get("LAKEHOUSE_MAX_RESULT_BYTES", str(256 * 1024))),
            artifacts_dir=os.environ.get(
                "DATA_ANALYSIS_ARTIFACT_ROOT",
                os.environ.get("LAKEHOUSE_ARTIFACTS_DIR", str(Path.home() / ".pi" / "artifacts" / "data-analysis")),
            ),
            sensitive_fields=tuple(
                f.strip() for f in os.environ.get(
                    "LAKEHOUSE_SENSITIVE_FIELDS",
                    "customer_id,borrower_id,account_number,card_number,phone,email,id_number,ssn,id_card",
                ).split(",") if f.strip()
            ),
            sensitive_label_column=os.environ.get("LAKEHOUSE_SENSITIVE_LABEL_COLUMN", "field_name"),
            sensitive_value_column=os.environ.get("LAKEHOUSE_SENSITIVE_VALUE_COLUMN", "field_value"),
            forbidden_sql_keywords=tuple(
                k.strip() for k in os.environ.get(
                    "LAKEHOUSE_FORBIDDEN_SQL_KEYWORDS",
                    "insert,update,delete,drop,truncate,alter,merge,grant,revoke,create,replace,vacuum",
                ).split(",") if k.strip()
            ),
        )

    def storage_profile(self) -> StorageProfile:
        """Build a StorageProfile (local or cloud) from this config."""
        if self.mode == "aws":
            return StorageProfile.cloud(
                warehouse=self.warehouse_path,
                region=self.region,
            )
        return StorageProfile.local_dev(warehouse=self.warehouse_path)

    @property
    def is_aws(self) -> bool:
        return self.mode == "aws"

    @property
    def catalog_backend(self) -> CatalogBackend:
        return CatalogBackend.GLUE if self.catalog_type == "glue" else CatalogBackend.HADOOP

    @property
    def storage_backend(self) -> StorageBackend:
        return StorageBackend.S3 if self.is_aws else StorageBackend.LOCAL


# Lazily-built singleton (tests override via env + rebuild)
_config: LakehouseConfig | None = None


def get_config() -> LakehouseConfig:
    global _config
    if _config is None:
        _config = LakehouseConfig.from_env()
    return _config


def reload_config() -> LakehouseConfig:
    """Rebuild config from env (used by tests / after env changes)."""
    global _config
    _config = LakehouseConfig.from_env()
    return _config
