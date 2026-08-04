"""Lightweight data lineage — deterministic, metadata-based.

The original platform had NO lineage module (see audit: lineage is only
indirectly expressed via contract fields). This is a new minimal
implementation:
  - automatic layer links by name prefix (ods_x → dwd_x → dws_x → ads_x)
  - explicit edge registration for arbitrary relationships
  - lineageReference strings (`lineage://<dataset>?snapshot=<id>`)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.catalog.dataset_registry import DatasetRegistry

_NAME_LINK_RE = re.compile(r"^(?:ods|dwd|dws|ads)[._](.+)$")


@dataclass(frozen=True)
class LineageEdge:
    source: str
    target: str
    kind: str = "derived_from"     # derived_from | copy | manual


@dataclass(frozen=True)
class LineageResult:
    dataset_id: str
    upstream: list[LineageEdge] = field(default_factory=list)
    downstream: list[LineageEdge] = field(default_factory=list)
    manual_edges: list[LineageEdge] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "dataset_id": self.dataset_id,
            "upstream": [{"source": e.source, "target": e.target, "kind": e.kind} for e in self.upstream],
            "downstream": [{"source": e.source, "target": e.target, "kind": e.kind} for e in self.downstream],
            "manual_edges": [{"source": e.source, "target": e.target, "kind": e.kind} for e in self.manual_edges],
        }


class LineageRegistry:
    def __init__(self, registry: DatasetRegistry):
        self._registry = registry
        self._manual: list[LineageEdge] = []

    def register_edge(self, source: str, target: str, kind: str = "manual") -> None:
        # canonicalize: edges are matched against canonical dataset ids at
        # explain() time; unresolvable ids (external tables) are kept verbatim
        def _canonical(name: str) -> str:
            meta = self._registry.get(name)
            return meta.dataset_id if meta is not None else name
        self._manual.append(LineageEdge(source=_canonical(source), target=_canonical(target), kind=kind))

    def explain(self, dataset_id: str) -> LineageResult:
        """Derive upstream/downstream from layer name links + manual edges."""
        meta = self._registry.get(dataset_id)
        if meta is None:
            raise LookupError(f"dataset '{dataset_id}' not found")
        canonical = meta.dataset_id

        # canonical id "<layer>.<layer>_<base>" (or short "<layer>_<base>")
        layer = canonical.split(".")[0] if "." in canonical else (canonical.split("_")[0] if canonical.startswith(("ods_", "dwd_", "dws_", "ads_")) else "")
        table_part = canonical.split(".", 1)[-1]
        m = _NAME_LINK_RE.match(canonical)
        base = m.group(1) if m else table_part
        if base.startswith(f"{layer}_"):
            base = base[len(layer) + 1:]
        all_ids = list(self._registry.discover()) if not self._registry._datasets else list(self._registry._datasets.keys())

        linked = []
        for prefix in ("ods", "dwd", "dws", "ads"):
            # single-prefix naming (ods.customers -> dwd.customers) and
            # legacy double-prefix naming (ods.ods_customers) are both linked
            candidate = f"{prefix}.{base}"
            if candidate not in all_ids:
                candidate = f"{prefix}.{prefix}_{base}"
            if candidate in all_ids and candidate != canonical:
                linked.append((prefix, candidate))
        linked.sort()

        upstream: list[LineageEdge] = []
        downstream: list[LineageEdge] = []
        layer_order = ["ods", "dwd", "dws", "ads"]
        my_idx = layer_order.index(layer) if layer in layer_order else 0
        for prefix, candidate in linked:
            idx = layer_order.index(prefix)
            edge = LineageEdge(source=candidate, target=canonical, kind="derived_from")
            if idx < my_idx:
                upstream.append(edge)
            else:
                downstream.append(LineageEdge(source=canonical, target=candidate, kind="derived_from"))

        manual_up = [e for e in self._manual if e.target == canonical]
        manual_down = [e for e in self._manual if e.source == canonical]
        return LineageResult(
            dataset_id=canonical,
            upstream=upstream + manual_up,
            downstream=downstream + manual_down,
            manual_edges=manual_up + manual_down,
        )
