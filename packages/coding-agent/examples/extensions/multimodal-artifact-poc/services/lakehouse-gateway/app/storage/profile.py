"""Cloud Storage Profiles — file:// and s3:// abstraction for Iceberg warehouse.

MIGRATED from LeakBench-RiskCloud (commit e386f920e352997282cdbf1fcfe5573a07b42b6a,
riskcloud/infra/storage.py). GENERALIZATION changes:
  - Env var prefix RISKCLOUD_* → LAKEHOUSE_* (no behavior change otherwise)
  - Removed riskcloud-specific default warehouse bucket name in cloud() defaults

Enables seamless switching between local dev and cloud deployment.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path


class StorageBackend(str, Enum):
    LOCAL = "local"
    S3 = "s3"


class CatalogBackend(str, Enum):
    HADOOP = "hadoop"
    GLUE = "glue"


@dataclass(frozen=True)
class StorageProfile:
    """Unified storage configuration for local and cloud deployments.

    Usage:
        # Local dev
        profile = StorageProfile.local_dev()

        # Cloud (S3 + Glue)
        profile = StorageProfile.cloud(
            warehouse="s3://my-bucket/iceberg/warehouse",
            region="us-east-1",
        )
    """
    backend: StorageBackend
    catalog_backend: CatalogBackend
    warehouse: str
    region: str = "us-east-1"
    checkpoint_dir: str = field(default="")
    artifact_dir: str = field(default="")

    @classmethod
    def local_dev(cls, warehouse: str | None = None) -> StorageProfile:
        """Create a local file:// profile for development."""
        if warehouse is None:
            warehouse = str(Path.cwd() / ".data" / "warehouse")
        return cls(
            backend=StorageBackend.LOCAL,
            catalog_backend=CatalogBackend.HADOOP,
            warehouse=f"file://{warehouse}",
            checkpoint_dir=f"file://{Path.cwd() / '.data' / 'flink' / 'checkpoints'}",
            artifact_dir=str(Path.cwd() / ".data" / "artifacts"),
        )

    @classmethod
    def cloud(
        cls,
        warehouse: str,
        region: str = "us-east-1",
        checkpoint_dir: str | None = None,
        artifact_dir: str | None = None,
    ) -> StorageProfile:
        """Create an s3:// profile for cloud deployment."""
        return cls(
            backend=StorageBackend.S3,
            catalog_backend=CatalogBackend.GLUE,
            warehouse=warehouse,
            region=region,
            checkpoint_dir=checkpoint_dir or f"s3://{_bucket_from_warehouse(warehouse)}/flink/checkpoints",
            artifact_dir=artifact_dir or f"s3://{_bucket_from_warehouse(warehouse)}/artifacts",
        )

    @classmethod
    def from_env(cls) -> StorageProfile:
        """Create profile from environment variables.

        Set LAKEHOUSE_STORAGE=s3 to use cloud mode.
        Defaults to local dev.
        """
        storage = os.environ.get("LAKEHOUSE_STORAGE", "local")
        if storage == "s3":
            return cls.cloud(
                warehouse=os.environ.get(
                    "LAKEHOUSE_S3_WAREHOUSE",
                    "s3://lakehouse-dev/iceberg/warehouse",
                ),
                region=os.environ.get("AWS_REGION", "us-east-1"),
                checkpoint_dir=os.environ.get("LAKEHOUSE_CHECKPOINT_DIR"),
                artifact_dir=os.environ.get("LAKEHOUSE_ARTIFACT_DIR"),
            )
        return cls.local_dev(
            warehouse=os.environ.get("LAKEHOUSE_WAREHOUSE_PATH"),
        )

    @property
    def warehouse_path(self) -> str:
        """Filesystem path (strips file:// prefix for local)."""
        if self.backend == StorageBackend.LOCAL:
            return self.warehouse.replace("file://", "")
        return self.warehouse

    @property
    def spark_catalog_type(self) -> str:
        return self.catalog_backend.value

    @property
    def flink_catalog_type(self) -> str:
        """Flink SQL catalog type string."""
        if self.catalog_backend == CatalogBackend.GLUE:
            return "hadoop"  # Flink uses hadoop catalog with s3 filesystem
        return "hadoop"

    def spark_configs(self, catalog_name: str = "lakehouse") -> dict[str, str]:
        """Spark configuration for this profile."""
        configs = {
            f"spark.sql.catalog.{catalog_name}": "org.apache.iceberg.spark.SparkCatalog",
            f"spark.sql.catalog.{catalog_name}.type": self.spark_catalog_type,
            f"spark.sql.catalog.{catalog_name}.warehouse": self.warehouse_path,
        }
        if self.backend == StorageBackend.S3:
            configs.update({
                f"spark.sql.catalog.{catalog_name}.io-impl": "org.apache.iceberg.aws.s3.S3FileIO",
                "spark.hadoop.fs.s3a.impl": "org.apache.hadoop.fs.s3a.S3AFileSystem",
                "spark.hadoop.fs.s3a.aws.credentials.provider":
                    "com.amazonaws.auth.DefaultAWSCredentialsProviderChain",
                f"spark.sql.catalog.{catalog_name}.client.region": self.region,
            })
        return configs

    def flink_sql_catalog_ddl(self, catalog_name: str = "lakehouse") -> str:
        """Flink SQL CREATE CATALOG DDL for this profile."""
        ddl = f"""
        CREATE CATALOG {catalog_name} WITH (
            'type' = 'iceberg',
            'catalog-type' = '{self.flink_catalog_type}',
            'warehouse' = '{self.warehouse}'
        )
        """
        if self.backend == StorageBackend.S3:
            ddl += f""",
            'io-impl' = 'org.apache.iceberg.aws.s3.S3FileIO',
            's3.region' = '{self.region}'
        """
        return ddl


def _bucket_from_warehouse(warehouse: str) -> str:
    """Extract the bucket name from an s3:// URI, or 'lakehouse' as fallback."""
    if warehouse.startswith("s3://"):
        rest = warehouse[len("s3://"):]
        return rest.split("/", 1)[0]
    return "lakehouse"
