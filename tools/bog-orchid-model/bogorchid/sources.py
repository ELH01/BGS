"""Fetching and inspecting the input layers.

Two access modes, deliberately distinguished:

* ``auto``   - an open REST service this module can page through unattended.
* ``api``    - a service that needs a key, named by ``api_key_env`` and read
  from the environment. Same machinery as ``auto``, kept separate so that
  `preflight` can tell you which keys you still need.
* ``manual`` - a portal download behind a form or a licence click-through. The
  pipeline will not pretend it can fetch these; it tells you precisely which
  file to put where, and refuses to run without them rather than substituting a
  default and producing a confident-looking map built on nothing.

Live sources are cached under ``data/raw/`` after the first fetch, and only the
study area is ever requested - for the 1 m LIDAR that is the difference between
tens of megabytes and a national dataset.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from . import services
from .config import Config, Source


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


def _credentials(source: Source) -> services.Credentials:
    return services.Credentials.from_config(source.auth, source.api_key_env)


def probe_featureserver(url: str) -> dict[str, Any]:
    """Ask a FeatureServer or ImageServer layer to describe itself.

    Worth running before anything else: Natural England and BGS renumber their
    layer indices from time to time, and the habitat field has had several
    names. `preflight --probe` reports what the service says it is today.
    """
    with services._session() as session:
        info = services.request(session, url, {"f": "json"})
    return {
        "name": info.get("name"),
        "type": info.get("type"),
        "geometryType": info.get("geometryType"),
        "pixelSize": (info.get("pixelSizeX"), info.get("pixelSizeY")),
        "maxRecordCount": info.get("maxRecordCount"),
        "maxImageWidth": info.get("maxImageWidth"),
        "maxImageHeight": info.get("maxImageHeight"),
        "fields": [
            {"name": f.get("name"), "type": f.get("type"), "alias": f.get("alias")}
            for f in info.get("fields", [])
        ],
    }


def _write_vector(collection: dict[str, Any], path: Path, crs: str, name: str) -> int:
    import geopandas as gpd

    features = collection.get("features") or []
    if not features:
        raise AcquisitionError(
            f"{name}: the service returned no features for the study area. Check "
            f"the layer id in the URL and any `where`/`options` filter with "
            f"`preflight --probe`."
        )
    frame = gpd.GeoDataFrame.from_features(features)
    if frame.crs is None:
        frame = frame.set_crs(crs, allow_override=True)
    frame = frame.to_crs(crs)
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_file(path, driver="GPKG")
    return len(frame)


def acquire_source(
    config: Config, source_name: str, data_dir: str | Path, overwrite: bool = False
) -> LayerStatus:
    """Fetch one live source to the local cache.

    `manual` sources are not fetched: the pipeline returns instructions rather
    than guessing at a download URL behind a licence click-through.
    """
    source = config.source(source_name)
    path = source_path(data_dir, source)

    if not source.is_live:
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
            mode=source.mode, detail="cached (use --overwrite to refetch)",
        )

    bbox = config.study_area_bbox
    credentials = _credentials(source)
    options = dict(source.options or {})
    extra = options.pop("extra", None)
    detail = ""

    if source.kind == "arcgis_featureserver":
        collection = services.fetch_arcgis_featureserver(
            source.url, bbox=bbox, where=source.where,
            credentials=credentials, extra=extra, **options,
        )
        detail = f"fetched {_write_vector(collection, path, config.crs, source_name):,} features"

    elif source.kind == "ogc_api_features":
        collection = services.fetch_ogc_api_features(
            source.url, bbox=bbox, credentials=credentials, extra=extra, **options
        )
        detail = f"fetched {_write_vector(collection, path, config.crs, source_name):,} features"

    elif source.kind == "wfs":
        type_names = options.pop("type_names", None)
        if not type_names:
            raise AcquisitionError(
                f"{source_name}: a WFS source needs `options.type_names`"
            )
        collection = services.fetch_wfs(
            source.url, type_names=type_names, bbox=bbox,
            srs=config.crs, credentials=credentials, extra=extra, **options,
        )
        detail = f"fetched {_write_vector(collection, path, config.crs, source_name):,} features"

    elif source.kind == "arcgis_imageserver":
        services.fetch_arcgis_imageserver(
            source.url, bbox=bbox, resolution=config.resolution_m,
            destination=path, credentials=credentials, extra=extra, **options,
        )
        detail = f"streamed {path.stat().st_size / 1e6:.1f} MB for the study area"

    elif source.kind == "ogc_wcs":
        coverage_id = options.pop("coverage_id", None)
        if not coverage_id:
            raise AcquisitionError(
                f"{source_name}: a WCS source needs `options.coverage_id`"
            )
        services.fetch_wcs_coverage(
            source.url, coverage_id=coverage_id, bbox=bbox,
            resolution=config.resolution_m, destination=path, srs=config.crs,
            credentials=credentials, extra=extra, **options,
        )
        detail = f"streamed {path.stat().st_size / 1e6:.1f} MB for the study area"

    elif source.kind == "nbn_occurrences":
        scientific_name = options.pop("scientific_name", "Hammarbya paludosa")
        records = services.fetch_nbn_occurrences(
            source.url, scientific_name=scientific_name, bbox=bbox,
            credentials=credentials, extra=extra, **options,
        )
        frame = services.occurrences_to_frame(records)
        path.parent.mkdir(parents=True, exist_ok=True)
        if len(frame):
            frame.to_file(path, driver="GPKG")
        detail = f"fetched {len(frame):,} occurrence record(s)"

    else:  # pragma: no cover - guarded by config validation
        raise AcquisitionError(
            f"{source_name}: no client for kind {source.kind!r}"
        )

    return LayerStatus(
        name=source_name, path=path, present=path.exists(),
        optional=source.optional, mode=source.mode, detail=detail,
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
                if source.api_key_env:
                    import os as _os

                    have = bool(_os.environ.get(source.api_key_env))
                    instructions += (
                        f"\n    API key: ${source.api_key_env} "
                        f"{'is set' if have else 'is NOT set - export it first'}"
                    )
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
