"""Fetching and inspecting the input layers.

Two access modes, deliberately distinguished:

* ``auto``   - an open REST service this module can page through unattended.
* ``manual`` - a portal download behind a form or a licence click-through. The
  pipeline will not pretend it can fetch these; it tells you precisely which
  file to put where, and refuses to run without them rather than substituting a
  default and producing a confident-looking map built on nothing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import requests

from .config import Config, Source

USER_AGENT = "bog-orchid-habitat-model/1.0 (+conservation research)"
PAGE_SIZE = 1000
TIMEOUT = 120


class AcquisitionError(RuntimeError):
    """Raised when a layer cannot be fetched."""


@dataclass
class LayerStatus:
    name: str
    path: Path
    present: bool
    optional: bool
    mode: str
    detail: str = ""
    instructions: str = ""


def raw_dir(data_dir: str | Path) -> Path:
    return Path(data_dir) / "raw"


def source_path(data_dir: str | Path, source: Source) -> Path:
    if not source.filename:
        raise AcquisitionError(f"source {source.name!r} has no filename configured")
    return raw_dir(data_dir) / source.filename


def _session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    return session


def probe_featureserver(url: str) -> dict[str, Any]:
    """Ask a FeatureServer layer to describe itself.

    Worth running before a full download: Natural England renumber their layer
    indices from time to time, and the habitat field has had several names.
    """
    with _session() as session:
        response = session.get(url, params={"f": "json"}, timeout=TIMEOUT)
        response.raise_for_status()
        info = response.json()
    if "error" in info:
        raise AcquisitionError(f"{url}: {info['error']}")
    return {
        "name": info.get("name"),
        "type": info.get("type"),
        "geometryType": info.get("geometryType"),
        "maxRecordCount": info.get("maxRecordCount"),
        "fields": [
            {"name": f.get("name"), "type": f.get("type"), "alias": f.get("alias")}
            for f in info.get("fields", [])
        ],
    }


def fetch_featureserver(
    url: str,
    bbox: tuple[float, float, float, float] | None = None,
    where: str | None = None,
    out_sr: int = 27700,
    page_size: int = PAGE_SIZE,
    max_pages: int = 2000,
) -> dict[str, Any]:
    """Page a whole ArcGIS FeatureServer layer into one GeoJSON FeatureCollection.

    ArcGIS caps a single response at ``maxRecordCount`` features and signals more
    with ``exceededTransferLimit``; paging with ``resultOffset`` is the only way
    to get a complete answer. A query that silently stops at the first page is
    the classic way to end up with a Priority Habitat layer covering the
    north-east corner of the moor and nothing else.
    """
    query_url = url.rstrip("/") + "/query"
    params: dict[str, Any] = {
        "f": "geojson",
        "where": where or "1=1",
        "outFields": "*",
        "outSR": out_sr,
        "returnGeometry": "true",
        "resultRecordCount": page_size,
    }
    if bbox is not None:
        params.update(
            {
                "geometry": json.dumps(
                    {
                        "xmin": bbox[0], "ymin": bbox[1],
                        "xmax": bbox[2], "ymax": bbox[3],
                        "spatialReference": {"wkid": out_sr},
                    }
                ),
                "geometryType": "esriGeometryEnvelope",
                "inSR": out_sr,
                "spatialRel": "esriSpatialRelIntersects",
            }
        )

    features: list[dict[str, Any]] = []
    with _session() as session:
        for page in range(max_pages):
            params["resultOffset"] = page * page_size
            response = session.get(query_url, params=params, timeout=TIMEOUT)
            response.raise_for_status()
            payload = response.json()
            if "error" in payload:
                raise AcquisitionError(f"{query_url}: {payload['error']}")
            batch = payload.get("features") or []
            features.extend(batch)
            if not payload.get("properties", {}).get("exceededTransferLimit") and (
                len(batch) < page_size
            ):
                break
        else:  # pragma: no cover - only on an implausibly large layer
            raise AcquisitionError(
                f"{query_url}: stopped after {max_pages} pages; narrow the bounding box"
            )

    return {"type": "FeatureCollection", "features": features}


def acquire_source(
    config: Config, source_name: str, data_dir: str | Path, overwrite: bool = False
) -> LayerStatus:
    """Fetch one `auto` source to disk. `manual` sources return instructions."""
    source = config.source(source_name)
    path = source_path(data_dir, source)

    if source.mode == "manual":
        return LayerStatus(
            name=source_name,
            path=path,
            present=path.exists(),
            optional=source.optional,
            mode=source.mode,
            detail="already present" if path.exists() else "not downloaded",
            instructions=(
                f"Download from {source.portal}\n"
                f"  Licence: {source.licence}\n"
                f"  Save as: {path}\n"
                f"  {source.notes}"
            ),
        )

    if path.exists() and not overwrite:
        return LayerStatus(
            name=source_name, path=path, present=True, optional=source.optional,
            mode=source.mode, detail="already present (use --overwrite to refetch)",
        )

    if source.kind != "arcgis_featureserver" or not source.url:
        raise AcquisitionError(
            f"source {source_name!r} is marked auto but has no supported "
            f"`kind`/`url` to fetch from"
        )

    import geopandas as gpd

    collection = fetch_featureserver(
        source.url, bbox=config.study_area_bbox, where=source.where
    )
    if not collection["features"]:
        raise AcquisitionError(
            f"{source_name}: the service returned no features for the study area. "
            f"Check the layer index in the URL and the `where` clause with "
            f"`preflight --probe`."
        )
    frame = gpd.GeoDataFrame.from_features(collection["features"], crs=config.crs)
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_file(path, driver="GPKG")
    return LayerStatus(
        name=source_name, path=path, present=True, optional=source.optional,
        mode=source.mode, detail=f"fetched {len(frame):,} features",
    )


def preflight(config: Config, data_dir: str | Path) -> list[LayerStatus]:
    """Report what is present, what is missing, and what to do about it."""
    statuses: list[LayerStatus] = []
    for name, source in config.sources.items():
        if not source.filename:
            continue
        path = source_path(data_dir, source)
        present = path.exists()
        detail = ""
        if present:
            detail = f"{path.stat().st_size / 1e6:.1f} MB"
            if path.suffix.lower() in {".tif", ".tiff"}:
                try:
                    from .raster import raster_native_resolution

                    x_res, y_res, crs = raster_native_resolution(path)
                    detail += f", native {x_res:g} x {y_res:g} m, {crs}"
                    if crs and "27700" not in str(crs):
                        detail += "  [will be reprojected]"
                except Exception as exc:  # pragma: no cover - malformed file
                    detail += f", UNREADABLE: {exc}"
        instructions = ""
        if not present:
            if source.mode == "manual":
                instructions = (
                    f"Download from {source.portal}\n"
                    f"    Licence: {source.licence}\n"
                    f"    Save as: {path}"
                )
            else:
                instructions = f"Run: python -m bogorchid acquire --source {name}"
        statuses.append(
            LayerStatus(
                name=name, path=path, present=present, optional=source.optional,
                mode=source.mode, detail=detail, instructions=instructions,
            )
        )
    return statuses


def format_preflight(statuses: Iterable[LayerStatus]) -> str:
    lines = ["Input layers", "=" * 60]
    missing_required: list[LayerStatus] = []
    for status in statuses:
        mark = "OK  " if status.present else ("opt " if status.optional else "MISS")
        lines.append(f"[{mark}] {status.name:18s} {status.path.name}")
        if status.detail:
            lines.append(f"         {status.detail}")
        if not status.present and status.instructions:
            for line in status.instructions.splitlines():
                lines.append(f"         {line}")
            if not status.optional:
                missing_required.append(status)
    lines.append("=" * 60)
    if missing_required:
        names = ", ".join(s.name for s in missing_required)
        lines.append(f"Cannot run yet - required layers missing: {names}")
    else:
        lines.append("All required layers present.")
    return "\n".join(lines)
