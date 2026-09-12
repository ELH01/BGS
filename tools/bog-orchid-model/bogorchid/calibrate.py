"""Calibration and sanity checking against the known occurrence records.

This is the step that keeps an expert-weighted index honest. The two precise
Dartmoor records are far too few to fit a model to, but they are ample to
falsify one: if ground that is known to hold the species does not score well
above the moor-wide average, the weights are wrong and the map should not be
used. That check is run automatically and its failure is loud.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .config import Config, KnownSite
from .membership import build_curve
from .raster import ModelGrid, sample_at, sample_window
from .score import ScoringResult


@dataclass
class SiteDiagnostic:
    site: KnownSite
    inside_grid: bool
    passed_filters: bool
    raw_values: dict[str, float] = field(default_factory=dict)
    memberships: dict[str, float] = field(default_factory=dict)
    score: float = float("nan")
    percentile: float = float("nan")
    # For coarse records, the best cell within the square the reference denotes.
    window_best_score: float = float("nan")
    window_best_percentile: float = float("nan")
    window_pass_fraction: float = float("nan")


@dataclass
class CalibrationResult:
    diagnostics: list[SiteDiagnostic]
    elevation_band: tuple[float, float, float, float] | None
    elevation_note: str
    passed: bool
    warnings: list[str] = field(default_factory=list)


def percentile_of(value: float, sorted_values: np.ndarray) -> float:
    """Percentage of scored cells at or below ``value``."""
    if not np.isfinite(value) or sorted_values.size == 0:
        return float("nan")
    position = int(np.searchsorted(sorted_values, value, side="right"))
    return 100.0 * position / sorted_values.size


def derive_elevation_band(
    config: Config, elevation: np.ndarray, grid: ModelGrid
) -> tuple[tuple[float, float, float, float] | None, str]:
    """Derive the elevation preference empirically from the calibration sites.

    Deliberately generous. Two points do not describe a distribution, so the
    plateau is the observed range widened by `pad_m` and the shoulders extend a
    further `taper_m`; the result damps implausible extremes rather than
    asserting a narrow optimum.
    """
    settings = (config.calibration or {}).get("elevation") or {}
    if not settings.get("derive_from_sites", False):
        return None, "elevation band taken from config (derive_from_sites: false)"

    observed: list[float] = []
    used: list[str] = []
    for site in config.calibration_sites:
        radius = max(site.precision_m, grid.resolution)
        window = sample_window(elevation, grid, site.easting, site.northing, radius)
        if window.size:
            observed.extend([float(window.min()), float(window.max())])
            used.append(f"{site.name} {window.min():.0f}-{window.max():.0f} m")

    if not observed:
        return None, (
            "elevation band could NOT be derived: no calibration site falls on valid "
            "elevation data. Falling back to the band set in config.yaml."
        )

    pad = float(settings.get("pad_m", 50.0))
    taper = float(settings.get("taper_m", 150.0))
    hard_max = float(settings.get("hard_max_m", 560.0))

    low, high = min(observed), max(observed)
    b = max(0.0, low - pad)
    c = high + pad
    a = max(0.0, b - taper)
    d = c + taper

    # The documented British ceiling of c.500 m is a real constraint; above it
    # Dartmoor is plateau blanket bog rather than flush. But it is an assumption,
    # and a record is evidence: if the species is actually known from above the
    # ceiling, the ceiling is wrong, not the record. Trust the record and say so.
    caveat = ""
    if high > hard_max:
        caveat = (
            f". WARNING: a calibration site sits at {high:.0f} m, above the "
            f"configured hard_max of {hard_max:.0f} m. The cap has been ignored "
            f"rather than scoring a known population as unsuitable - but check "
            f"both the record and calibration.elevation.hard_max_m, because one "
            f"of them is wrong"
        )
    else:
        c = min(c, hard_max)
        d = min(d, hard_max)

    # Restore ordering without ever pushing the plateau back above the cap.
    b = min(b, c)
    a = min(a, b)
    d = max(d, c)

    note = (
        f"elevation band derived from {len(config.calibration_sites)} calibration "
        f"site(s) [{'; '.join(used)}]: trapezoid(a={a:.0f}, b={b:.0f}, c={c:.0f}, "
        f"d={d:.0f}) m, using pad={pad:.0f} m, taper={taper:.0f} m, "
        f"hard_max={hard_max:.0f} m{caveat}"
    )
    return (a, b, c, d), note


def apply_elevation_band(config: Config, band: tuple[float, float, float, float]) -> None:
    """Replace the elevation variable's curve with the empirically derived one."""
    a, b, c, d = band
    spec = {"type": "trapezoid", "a": a, "b": b, "c": c, "d": d}
    variable = config.variable("elevation")
    variable.curve = build_curve(spec)
    variable.curve_spec = spec


