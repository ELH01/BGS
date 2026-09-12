"""Loading and validation of ``config.yaml``.

Validation is strict and noisy on purpose. A habitat model that silently runs
with a mistyped weight or a curve that never fires produces a map that looks
entirely plausible and is wrong, which is the worst outcome available.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

import yaml

from .membership import Curve, build_curve, describe_curve
from .osgb import gridref_precision_m, gridref_to_easting_northing


class ConfigError(ValueError):
    """Raised when the configuration is unusable."""


@dataclass(frozen=True)
class KnownSite:
    name: str
    grid_ref: str
    easting: float
    northing: float
    precision_m: float
    use_for_calibration: bool
    last_seen: int | None = None
    source: str = ""
    notes: str = ""

    @property
    def label(self) -> str:
        seen = f", last seen {self.last_seen}" if self.last_seen else ""
        return f"{self.name} ({self.grid_ref}{seen})"


@dataclass
class Component:
    """One multiplied part of a composite variable such as `lateral_flow`."""

    name: str
    layer: str
    curve: Curve
    curve_spec: Mapping[str, Any]
    notes: str = ""


@dataclass
class Variable:
    name: str
    weight: float
    enabled: bool
    notes: str
    layer: str | None = None
    curve: Curve | None = None
    curve_spec: Mapping[str, Any] | None = None
    combine: str | None = None
    components: list[Component] = field(default_factory=list)

    @property
    def is_composite(self) -> bool:
        return bool(self.components)

    @property
    def required_layers(self) -> list[str]:
        if self.is_composite:
            return [c.layer for c in self.components]
        return [self.layer] if self.layer else []

    def describe(self) -> str:
        if self.is_composite:
            parts = " x ".join(
                f"{c.layer}:{describe_curve(c.curve_spec)}" for c in self.components
            )
            return f"{self.combine or 'product'}({parts})"
        return f"{self.layer}:{describe_curve(self.curve_spec or {})}"


@dataclass(frozen=True)
class Source:
    name: str
    mode: str
    filename: str | None
    kind: str | None = None
    url: str | None = None
    where: str | None = None
    portal: str | None = None
    licence: str = ""
    optional: bool = False
    notes: str = ""


VALID_SCORING_METHODS = {"weighted_mean", "weighted_geometric"}


@dataclass
class Config:
    path: Path
    raw: dict[str, Any]
    crs: str
    resolution_m: float
    study_area_bbox: tuple[float, float, float, float]
    known_sites: list[KnownSite]
    variables: list[Variable]
    sources: dict[str, Source]
    hard_filters: dict[str, Any]
    scoring: dict[str, Any]
    calibration: dict[str, Any]
    candidates: dict[str, Any]
    layers: dict[str, Any]
    site_warnings: list[str] = field(default_factory=list)

    # -- convenience ------------------------------------------------------
    @property
    def calibration_sites(self) -> list[KnownSite]:
        return [s for s in self.known_sites if s.use_for_calibration]

    @property
    def enabled_variables(self) -> list[Variable]:
        return [v for v in self.variables if v.enabled and v.weight > 0]

    def variable(self, name: str) -> Variable:
        for v in self.variables:
            if v.name == name:
                return v
        raise KeyError(name)

    def source(self, name: str) -> Source:
        try:
            return self.sources[name]
        except KeyError as exc:
            raise ConfigError(f"no source named {name!r} in config") from exc


def _require(mapping: Mapping[str, Any], key: str, where: str) -> Any:
    if key not in mapping:
        raise ConfigError(f"{where}: missing required key {key!r}")
    return mapping[key]


def _parse_site(entry: Mapping[str, Any], index: int) -> KnownSite:
    where = f"known_sites[{index}]"
    name = str(_require(entry, "name", where))
    grid_ref = str(_require(entry, "grid_ref", where))
    implied = gridref_precision_m(grid_ref)
    precision = float(entry.get("precision_m") or implied)
    # A coarse reference cannot be made precise by declaring it so.
    if precision < implied:
        precision = implied
    easting, northing = gridref_to_easting_northing(grid_ref, centre=implied > 1.0)
    last_seen = entry.get("last_seen")
    return KnownSite(
        name=name,
        grid_ref=grid_ref,
        easting=easting,
        northing=northing,
        precision_m=precision,
        use_for_calibration=bool(entry.get("use_for_calibration", False)),
        last_seen=int(last_seen) if last_seen else None,
        source=str(entry.get("source", "")).strip(),
        notes=str(entry.get("notes", "")).strip(),
    )


def _parse_variable(name: str, entry: Mapping[str, Any]) -> Variable:
    where = f"variables.{name}"
    if not isinstance(entry, Mapping):
        raise ConfigError(f"{where}: expected a mapping, got {type(entry).__name__}")
    weight = float(_require(entry, "weight", where))
    if weight < 0:
        raise ConfigError(f"{where}: weight must not be negative, got {weight}")
    enabled = bool(entry.get("enabled", True))
    notes = str(entry.get("notes", "")).strip()

    if "components" in entry:
        combine = str(entry.get("combine", "product"))
        if combine != "product":
            raise ConfigError(
                f"{where}: only 'product' is supported for `combine`, got {combine!r}"
            )
        components: list[Component] = []
        for comp_name, comp in entry["components"].items():
            comp_where = f"{where}.components.{comp_name}"
            spec = _require(comp, "curve", comp_where)
            try:
                curve = build_curve(spec)
            except ValueError as exc:
                raise ConfigError(f"{comp_where}: {exc}") from exc
            components.append(
                Component(
                    name=str(comp_name),
                    layer=str(_require(comp, "layer", comp_where)),
                    curve=curve,
                    curve_spec=spec,
                    notes=str(comp.get("notes", "")).strip(),
                )
            )
        if not components:
            raise ConfigError(f"{where}: `components` is empty")
        return Variable(
            name=name,
            weight=weight,
            enabled=enabled,
            notes=notes,
            combine=combine,
            components=components,
        )

    spec = _require(entry, "curve", where)
    try:
        curve = build_curve(spec)
    except ValueError as exc:
        raise ConfigError(f"{where}: {exc}") from exc
    return Variable(
        name=name,
        weight=weight,
        enabled=enabled,
        notes=notes,
        layer=str(_require(entry, "layer", where)),
        curve=curve,
        curve_spec=spec,
    )


def _parse_source(name: str, entry: Mapping[str, Any]) -> Source:
    where = f"sources.{name}"
    mode = str(entry.get("mode", "manual"))
    if mode not in {"auto", "manual"}:
        raise ConfigError(f"{where}: mode must be 'auto' or 'manual', got {mode!r}")
    return Source(
        name=name,
        mode=mode,
        filename=entry.get("filename"),
        kind=entry.get("kind"),
        url=entry.get("url"),
        where=entry.get("where"),
        portal=entry.get("portal"),
        licence=str(entry.get("licence", "")),
        optional=bool(entry.get("optional", False)),
        notes=str(entry.get("notes", "")).strip(),
    )


def load_config(path: str | Path) -> Config:
    path = Path(path)
    if not path.exists():
        raise ConfigError(f"config file not found: {path}")
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}

    project = raw.get("project") or {}
    resolution = float(project.get("resolution_m", 10.0))
    if resolution <= 0:
        raise ConfigError(f"project.resolution_m must be positive, got {resolution}")
    bbox_list = project.get("study_area_bbox") or []
    if len(bbox_list) != 4:
        raise ConfigError("project.study_area_bbox must be [minx, miny, maxx, maxy]")
    bbox = tuple(float(v) for v in bbox_list)  # type: ignore[assignment]
    if bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
        raise ConfigError(f"project.study_area_bbox is degenerate: {bbox}")

    sites = [_parse_site(e, i) for i, e in enumerate(raw.get("known_sites") or [])]
    if not sites:
        raise ConfigError("at least one entry in known_sites is required")
    if not any(s.use_for_calibration for s in sites):
        raise ConfigError(
            "no known_site has use_for_calibration: true - the model cannot be "
            "sanity-checked without at least one precise occurrence record"
        )

    variables = [
        _parse_variable(name, entry) for name, entry in (raw.get("variables") or {}).items()
    ]
    enabled = [v for v in variables if v.enabled and v.weight > 0]
    if not enabled:
        raise ConfigError("no enabled variable carries a positive weight")

    scoring = dict(raw.get("scoring") or {})
    method = scoring.setdefault("method", "weighted_mean")
    if method not in VALID_SCORING_METHODS:
        raise ConfigError(
            f"scoring.method must be one of {sorted(VALID_SCORING_METHODS)}, got {method!r}"
        )
    gamma = float(scoring.setdefault("gamma", 1.0))
    if gamma <= 0 or not math.isfinite(gamma):
        raise ConfigError(f"scoring.gamma must be a positive number, got {gamma}")

    sources = {
        name: _parse_source(name, entry or {})
        for name, entry in (raw.get("sources") or {}).items()
    }

    config = Config(
        path=path,
        raw=raw,
        crs=str(project.get("crs", "EPSG:27700")),
        resolution_m=resolution,
        study_area_bbox=bbox,  # type: ignore[arg-type]
        known_sites=sites,
        variables=variables,
        sources=sources,
        hard_filters=dict(raw.get("hard_filters") or {}),
        scoring=scoring,
        calibration=dict(raw.get("calibration") or {}),
        candidates=dict(raw.get("candidates") or {}),
        layers=dict(raw.get("layers") or {}),
    )
    config.site_warnings = _check_sites_in_bbox(config)
    return config


def _check_sites_in_bbox(config: Config) -> list[str]:
    """Warn (not fail) if a known site lies outside the study bounding box."""
    minx, miny, maxx, maxy = config.study_area_bbox
    problems = []
    for site in config.known_sites:
        if not (minx <= site.easting <= maxx and miny <= site.northing <= maxy):
            problems.append(
                f"known site {site.label} at ({site.easting:.0f}, {site.northing:.0f}) "
                f"falls outside project.study_area_bbox"
            )
    return problems


def normalised_weights(variables: Iterable[Variable]) -> dict[str, float]:
    """Renormalise weights to sum to 1 across the variables given."""
    items = [(v.name, v.weight) for v in variables if v.weight > 0]
    total = sum(w for _, w in items)
    if total <= 0:
        raise ConfigError("cannot normalise weights: they sum to zero")
    return {name: weight / total for name, weight in items}
