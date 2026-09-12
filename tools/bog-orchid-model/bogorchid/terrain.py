"""Terrain derivatives from a DTM: depression filling, slope, D8 flow
accumulation and the topographic wetness index.

Implemented directly on numpy rather than pulled from a heavier hydrology
package so that the assumptions are visible and auditable. The one that matters
ecologically is in `flow_accumulation`: flow is routed D8 over a depression-
filled surface, so accumulation represents throughflow rather than ponding.
"""

from __future__ import annotations

import heapq
import math

import numpy as np

# (row offset, column offset) for the eight D8 neighbours, and the along-flow
# distance multiplier for each (diagonals are sqrt(2) cells apart).
_NEIGHBOURS: tuple[tuple[int, int], ...] = (
    (-1, -1), (-1, 0), (-1, 1),
    (0, -1), (0, 1),
    (1, -1), (1, 0), (1, 1),
)
_DISTANCES: tuple[float, ...] = tuple(
    math.hypot(dr, dc) for dr, dc in _NEIGHBOURS
)


def fill_depressions(
    dem: np.ndarray,
    nodata_mask: np.ndarray | None = None,
    epsilon: float = 1e-3,
) -> np.ndarray:
    """Priority-flood depression filling with a small enforced gradient.

    Barnes, Lehman & Mulla (2014). Every cell is raised to at least the level of
    the lowest path to the grid edge, plus ``epsilon`` per step, so that the
    filled surface contains no true flats and D8 routing is defined everywhere.

    The epsilon matters here: without it, filled hollows become flats, D8 routing
    stalls, and flow accumulation develops artificial hot spots exactly in the
    boggy hollows this model is looking at.
    """
    dem = np.asarray(dem, dtype="float64")
    rows, cols = dem.shape
    if nodata_mask is None:
        nodata_mask = ~np.isfinite(dem)
    nodata_mask = np.asarray(nodata_mask, dtype=bool)

    filled = dem.copy()
    closed = nodata_mask.copy()

    heap: list[tuple[float, int, int]] = []
    # Seed with every valid cell on the grid edge, and every valid cell adjacent
    # to nodata - both are places where water can leave the domain.
    edge = np.zeros((rows, cols), dtype=bool)
    edge[0, :] = edge[-1, :] = True
    edge[:, 0] = edge[:, -1] = True
    if nodata_mask.any():
        padded = np.pad(nodata_mask, 1, constant_values=False)
        adjacent = np.zeros((rows, cols), dtype=bool)
        for dr, dc in _NEIGHBOURS:
            adjacent |= padded[1 + dr : 1 + dr + rows, 1 + dc : 1 + dc + cols]
        edge |= adjacent
    seeds = edge & ~nodata_mask
    if not seeds.any():
        raise ValueError("DEM has no valid cells on its boundary to drain to")

    for r, c in zip(*np.nonzero(seeds)):
        heapq.heappush(heap, (float(filled[r, c]), int(r), int(c)))
        closed[r, c] = True

    while heap:
        elevation, r, c = heapq.heappop(heap)
        for dr, dc in _NEIGHBOURS:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < rows and 0 <= nc < cols) or closed[nr, nc]:
                continue
            neighbour = filled[nr, nc]
            if neighbour <= elevation:
                neighbour = elevation + epsilon
                filled[nr, nc] = neighbour
            closed[nr, nc] = True
            heapq.heappush(heap, (float(neighbour), nr, nc))

    filled[nodata_mask] = np.nan
    return filled


def slope_degrees(
    dem: np.ndarray, cell_size: float, nodata_mask: np.ndarray | None = None
) -> np.ndarray:
    """Slope in degrees by Horn's (1981) third-order finite difference.

    Horn's method is used in preference to a simple 2-cell difference because it
    is much less sensitive to the single-cell noise that LIDAR-derived DTMs carry
    over vegetated bog surfaces.
    """
    dem = np.asarray(dem, dtype="float64")
    if nodata_mask is None:
        nodata_mask = ~np.isfinite(dem)

    # Edge-replicate padding keeps the slope defined at the grid margin.
    work = dem.copy()
    if nodata_mask.any():
        work = _fill_nodata_with_nearest(work, nodata_mask)
    p = np.pad(work, 1, mode="edge")

    dz_dx = (
        (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:])
        - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    ) / (8 * cell_size)
    dz_dy = (
        (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:])
        - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    ) / (8 * cell_size)

    slope = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy)))
    slope[nodata_mask] = np.nan
    return slope


def _fill_nodata_with_nearest(array: np.ndarray, nodata_mask: np.ndarray) -> np.ndarray:
    """Replace nodata with the value of the nearest valid cell.

    Only used so that finite-difference windows straddling a nodata edge return
    something finite; the results are masked out again afterwards.
    """
    from scipy import ndimage

    if not nodata_mask.any():
        return array
    if nodata_mask.all():
        return np.zeros_like(array)
    indices = ndimage.distance_transform_edt(
        nodata_mask, return_distances=False, return_indices=True
    )
    return array[tuple(indices)]