def diagnose_sites(
    config: Config,
    grid: ModelGrid,
    layers: dict[str, np.ndarray],
    result: ScoringResult,
) -> CalibrationResult:
    """Extract every variable at the known sites and rank them against the map."""
    valid = result.score[np.isfinite(result.score)]
    sorted_scores = np.sort(valid)

    diagnostics: list[SiteDiagnostic] = []
    for site in config.known_sites:
        inside = grid.contains(site.easting, site.northing)
        diagnostic = SiteDiagnostic(
            site=site,
            inside_grid=inside,
            passed_filters=False,
        )
        if inside:
            diagnostic.passed_filters = bool(
                sample_at(result.filter_mask.astype("float64"), grid, site.easting, site.northing)
            )
            for name, array in sorted(layers.items()):
                diagnostic.raw_values[name] = sample_at(array, grid, site.easting, site.northing)
            for name, array in sorted(result.memberships.items()):
                diagnostic.memberships[name] = sample_at(array, grid, site.easting, site.northing)
            diagnostic.score = sample_at(result.score, grid, site.easting, site.northing)
            diagnostic.percentile = percentile_of(diagnostic.score, sorted_scores)

            radius = max(site.precision_m, grid.resolution)
            window = sample_window(result.score, grid, site.easting, site.northing, radius)
            if window.size:
                diagnostic.window_best_score = float(window.max())
                diagnostic.window_best_percentile = percentile_of(
                    diagnostic.window_best_score, sorted_scores
                )
            mask_window = sample_window(
                result.filter_mask.astype("float64"), grid, site.easting, site.northing, radius
            )
            if mask_window.size:
                diagnostic.window_pass_fraction = float(mask_window.mean())
        diagnostics.append(diagnostic)

    warnings: list[str] = []
    threshold = float((config.calibration or {}).get("min_expected_percentile", 90.0))
    calibration_diagnostics = [d for d in diagnostics if d.site.use_for_calibration]

    for diagnostic in calibration_diagnostics:
        name = diagnostic.site.name
        if not diagnostic.inside_grid:
            warnings.append(f"{name}: falls outside the model grid - cannot calibrate.")
            continue
        if not diagnostic.passed_filters:
            best = diagnostic.window_best_score
            warnings.append(
                f"{name}: the recorded cell FAILED the hard filters "
                f"(so it scores no-data). This is the most important thing in this "
                f"report: a known population on ground the model excludes means a "
                f"filter is wrong - most likely the Priority Habitat extent or the "
                f"peat depth threshold. "
                + (
                    f"The best cell within {max(diagnostic.site.precision_m, 10):.0f} m "
                    f"scores {best:.3f}."
                    if np.isfinite(best)
                    else "No cell nearby scores at all."
                )
            )
            continue
        reference = (
            diagnostic.percentile
            if np.isfinite(diagnostic.percentile)
            else diagnostic.window_best_percentile
        )
        if not np.isfinite(reference):
            warnings.append(f"{name}: could not be scored.")
        elif reference < threshold:
            warnings.append(
                f"{name}: scores {diagnostic.score:.3f}, only the "
                f"{reference:.1f}th percentile of scored ground (expected >= "
                f"{threshold:.0f}th). The weights do not reproduce a site the species "
                f"is actually known from - revisit them before trusting the output."
            )

    passed = not warnings and bool(calibration_diagnostics)
    return CalibrationResult(
        diagnostics=diagnostics,
        elevation_band=None,
        elevation_note="",
        passed=passed,
        warnings=warnings,
    )


