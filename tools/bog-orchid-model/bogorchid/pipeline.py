"""End-to-end orchestration: layers in, suitability map and shortlist out."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from . import terrain
from .calibrate import (
    apply_elevation_band,
    derive_elevation_band,
    diagnose_sites,
    format_report,
)
from .candidates import select_candidates
from .config import Config
from .raster import (
    ModelGrid,
    buffer_mask,
    distance_to_geometries,
    grid_from_bounds,
    rasterize_vector,
    read_raster_to_grid,
    write_raster,
)
from .render import render_map
from .score import ScoringResult, score_area
from .sources import source_path

# Field names these datasets have shipped under. Checked in order; the one
# actually used is recorded in the run manifest.
PHI_HABITAT_FIELDS = (
    "Main_Habit", "mainhabs", "MAIN_HABIT", "Main_Habitat", "MainHabs",
    "habitat", "HABITAT", "Primary_Ha",
)
GEOLOGY_LITHOLOGY_FIELDS = (
    "RCS_D", "LEX_RCS", "RCS_ORIGIN", "LEX_D", "lithology", "LITHOLOGY", "DESCRIPTIO",
)
NVC_FIELDS = ("NVC", "nvc", "COMMUNITY", "community", "NVC_CODE", "nvc_code")


class PipelineError(RuntimeError):
    """Raised when the run cannot proceed."""


@dataclass
class RunResult:
    grid: ModelGrid
    layers: dict[str, np.ndarray]
    scoring: ScoringResult
    calibration: Any
    candidates: Any
    notes: list[str] = field(default_factory=list)
    provenance: dict[str, Any] = field(default_factory=dict)
    outputs: dict[str, Path] = field(default_factory=dict)


def _first_field(columns, wanted) -> str | None:
    lowered = {str(c).lower(): str(c) for c in columns}
    for candidate in wanted:
        if candidate.lower() in lowered:
            return lowered[candidate.lower()]
    return None


def resolve_grid(config: Config, data_dir: str | Path, notes: list[str]):
    """Model grid and clipping boundary.

    Prefers the real Dartmoor boundary; falls back to the configured bounding
    box, saying so, because a bounding-box run covers ground outside the
    National Park and the candidate list would need reading with that in mind.
    """
    boundary = None
    path = source_path(data_dir, config.source("boundary"))
    if path.exists():
        import geopandas as gpd

        boundary = gpd.read_file(path).to_crs(config.crs)
        if boundary.empty:
            notes.append(f"Boundary file {path} is empty; falling back to the bbox.")
            boundary = None
    if boundary is None:
        notes.append(
            "No Dartmoor boundary polygon available - using project.study_area_bbox. "
            "The study area therefore includes ground outside the National Park."
        )
        bounds = config.study_area_bbox
    else:
        bounds = tuple(boundary.total_bounds)
    return grid_from_bounds(bounds, config.resolution_m, config.crs), boundary


def load_layers(
    config: Config,
    grid: ModelGrid,
    data_dir: str | Path,
    boundary=None,
    notes: list[str] | None = None,
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    """Read every available input onto the model grid and derive what is needed."""
    notes = notes if notes is not None else []
    provenance: dict[str, Any] = {}
    layers: dict[str, np.ndarray] = {}
    import geopandas as gpd

    # -- terrain ---------------------------------------------------------
    dtm_path = source_path(data_dir, config.source("dtm"))
    if not dtm_path.exists():
        raise PipelineError(
            f"the DTM is required and is missing: {dtm_path}\n"
            "Run `python -m bogorchid preflight` for download instructions."
        )
    elevation = read_raster_to_grid(dtm_path, grid, resampling="bilinear")
    if not np.isfinite(elevation).any():
        raise PipelineError(
            f"{dtm_path} produced no valid elevations on the study grid. The usual "
            f"cause is a CRS mismatch or a DTM that does not cover the area."
        )
    provenance["dtm"] = str(dtm_path)
    notes.append(
        f"DTM: {np.isfinite(elevation).sum():,} valid cells, "
        f"{np.nanmin(elevation):.0f}-{np.nanmax(elevation):.0f} m."
    )
    derived = terrain.derive_all(elevation, grid.resolution)
    layers.update(derived)

    # -- priority habitat (hard filter) ----------------------------------
    phi_path = source_path(data_dir, config.source("priority_habitat"))
    phi_settings = config.hard_filters.get("priority_habitat") or {}
    if phi_path.exists():
        phi = gpd.read_file(phi_path).to_crs(config.crs)
        field_name = _first_field(phi.columns, PHI_HABITAT_FIELDS)
        wanted = [str(h).lower() for h in phi_settings.get("include", [])]
        if field_name is None:
            notes.append(
                f"WARNING: no recognised habitat field in {phi_path.name} "
                f"(looked for {', '.join(PHI_HABITAT_FIELDS)}). Using EVERY polygon "
                f"in the file, which is only correct if you pre-filtered it."
            )
            selected = phi
        elif not wanted:
            selected = phi
        else:
            values = phi[field_name].astype(str).str.lower()
            keep = np.zeros(len(phi), dtype=bool)
            for habitat in wanted:
                keep |= values.str.contains(habitat, regex=False, na=False).to_numpy()
            selected = phi[keep]
            notes.append(
                f"Priority Habitat: kept {len(selected):,} of {len(phi):,} polygons "
                f"matching {phi_settings.get('include')} on field '{field_name}'."
            )
        if selected.empty:
            raise PipelineError(
                f"no Priority Habitat polygon matched {phi_settings.get('include')}. "
                f"Check the habitat names against the values actually in "
                f"{phi_path.name}."
            )
        mask = rasterize_vector(selected.geometry.values, grid) > 0
        buffer_m = float(phi_settings.get("buffer_m", 0.0))
        if buffer_m > 0:
            mask = buffer_mask(mask, grid, buffer_m)
            notes.append(f"Priority Habitat extent buffered outwards by {buffer_m:.0f} m.")
        layers["priority_habitat"] = mask.astype("float64")
        provenance["priority_habitat"] = {
            "path": str(phi_path), "field": field_name,
            "polygons_selected": int(len(selected)),
        }
    elif phi_settings.get("enabled", False):
        raise PipelineError(
            f"the Priority Habitats Inventory is required by hard_filters and is "
            f"missing: {phi_path}"
        )

    # Clip to the National Park boundary, if we have one.
    if boundary is not None and "priority_habitat" in layers:
        inside = rasterize_vector(boundary.geometry.values, grid) > 0
        layers["priority_habitat"] = np.where(inside, layers["priority_habitat"], 0.0)

    # -- peat depth (hard filter) ----------------------------------------
    peat_path = source_path(data_dir, config.source("peat"))
    if peat_path.exists():
        scale = float((config.layers or {}).get("peat_depth_scale_to_cm", 1.0))
        depth = read_raster_to_grid(peat_path, grid, resampling="bilinear") * scale
        layers["peat_depth"] = depth
        provenance["peat_depth"] = {"path": str(peat_path), "scale_to_cm": scale}
        notes.append(
            f"Peat depth: {np.isfinite(depth).sum():,} valid cells, "
            f"{np.nanmin(depth):.1f}-{np.nanmax(depth):.1f} cm (after scaling)."
        )
    elif (config.hard_filters.get("peat_present") or {}).get("enabled", False):
        raise PipelineError(f"peat depth is required by hard_filters and is missing: {peat_path}")

    # -- Sphagnum flag ---------------------------------------------------
    vegetation_path = source_path(data_dir, config.source("peat_vegetation"))
    sphagnum_classes = list((config.layers or {}).get("sphagnum_classes") or [])
    if vegetation_path.exists():
        if not sphagnum_classes:
            notes.append(
                f"WARNING: {vegetation_path.name} is present but "
                f"`layers.sphagnum_classes` is empty, so no class can be read as "
                f"Sphagnum-dominated. The sphagnum variable (the model's joint-"
                f"heaviest) is DROPPED and its weight redistributed. Run "
                f"`preflight --classes` to list the class codes in the raster and "
                f"set them in config.yaml - this is worth doing before any real run."
            )
        else:
            vegetation = read_raster_to_grid(vegetation_path, grid, resampling="nearest")
            flag = np.isin(vegetation, [float(c) for c in sphagnum_classes])
            flag_layer = np.where(np.isfinite(vegetation), flag.astype("float64"), np.nan)
            layers["sphagnum_flag"] = flag_layer
            provenance["sphagnum_flag"] = {
                "path": str(vegetation_path), "classes": sphagnum_classes,
            }
            notes.append(
                f"Sphagnum-dominated: {int(np.nansum(flag_layer)):,} cells from classes "
                f"{sphagnum_classes}."
            )

    # -- watercourses ----------------------------------------------------
    rivers_path = source_path(data_dir, config.source("rivers"))
    if rivers_path.exists():
        rivers = gpd.read_file(rivers_path).to_crs(config.crs)
        if rivers.empty:
            notes.append(f"WARNING: {rivers_path.name} contains no features.")
        else:
            layers["distance_to_water_m"] = distance_to_geometries(
                rivers.geometry.values, grid
            )
            provenance["rivers"] = {"path": str(rivers_path), "features": int(len(rivers))}

    # -- geology ---------------------------------------------------------
    geology_path = source_path(data_dir, config.source("geology"))
    if geology_path.exists():
        geology = gpd.read_file(geology_path).to_crs(config.crs)
        field_name = _first_field(geology.columns, GEOLOGY_LITHOLOGY_FIELDS)
        if field_name is None:
            notes.append(
                f"WARNING: no recognised lithology field in {geology_path.name}; "
                f"the geology variable is dropped."
            )
        else:
            classes = (config.layers or {}).get("base_richness") or {}
            codes = {"acidic": 1.0, "intermediate": 2.0, "base_rich": 3.0}
            values = geology[field_name].astype(str).str.lower()
            assigned = np.zeros(len(geology), dtype="float64")  # 0 = unknown
            # Ordered so that base-rich wins where a description matches more
            # than one keyword set - it is the ecologically notable case.
            for key in ("acidic", "intermediate", "base_rich"):
                for keyword in classes.get(key, []) or []:
                    hit = values.str.contains(str(keyword).lower(), regex=False, na=False)
                    assigned[hit.to_numpy()] = codes[key]
            layers["base_richness"] = rasterize_vector(
                geology.geometry.values, grid, values=assigned, fill=0.0
            )
            provenance["geology"] = {
                "path": str(geology_path), "field": field_name,
                "class_counts": {
                    name: int((assigned == code).sum()) for name, code in codes.items()
                },
            }

    # -- NVC (optional) --------------------------------------------------
    nvc_variable = next((v for v in config.variables if v.name == "nvc"), None)
    nvc_path = source_path(data_dir, config.source("nvc"))
    if nvc_variable is not None and nvc_variable.enabled and nvc_path.exists():
        nvc = gpd.read_file(nvc_path).to_crs(config.crs)
        field_name = _first_field(nvc.columns, NVC_FIELDS)
        if field_name is None:
            notes.append(f"WARNING: no recognised NVC field in {nvc_path.name}; dropped.")
        else:
            values = nvc[field_name].astype(str).str.upper().str.strip()
            keep = values.str.match(r"^M(1|21)\b") | values.str.match(r"^M(1|21)$")
            selected = nvc[keep.to_numpy()]
            layers["nvc_m1_m21"] = rasterize_vector(selected.geometry.values, grid)
            provenance["nvc"] = {
                "path": str(nvc_path), "field": field_name,
                "m1_m21_polygons": int(len(selected)),
            }
            notes.append(f"NVC: {len(selected):,} M1/M21 polygons.")

    return layers, provenance


def run(
    config: Config,
    data_dir: str | Path,
    out_dir: str | Path,
    banner: str = "",
    title: str | None = None,
    header_note: str = "",
) -> RunResult:
    """Run the whole model and write every output."""
    notes: list[str] = []
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    for warning in config.site_warnings:
        notes.append(f"WARNING: {warning}")
    grid, boundary = resolve_grid(config, data_dir, notes)
    layers, provenance = load_layers(config, grid, data_dir, boundary, notes)

    # Elevation band is derived from the known sites BEFORE scoring, as the
    # brief requires - the known points calibrate the model, they do not train it.
    band, elevation_note = derive_elevation_band(config, layers["elevation_m"], grid)
    if band is not None:
        apply_elevation_band(config, band)

    scoring = score_area(config, layers)
    calibration = diagnose_sites(config, grid, layers, scoring)
    calibration.elevation_band = band
    calibration.elevation_note = elevation_note

    table, candidate_notes = select_candidates(config, grid, scoring, layers)
    notes.extend(candidate_notes)

    outputs: dict[str, Path] = {}
    outputs["raster"] = write_raster(
        out_dir / "suitability.tif", scoring.score, grid,
        description="Hammarbya paludosa habitat suitability index (0-1)",
    )
    outputs["report"] = out_dir / "calibration_report.md"
    outputs["report"].write_text(
        format_report(config, scoring, calibration, grid, header_note=header_note),
        encoding="utf-8",
    )
    outputs["candidates"] = out_dir / "candidates.csv"
    if len(table):
        table.to_csv(outputs["candidates"], index=False)
    else:
        outputs["candidates"].write_text(
            "# No candidate met the configured criteria.\n", encoding="utf-8"
        )
    outputs["map"] = render_map(
        out_dir / "suitability_map.png", config, grid, scoring, layers,
        candidates=table if len(table) else None,
        title=title or "Bog orchid (Hammarbya paludosa) habitat suitability - Dartmoor",
        banner=banner,
    )

    manifest = {
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "config_file": str(config.path),
        "crs": config.crs,
        "resolution_m": config.resolution_m,
        "grid": {"width": grid.width, "height": grid.height, "bounds": list(grid.bounds)},
        "weights_used": scoring.weights,
        "variables_dropped": scoring.dropped,
        "scoring_method": scoring.method,
        "elevation_band": list(band) if band else None,
        "filter_stats": scoring.filter_stats,
        "calibration_passed": calibration.passed,
        "calibration_warnings": calibration.warnings,
        "candidates": int(len(table)),
        "provenance": provenance,
        "notes": notes,
        "config_snapshot": config.raw,
    }
    outputs["manifest"] = out_dir / "run_manifest.json"
    outputs["manifest"].write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")

    return RunResult(
        grid=grid, layers=layers, scoring=scoring, calibration=calibration,
        candidates=table, notes=notes, provenance=provenance, outputs=outputs,
    )
