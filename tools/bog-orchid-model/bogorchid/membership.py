"""Transparent membership (suitability) curves.

Every ecological preference in this model is expressed as one of a small number
of named curves that map a raw variable value onto 0..1. They are deliberately
simple and fully specified in ``config.yaml`` so that the weighting logic can be
read, argued with and re-tuned by an ecologist rather than a programmer.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping

import numpy as np

Curve = Callable[[np.ndarray], np.ndarray]


def trapezoid(a: float, b: float, c: float, d: float) -> Curve:
    """Rises 0->1 across [a, b], holds 1 across [b, c], falls 1->0 across [c, d].

    This is the workhorse for "mid-range is best" preferences, where both too
    little and too much are wrong — the shape the bog orchid's hydrology needs,
    since the wettest pools are as unsuitable as dry ground.
    """
    if not a <= b <= c <= d:
        raise ValueError(f"trapezoid needs a <= b <= c <= d, got {(a, b, c, d)}")

    def _curve(x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype="float64")
        out = np.zeros_like(x)
        with np.errstate(divide="ignore", invalid="ignore"):
            if b > a:
                rising = (x > a) & (x < b)
                out[rising] = (x[rising] - a) / (b - a)
            if d > c:
                falling = (x > c) & (x < d)
                out[falling] = (d - x[falling]) / (d - c)
        out[(x >= b) & (x <= c)] = 1.0
        return np.clip(out, 0.0, 1.0)

    return _curve


def ramp(lo: float, hi: float) -> Curve:
    """Monotonic increase: 0 at or below ``lo``, 1 at or above ``hi``."""
    return trapezoid(lo, hi, np.inf, np.inf)


def decay(lo: float, hi: float) -> Curve:
    """Monotonic decrease: 1 at or below ``lo``, 0 at or above ``hi``."""
    return trapezoid(-np.inf, -np.inf, lo, hi)


def gaussian(mu: float, sigma: float) -> Curve:
    """Bell curve peaking at ``mu``. Softer-shouldered than a trapezoid."""
    if sigma <= 0:
        raise ValueError(f"gaussian needs sigma > 0, got {sigma}")

    def _curve(x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype="float64")
        return np.exp(-0.5 * ((x - mu) / sigma) ** 2)

    return _curve


def categorical(mapping: Mapping[Any, float], default: float = 0.0) -> Curve:
    """Look up a score per class code. Used for geology and vegetation classes."""
    lookup = {float(k): float(v) for k, v in mapping.items()}

    def _curve(x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype="float64")
        out = np.full(x.shape, float(default), dtype="float64")
        for code, score in lookup.items():
            out[x == code] = score
        return out

    return _curve


def boolean(true_score: float = 1.0, false_score: float = 0.0) -> Curve:
    """Score a flag layer. Non-zero counts as true."""

    def _curve(x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype="float64")
        return np.where(x > 0, float(true_score), float(false_score))

    return _curve


def constant(value: float = 1.0) -> Curve:
    """Score everything the same. Used to neutralise a variable without
    removing it from the config, so the edit is visible in a diff."""

    def _curve(x: np.ndarray) -> np.ndarray:
        return np.full(np.asarray(x, dtype="float64").shape, float(value))

    return _curve


_BUILDERS: dict[str, Callable[..., Curve]] = {
    "trapezoid": trapezoid,
    "ramp": ramp,
    "decay": decay,
    "gaussian": gaussian,
    "categorical": categorical,
    "boolean": boolean,
    "constant": constant,
}


def build_curve(spec: Mapping[str, Any]) -> Curve:
    """Build a curve from its ``config.yaml`` form, e.g.::

        curve: {type: trapezoid, a: 0.5, b: 1.5, c: 5.0, d: 12.0}
    """
    params = dict(spec)
    kind = params.pop("type", None)
    if kind is None:
        raise ValueError(f"curve spec {spec!r} has no 'type'")
    if kind not in _BUILDERS:
        raise ValueError(
            f"unknown curve type {kind!r}; expected one of {sorted(_BUILDERS)}"
        )
    params.pop("notes", None)
    try:
        return _BUILDERS[kind](**params)
    except TypeError as exc:
        raise ValueError(f"bad parameters for curve type {kind!r}: {exc}") from exc


def describe_curve(spec: Mapping[str, Any]) -> str:
    """One-line human-readable summary, for the calibration report."""
    params = {k: v for k, v in spec.items() if k not in {"type", "notes"}}
    rendered = ", ".join(f"{k}={v}" for k, v in params.items())
    return f"{spec.get('type', '?')}({rendered})"