def format_report(
    config: Config,
    result: ScoringResult,
    calibration: CalibrationResult,
    grid: ModelGrid,
    header_note: str = "",
) -> str:
    """Markdown calibration report - the thing to read before trusting a map."""
    lines: list[str] = ["# Bog orchid suitability - calibration report", ""]
    if header_note:
        lines += [header_note, ""]

    lines += [
        "## Study area",
        "",
        f"- Grid: {grid.width} x {grid.height} cells at {grid.resolution:.0f} m "
        f"({grid.crs})",
        f"- Bounds: {', '.join(f'{v:,.0f}' for v in grid.bounds)}",
        "",
        "## Hard filters",
        "",
    ]
    for name, stats in result.filter_stats.items():
        lines.append(
            f"- **{name}**: {stats['cells_passed']:,.0f} cells "
            f"({stats['percent_of_area']:.2f}% of the grid)"
        )
    lines += ["", "## Weights used", ""]
    for name, weight in sorted(result.weights.items(), key=lambda kv: -kv[1]):
        variable = config.variable(name)
        lines.append(f"- **{name}** `{weight:.3f}` - {variable.describe()}")
    for name, reason in result.dropped.items():
        lines.append(f"- ~~{name}~~ DROPPED: {reason}")
    lines += ["", f"Combination: `{result.method}`, gamma {result.gamma}.", ""]

    if calibration.elevation_note:
        lines += ["## Elevation band", "", calibration.elevation_note, ""]

    lines += ["## Known sites", ""]
    for diagnostic in calibration.diagnostics:
        site = diagnostic.site
        role = "CALIBRATION" if site.use_for_calibration else "reference only"
        lines += [f"### {site.name}", "", f"- Grid ref: `{site.grid_ref}` ({role})"]
        if site.precision_m > grid.resolution:
            lines.append(
                f"- Reference precision: {site.precision_m:,.0f} m - too coarse to "
                f"read a single cell; window statistics are used instead"
            )
        if site.source:
            lines.append(f"- Source: {site.source}")
        if not diagnostic.inside_grid:
            lines += ["- **Outside the model grid.**", ""]
            continue
        lines.append(f"- Passed hard filters: **{'yes' if diagnostic.passed_filters else 'NO'}**")
        if np.isfinite(diagnostic.window_pass_fraction):
            lines.append(
                f"- Fraction of the reference square passing the filters: "
                f"{100 * diagnostic.window_pass_fraction:.1f}%"
            )
        if np.isfinite(diagnostic.score):
            lines.append(
                f"- Score at the recorded cell: **{diagnostic.score:.3f}** "
                f"({diagnostic.percentile:.1f}th percentile of scored ground)"
            )
        if np.isfinite(diagnostic.window_best_score):
            lines.append(
                f"- Best score within the reference square: "
                f"{diagnostic.window_best_score:.3f} "
                f"({diagnostic.window_best_percentile:.1f}th percentile)"
            )
        if diagnostic.raw_values:
            lines += [
                "",
                "Environmental values at the record:",
                "",
                "| layer | value |",
                "|---|---|",
            ]
            for name, raw in sorted(diagnostic.raw_values.items()):
                lines.append(
                    f"| {name} | {'-' if not np.isfinite(raw) else f'{raw:,.3f}'} |"
                )
        if diagnostic.memberships:
            lines += [
                "",
                "Variable scores at the record (weight x membership = contribution):",
                "",
                "| variable | weight | membership | contribution |",
                "|---|---|---|---|",
            ]
            for name, member in sorted(diagnostic.memberships.items()):
                weight = result.weights.get(name)
                if weight is None or member is None or not np.isfinite(member):
                    lines.append(f"| {name} | - | - | - |")
                else:
                    lines.append(
                        f"| {name} | {weight:.3f} | {member:.3f} | "
                        f"{weight * member:.3f} |"
                    )
        lines.append("")

    lines += ["## Verdict", ""]
    if calibration.passed:
        lines.append(
            "**PASS** - every calibration site sits above the configured percentile "
            "threshold. The weighting reproduces the ground the species is known "
            "from, which is the most that two records can tell you. It is not "
            "evidence that the model is right about anywhere else."
        )
    else:
        lines.append("**CHECK REQUIRED** - the calibration step raised the following:")
        lines.append("")
        for warning in calibration.warnings:
            lines.append(f"- {warning}")
    lines.append("")
    return "\n".join(lines)