def d8_receivers(
    filled: np.ndarray, cell_size: float, nodata_mask: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """Steepest-descent (D8) receiver index for every cell.

    Returns ``(receivers, valid)`` where ``receivers`` holds the flat index of
    each cell's downslope neighbour. Cells that drain off the grid, or that have
    no lower neighbour, receive themselves and act as outlets.
    """
    filled = np.asarray(filled, dtype="float64")
    rows, cols = filled.shape
    if nodata_mask is None:
        nodata_mask = ~np.isfinite(filled)
    valid = ~nodata_mask

    flat_index = np.arange(rows * cols, dtype="int64").reshape(rows, cols)
    receivers = flat_index.copy()
    best_gradient = np.zeros((rows, cols), dtype="float64")

    big = np.inf
    padded = np.pad(filled, 1, constant_values=big)
    padded_index = np.pad(flat_index, 1, constant_values=-1)

    for (dr, dc), step in zip(_NEIGHBOURS, _DISTANCES):
        neighbour = padded[1 + dr : 1 + dr + rows, 1 + dc : 1 + dc + cols]
        neighbour_index = padded_index[1 + dr : 1 + dr + rows, 1 + dc : 1 + dc + cols]
        with np.errstate(invalid="ignore"):
            gradient = (filled - neighbour) / (step * cell_size)
        better = (
            np.isfinite(gradient)
            & (gradient > best_gradient)
            & (neighbour_index >= 0)
            & valid
        )
        best_gradient = np.where(better, gradient, best_gradient)
        receivers = np.where(better, neighbour_index, receivers)

    receivers[nodata_mask] = flat_index[nodata_mask]
    return receivers, valid


def flow_accumulation(
    filled: np.ndarray, cell_size: float, nodata_mask: np.ndarray | None = None
) -> np.ndarray:
    """D8 flow accumulation, in number of contributing cells (self included).

    Accumulated in topological order using Kahn's algorithm over the drainage
    forest, one whole level per vectorised step. That keeps a full-moor grid
    tractable in numpy without a per-cell Python loop.
    """
    filled = np.asarray(filled, dtype="float64")
    if nodata_mask is None:
        nodata_mask = ~np.isfinite(filled)
    receivers, valid = d8_receivers(filled, cell_size, nodata_mask)

    shape = filled.shape
    size = filled.size
    receivers_flat = receivers.ravel()
    valid_flat = valid.ravel()
    index = np.arange(size, dtype="int64")

    # Self-draining cells (outlets and nodata) pass nothing on.
    transfers = valid_flat & (receivers_flat != index)

    accumulation = np.where(valid_flat, 1.0, 0.0)
    in_degree = np.bincount(receivers_flat[transfers], minlength=size)

    frontier = index[valid_flat & (in_degree == 0)]
    processed = 0
    while frontier.size:
        moving = frontier[transfers[frontier]]
        if moving.size:
            targets = receivers_flat[moving]
            np.add.at(accumulation, targets, accumulation[moving])
            np.add.at(in_degree, targets, -1)
            candidates = np.unique(targets)
            frontier = candidates[in_degree[candidates] == 0]
        else:
            frontier = np.empty(0, dtype="int64")
        processed += moving.size
        if processed > size:  # pragma: no cover - guards against a cycle
            raise RuntimeError("flow accumulation did not terminate; DEM has a cycle")

    accumulation = accumulation.reshape(shape)
    accumulation[nodata_mask] = np.nan
    return accumulation


def topographic_wetness_index(
    accumulation: np.ndarray,
    slope_deg: np.ndarray,
    cell_size: float,
    min_slope_deg: float = 0.1,
) -> np.ndarray:
    """TWI = ln(a / tan(beta)), with ``a`` the specific catchment area.

    Specific catchment area is upslope area per unit contour width, i.e.
    ``cells * cell_size**2 / cell_size``. Slope is floored at ``min_slope_deg``
    so that flat cells give a large but finite index rather than infinity.
    """
    accumulation = np.asarray(accumulation, dtype="float64")
    slope_deg = np.asarray(slope_deg, dtype="float64")

    specific_area = np.maximum(accumulation, 1.0) * cell_size
    tan_beta = np.tan(np.radians(np.maximum(slope_deg, min_slope_deg)))
    with np.errstate(divide="ignore", invalid="ignore"):
        twi = np.log(specific_area / tan_beta)
    twi[~np.isfinite(accumulation) | ~np.isfinite(slope_deg)] = np.nan
    return twi


def derive_all(
    dem: np.ndarray,
    cell_size: float,
    nodata_mask: np.ndarray | None = None,
    fill: bool = True,
) -> dict[str, np.ndarray]:
    """Convenience wrapper returning every terrain layer the model consumes."""
    dem = np.asarray(dem, dtype="float64")
    if nodata_mask is None:
        nodata_mask = ~np.isfinite(dem)

    filled = fill_depressions(dem, nodata_mask) if fill else dem
    # Slope is taken from the ORIGINAL surface, not the filled one: the filled
    # surface has an artificial epsilon gradient imposed across hollows, and
    # using it would report a fake slope exactly where the mires are.
    slope = slope_degrees(dem, cell_size, nodata_mask)
    accumulation = flow_accumulation(filled, cell_size, nodata_mask)
    twi = topographic_wetness_index(accumulation, slope, cell_size)

    with np.errstate(divide="ignore", invalid="ignore"):
        accumulation_log10 = np.log10(np.maximum(accumulation, 1.0))
    accumulation_log10[~np.isfinite(accumulation)] = np.nan

    return {
        "elevation_m": np.where(nodata_mask, np.nan, dem),
        "slope_deg": slope,
        "flow_accumulation": accumulation,
        "flow_accumulation_log10": accumulation_log10,
        "twi": twi,
    }
