"""The weighted overlay: hard filters, membership surfaces, and their
combination into a single suitability score.

Nothing here decides anything on its own. Every threshold, weight and curve is
read from the configuration, and every departure from it at run time (a dropped
variable, a renormalised weight) is recorded on the result so it shows up in the
report rather than only in the numbers.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .config import Config, Variable, normalised_weights


class ScoringError(RuntimeError):
    """Raised when the model cannot be scored at all."""


@dataclass
class ScoringResult:
    score: np.ndarray
    memberships: dict[str, np.ndarray]
    weights: dict[str, float]
    filter_mask: np.ndarray
    filter_stats: dict[str, dict[str, float]]
    dropped: dict[str, str] = field(default_factory=dict)
    method: str = "weighted_mean"
    gamma: float = 1.0

    @property
    def scored_cells(self) -> int:
        return int(np.isfinite(self.score).sum())

    def summary_lines(self) -> list[str]:
        lines = [
            f"Scoring method: {self.method} (gamma={self.gamma})",
            f"Cells scored:   {self.scored_cells:,}",
            "Weights actually used (renormalised to 1.0):",
        ]
        for name, weight in sorted(self.weights.items(), key=lambda kv: -kv[1]):
            lines.append(f"  {name:24s} {weight:6.3f}")
        for name, reason in self.dropped.items():
            lines.append(f"  DROPPED {name:16s} {reason}")
        return lines


def build_filter_mask(
    config: Config, layers: dict[str, np.ndarray], shape: tuple[int, int]
) -> tuple[np.ndarray, dict[str, dict[str, float]]]:
    """Apply the hard filters. Returns (mask of cells that pass, per-filter stats)."""
    mask = np.ones(shape, dtype=bool)
    stats: dict[str, dict[str, float]] = {}
    total = float(mask.size)

    phi = config.hard_filters.get("priority_habitat") or {}
    if phi.get("enabled", False):
        layer_name = phi.get("layer", "priority_habitat")
        layer = layers.get(layer_name)
        if layer is None:
            raise ScoringError(
                f"hard filter 'priority_habitat' needs layer {layer_name!r}, which is "
                "not available. Supply the Priority Habitats Inventory, or set "
                "hard_filters.priority_habitat.enabled: false - but be aware that "
                "disabling it scores the whole moor, not just its mires."
            )
        passed = np.nan_to_num(layer, nan=0.0) > 0
        mask &= passed
        stats["priority_habitat"] = {
            "cells_passed": float(passed.sum()),
            "percent_of_area": 100.0 * float(passed.sum()) / total,
        }

    peat = config.hard_filters.get("peat_present") or {}
    if peat.get("enabled", False):
        layer_name = peat.get("layer", "peat_depth")
        layer = layers.get(layer_name)
        if layer is None:
            raise ScoringError(
                f"hard filter 'peat_present' needs layer {layer_name!r}, which is not "
                "available. Supply the England Peat Map peat depth raster, or set "
                "hard_filters.peat_present.enabled: false."
            )
        threshold = float(peat.get("min_depth_cm", 0.0))
        with np.errstate(invalid="ignore"):
            passed = np.isfinite(layer) & (layer >= threshold)
        mask &= passed
        stats["peat_present"] = {
            "cells_passed": float(passed.sum()),
            "percent_of_area": 100.0 * float(passed.sum()) / total,
            "min_depth_cm": threshold,
        }

    stats["combined"] = {
        "cells_passed": float(mask.sum()),
        "percent_of_area": 100.0 * float(mask.sum()) / total,
    }
    if not mask.any():
        raise ScoringError(
            "no cell passes the hard filters - nothing can be scored. Check that the "
            "Priority Habitat and peat layers actually cover the study area and are "
            "in EPSG:27700."
        )
    return mask, stats


def _membership_for(
    variable: Variable, layers: dict[str, np.ndarray]
) -> tuple[np.ndarray | None, str]:
    """Membership surface for one variable, or (None, reason) if unavailable."""
    missing = [name for name in variable.required_layers if name not in layers]
    if missing:
        return None, f"layer(s) not available: {', '.join(missing)}"

    if variable.is_composite:
        # Product: every component must hold. A zero in any one of them means the
        # variable as a whole is unsatisfied, which is the intended semantics for
        # the lateral-flow proxy (water arriving AND a gradient to move it).
        result = np.ones_like(layers[variable.components[0].layer], dtype="float64")
        for component in variable.components:
            values = layers[component.layer]
            scored = component.curve(values)
            scored = np.where(np.isfinite(values), scored, np.nan)
            result = result * scored
        return result, ""

    assert variable.curve is not None and variable.layer is not None
    values = layers[variable.layer]
    scored = variable.curve(values)
    scored = np.where(np.isfinite(values), scored, np.nan)
    return scored, ""


def score_area(config: Config, layers: dict[str, np.ndarray]) -> ScoringResult:
    """Compute the suitability surface for every cell passing the hard filters."""
    if not layers:
        raise ScoringError("no layers supplied")
    shape = next(iter(layers.values())).shape
    for name, array in layers.items():
        if array.shape != shape:
            raise ScoringError(
                f"layer {name!r} has shape {array.shape}, expected {shape}; all layers "
                "must be on the same model grid"
            )

    mask, filter_stats = build_filter_mask(config, layers, shape)

    memberships: dict[str, np.ndarray] = {}
    dropped: dict[str, str] = {}
    available: list[Variable] = []
    for variable in config.enabled_variables:
        surface, reason = _membership_for(variable, layers)
        if surface is None:
            dropped[variable.name] = reason
            continue
        memberships[variable.name] = surface
        available.append(variable)

    if not available:
        raise ScoringError(
            "every weighted variable was dropped for want of data; there is nothing "
            "to score. Run `preflight` to see which layers are missing."
        )

    weights = normalised_weights(available)
    method = str(config.scoring.get("method", "weighted_mean"))
    gamma = float(config.scoring.get("gamma", 1.0))

    # A variable with no data at a given cell should not silently count as zero.
    # Re-weight per cell across whichever variables are finite there.
    stack = np.stack([memberships[v.name] for v in available])
    weight_vector = np.array([weights[v.name] for v in available]).reshape(-1, 1, 1)
    finite = np.isfinite(stack)
    effective = np.where(finite, weight_vector, 0.0)
    weight_sum = effective.sum(axis=0)

    values = np.where(finite, stack, 0.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        if method == "weighted_mean":
            score = (values * effective).sum(axis=0) / weight_sum
        elif method == "weighted_geometric":
            # Floor at a small positive value so a single zero does not make the
            # whole product zero via log(0); it still dominates the result.
            floored = np.where(finite, np.maximum(stack, 1e-6), 1.0)
            score = np.exp((np.log(floored) * effective).sum(axis=0) / weight_sum)
        else:  # pragma: no cover - guarded in config validation
            raise ScoringError(f"unknown scoring method {method!r}")

    score = np.where(weight_sum > 0, score, np.nan)
    if gamma != 1.0:
        score = np.power(np.clip(score, 0.0, 1.0), gamma)
    score = np.where(mask, np.clip(score, 0.0, 1.0), np.nan)

    return ScoringResult(
        score=score,
        memberships=memberships,
        weights=weights,
        filter_mask=mask,
        filter_stats=filter_stats,
        dropped=dropped,
        method=method,
        gamma=gamma,
    )
