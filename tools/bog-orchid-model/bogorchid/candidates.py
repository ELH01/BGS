"""Turning the suitability surface into a ranked field-survey shortlist.

Two things make this more than `argsort`. Ground near a known record is excluded
so the list surfaces new places rather than restating what is already known; and
accepted candidates suppress their neighbours, so the table is N distinct sites
rather than N adjacent pixels of the same flush.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .calibrate import percentile_of
from .config import Config, KnownSite
from .osgb import easting_northing_to_gridref
from .raster import ModelGrid, buffer_mask
from .score import ScoringResult

# Cells considered before greedy selection gives up. Generous enough that the
# shortlist is never truncated in practice, bounded so the loop cannot run away.
_MAX_CONSIDERED = 500_000


def patch_context(
    score: np.ndarray, grid: ModelGrid, radius_m: float
) -> np.ndarray:
    """Mean suitability within ``radius_m`` of each cell, ignoring no-data.

    Used only to break ties in the ranking, never to alter the suitability
    surface itself. Trapezoid plateaus mean large numbers of cells legitimately
    score identically - on the synthetic test run, 229 cells shared the top
    score exactly - so without a tie-break the "top 50" would be whichever tied
    cells happen to come first in raster order, which is no basis for sending
    somebody onto the moor.

    A neighbourhood mean is the tie-break because it is ecologically meaningful:
    among equally suitable cells, one embedded in a wider block of suitable
    ground is the better survey target. It is a bigger, more coherent flush
    system, more likely to hold a population, and far easier to find and work
    on the ground than an isolated pixel.
    """
    from scipy import ndimage

    valid = np.isfinite(score)
    filled = np.where(valid, score, 0.0)
    cells = max(1, int(round(radius_m / grid.resolution)))
    offsets = np.arange(-cells, cells + 1)
    yy, xx = np.meshgrid(offsets, offsets, indexing="ij")
    kernel = ((yy**2 + xx**2) <= cells**2).astype("float64")

    total = ndimage.convolve(filled, kernel, mode="constant", cval=0.0)
    count = ndimage.convolve(valid.astype("float64"), kernel, mode="constant", cval=0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(count > 0, total / count, np.nan)
    return np.where(valid, mean, np.nan)


def _exclusion_mask(
    config: Config, grid: ModelGrid, shape: tuple[int, int]
) -> tuple[np.ndarray, list[str]]:
    """Ground too close to a known record to count as a new discovery."""
    settings = config.candidates or {}
    buffer_m = float(settings.get("exclusion_buffer_m", 500.0))
    precision_cap = float(settings.get("max_record_precision_for_exclusion_m", 1000.0))

    seeds = np.zeros(shape, dtype=bool)
    notes: list[str] = []
    any_excluded = False
    for site in config.known_sites:
        if site.precision_m > precision_cap:
            notes.append(
                f"{site.name}: NOT excluded - its reference is only precise to "
                f"{site.precision_m:,.0f} m, and excluding a square that size would "
                f"discard far more ground than the record justifies. Candidates "
                f"falling inside it are flagged in the `within_coarse_record` column "
                f"instead, because one of them may simply be this site."
            )
            continue
        if not grid.contains(site.easting, site.northing):
            continue
        row, col = grid.rowcol(site.easting, site.northing)
        if 0 <= row < shape[0] and 0 <= col < shape[1]:
            seeds[row, col] = True
            any_excluded = True

    if not any_excluded:
        return np.zeros(shape, dtype=bool), notes
    excluded = buffer_mask(seeds, grid, buffer_m)
    notes.append(
        f"Excluded a {buffer_m:,.0f} m radius around "
        f"{int(seeds.sum())} precisely-located known record(s)."
    )
    return excluded, notes


def _coarse_record_at(
    config: Config, easting: float, northing: float
) -> str:
    """Name any low-precision record whose square contains this point."""
    hits = []
    for site in config.known_sites:
        if site.precision_m <= 100.0:
            continue
        half = site.precision_m / 2.0
        if (
            abs(easting - site.easting) <= half
            and abs(northing - site.northing) <= half
        ):
            hits.append(site.name)
    return "; ".join(hits)


def _nearest_known(
    sites: list[KnownSite], easting: float, northing: float
) -> tuple[float, str]:
    if not sites:
        return float("nan"), ""
    distances = [
        (np.hypot(easting - s.easting, northing - s.northing), s) for s in sites
    ]
    distance, site = min(distances, key=lambda pair: pair[0])
    return float(distance), site.name


def select_candidates(
    config: Config,
    grid: ModelGrid,
    result: ScoringResult,
    layers: dict[str, np.ndarray],
) -> tuple[pd.DataFrame, list[str]]:
    """Build the ranked candidate table."""
    settings = config.candidates or {}
    count = int(settings.get("count", 50))
    min_score = float(settings.get("min_score", 0.0))
    separation = float(settings.get("min_separation_m", 250.0))

    score = result.score
    excluded, notes = _exclusion_mask(config, grid, score.shape)

    eligible = np.isfinite(score) & (score >= min_score) & ~excluded
    if not eligible.any():
        notes.append(
            f"No cell scores at or above candidates.min_score ({min_score}) outside "
            f"the exclusion buffers - the shortlist is empty. Lower min_score, or "
            f"revisit the weights."
        )
        return pd.DataFrame(), notes

    tie_break = str(settings.get("tie_break", "patch_mean"))
    patch_radius = float(settings.get("patch_radius_m", 100.0))
    patch = (
        patch_context(score, grid, patch_radius)
        if tie_break == "patch_mean"
        else np.zeros_like(score)
    )

    rows, cols = np.nonzero(eligible)
    values = score[rows, cols]
    patch_values = np.nan_to_num(patch[rows, cols], nan=0.0)

    # Primary key is the suitability score exactly as computed; patch context is
    # only ever the secondary key. Rounding the primary key first was tried and
    # rejected: it merged genuinely different scores, so the table could show a
    # rank-1 cell scoring below rank 2, which is indefensible however well the
    # tie-break is documented. np.lexsort applies the LAST key first.
    order = np.lexsort((-patch_values, -values))[:_MAX_CONSIDERED]
    rows, cols, values = rows[order], cols[order], values[order]
    patch_values = patch_values[order]
    eastings, northings = grid.xy(rows, cols)

    tied = int((values == values.max()).sum())
    if tied > 1:
        notes.append(
            f"{tied:,} cells share the top score ({values.max():.4f}) exactly - the "
            f"trapezoid plateaus mean many cells are equally suitable by the "
            f"model's own logic. Ranking among them is broken by "
            + (
                f"mean suitability within {patch_radius:,.0f} m (see the "
                f"`patch_score` column), not by raster order."
                if tie_break == "patch_mean"
                else "raster order - set candidates.tie_break: patch_mean to improve this."
            )
        )

    sorted_scores = np.sort(score[np.isfinite(score)])

    accepted_e: list[float] = []
    accepted_n: list[float] = []
    accepted_index: list[int] = []
    for i in range(len(values)):
        if len(accepted_index) >= count:
            break
        if accepted_e:
            distance = np.hypot(
                np.asarray(accepted_e) - eastings[i], np.asarray(accepted_n) - northings[i]
            )
            if distance.min() < separation:
                continue
        accepted_e.append(float(eastings[i]))
        accepted_n.append(float(northings[i]))
        accepted_index.append(i)

    if len(accepted_index) < count:
        notes.append(
            f"Only {len(accepted_index)} candidates met the criteria "
            f"(requested {count}) at a minimum separation of {separation:,.0f} m."
        )

    precise_sites = [s for s in config.known_sites if s.precision_m <= 100.0]
    records: list[dict[str, object]] = []
    for rank, i in enumerate(accepted_index, start=1):
        row, col = int(rows[i]), int(cols[i])
        easting, northing = float(eastings[i]), float(northings[i])
        distance, nearest_name = _nearest_known(precise_sites, easting, northing)
        record: dict[str, object] = {
            "rank": rank,
            "grid_ref": easting_northing_to_gridref(easting, northing, digits=10),
            "grid_ref_6fig": easting_northing_to_gridref(easting, northing, digits=6),
            "easting": round(easting, 1),
            "northing": round(northing, 1),
            "suitability_score": round(float(values[i]), 4),
            "score_percentile": round(percentile_of(float(values[i]), sorted_scores), 2),
            "distance_to_nearest_known_site_m": (
                round(distance, 1) if np.isfinite(distance) else ""
            ),
            "nearest_known_site": nearest_name,
            "within_coarse_record": _coarse_record_at(config, easting, northing),
            "patch_score": round(float(patch_values[i]), 4),
        }
        # Raw environmental values, so the table can be triaged without the GIS.
        for name in (
            "elevation_m",
            "slope_deg",
            "twi",
            "flow_accumulation",
            "peat_depth",
            "distance_to_water_m",
            "sphagnum_flag",
            "base_richness",
        ):
            array = layers.get(name)
            if array is not None:
                value = float(array[row, col])
                record[name] = round(value, 3) if np.isfinite(value) else ""
        # Per-variable membership, so a reader can see WHY a cell ranks where it does.
        for name, surface in sorted(result.memberships.items()):
            value = float(surface[row, col])
            record[f"m_{name}"] = round(value, 4) if np.isfinite(value) else ""
        records.append(record)

    return pd.DataFrame.from_records(records), notes
