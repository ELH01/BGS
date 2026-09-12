"""Model grid definition and raster/vector alignment.

Every layer the model uses is brought onto one common grid - an EPSG:27700
grid snapped to the working resolution - before anything is compared or
combined. Doing the reprojection once, here, is what stops a silent half-pixel
shift between the peat map and the terrain from quietly moving the answer.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import rasterio
from rasterio import features
from rasterio.enums import Resampling
from rasterio.transform import Affine, rowcol, xy
from rasterio.warp import reproject

DEFAULT_CRS = "EPSG:27700"


@dataclass(frozen=True)
class ModelGrid:
    """The common grid. Origin is the top-left corner, north-up, square cells."""

    transform: Affine
    width: int
    height: int
    crs: str = DEFAULT_CRS

    @property
    def resolution(self) -> float:
        return float(abs(self.transform.a))

    @property
    def shape(self) -> tuple[int, int]:
        return self.height, self.width

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        minx = self.transform.c
        maxy = self.transform.f
        maxx = minx + self.width * self.transform.a
        miny = maxy + self.height * self.transform.e
        return (minx, min(miny, maxy), maxx, max(miny, maxy))

    def profile(self, dtype: str = "float32", nodata: float | None = np.nan) -> dict[str, Any]:
        return {
            "driver": "GTiff",
            "height": self.height,
            "width": self.width,
            "count": 1,
            "dtype": dtype,
            "crs": self.crs,
            "transform": self.transform,
            "nodata": nodata,
            "compress": "deflate",
            "predictor": 2 if dtype.startswith("float") else 1,
            "tiled": True,
        }

    def xy(self, rows: np.ndarray, cols: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Cell-centre coordinates for the given row/column indices."""
        x, y = xy(self.transform, rows, cols, offset="center")
        return np.asarray(x, dtype="float64"), np.asarray(y, dtype="float64")

    def rowcol(self, easting: float, northing: float) -> tuple[int, int]:
        row, col = rowcol(self.transform, easting, northing)
        return int(row), int(col)

    def contains(self, easting: float, northing: float) -> bool:
        minx, miny, maxx, maxy = self.bounds
        return minx <= easting < maxx and miny <= northing < maxy

    def expanded(self, margin_m: float) -> "ModelGrid":
        """A grid of the same resolution extended outwards on all sides."""
        cells = int(np.ceil(margin_m / self.resolution))
        transform = self.transform @ Affine.translation(-cells, -cells)
        return ModelGrid(
            transform=transform,
            width=self.width + 2 * cells,
            height=self.height + 2 * cells,
            crs=self.crs,
        )


def grid_from_bounds(
    bounds: Iterable[float], resolution: float, crs: str = DEFAULT_CRS
) -> ModelGrid:
    """Build a grid covering ``bounds``, snapped outwards to the resolution."""
    minx, miny, maxx, maxy = (float(v) for v in bounds)
    if minx >= maxx or miny >= maxy:
        raise ValueError(f"degenerate bounds: {(minx, miny, maxx, maxy)}")
    minx = np.floor(minx / resolution) * resolution
    miny = np.floor(miny / resolution) * resolution
    maxx = np.ceil(maxx / resolution) * resolution
    maxy = np.ceil(maxy / resolution) * resolution
    width = int(round((maxx - minx) / resolution))
    height = int(round((maxy - miny) / resolution))
    transform = Affine(resolution, 0.0, minx, 0.0, -resolution, maxy)
    return ModelGrid(transform=transform, width=width, height=height, crs=crs)


def read_raster_to_grid(
    path: str | Path,
    grid: ModelGrid,
    resampling: str = "bilinear",
    band: int = 1,
) -> np.ndarray:
    """Read a raster, reprojecting and resampling onto the model grid.

    Returns float64 with NaN for nodata. ``resampling`` should be "nearest" for
    anything categorical (vegetation class, geology code) and "bilinear" for
    continuous surfaces - getting this wrong invents class codes that do not
    exist.
    """
    method = getattr(Resampling, resampling, None)
    if method is None:
        raise ValueError(f"unknown resampling method {resampling!r}")

    destination = np.full(grid.shape, np.nan, dtype="float64")
    with rasterio.open(path) as src:
        source = src.read(band, masked=True).astype("float64").filled(np.nan)
        reproject(
            source=source,
            destination=destination,
            src_transform=src.transform,
            src_crs=src.crs or grid.crs,
            src_nodata=np.nan,
            dst_transform=grid.transform,
            dst_crs=grid.crs,
            dst_nodata=np.nan,
            resampling=method,
        )
    return destination


def raster_native_resolution(path: str | Path) -> tuple[float, float, str]:
    """Native pixel size and CRS of a raster, for the preflight report."""
    with rasterio.open(path) as src:
        return abs(src.transform.a), abs(src.transform.e), str(src.crs)


def rasterize_vector(
    geometries: Iterable[Any],
    grid: ModelGrid,
    values: Iterable[float] | None = None,
    fill: float = 0.0,
    all_touched: bool = False,
) -> np.ndarray:
    """Burn geometries onto the model grid.

    ``all_touched=True`` burns every cell the geometry passes through, which is
    what a linear watercourse network needs; polygons should use the default so
    that area is not systematically inflated.
    """
    geometries = list(geometries)
    if not geometries:
        return np.full(grid.shape, fill, dtype="float64")
    if values is None:
        shapes = ((geom, 1.0) for geom in geometries)
    else:
        shapes = zip(geometries, (float(v) for v in values))
    return features.rasterize(
        shapes=shapes,
        out_shape=grid.shape,
        transform=grid.transform,
        fill=fill,
        all_touched=all_touched,
        dtype="float64",
    )


def distance_to_geometries(
    geometries: Iterable[Any],
    grid: ModelGrid,
    margin_m: float = 2000.0,
) -> np.ndarray:
    """Euclidean distance in metres from each cell to the nearest geometry.

    Computed on a grid expanded by ``margin_m`` so that features just beyond the
    study area still pull distances down near the edge; without the margin the
    boundary picks up a spurious "far from water" halo.
    """
    working = grid.expanded(margin_m)
    burned = rasterize_vector(geometries, working, all_touched=True)
    if not burned.any():
        return np.full(grid.shape, np.inf, dtype="float64")

    from scipy import ndimage

    distance = ndimage.distance_transform_edt(
        burned == 0, sampling=(working.resolution, working.resolution)
    )
    offset = int(round((grid.transform.c - working.transform.c) / working.resolution))
    offset_rows = int(round((working.transform.f - grid.transform.f) / working.resolution))
    return distance[
        offset_rows : offset_rows + grid.height, offset : offset + grid.width
    ].astype("float64")


def buffer_mask(mask: np.ndarray, grid: ModelGrid, distance_m: float) -> np.ndarray:
    """Grow a boolean mask outwards by a distance in metres."""
    if distance_m <= 0:
        return np.asarray(mask, dtype=bool)
    from scipy import ndimage

    mask = np.asarray(mask, dtype=bool)
    if not mask.any():
        return mask
    distance = ndimage.distance_transform_edt(
        ~mask, sampling=(grid.resolution, grid.resolution)
    )
    return distance <= distance_m


def write_raster(
    path: str | Path,
    array: np.ndarray,
    grid: ModelGrid,
    dtype: str = "float32",
    nodata: float | None = np.nan,
    description: str | None = None,
) -> Path:
    """Write a single-band GeoTIFF on the model grid."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    profile = grid.profile(dtype=dtype, nodata=nodata)
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(np.asarray(array, dtype=dtype), 1)
        if description:
            dst.set_band_description(1, description)
    return path


def sample_at(array: np.ndarray, grid: ModelGrid, easting: float, northing: float) -> float:
    """Value of ``array`` at a coordinate, or NaN if outside the grid."""
    if not grid.contains(easting, northing):
        return float("nan")
    row, col = grid.rowcol(easting, northing)
    if not (0 <= row < grid.height and 0 <= col < grid.width):
        return float("nan")
    return float(array[row, col])


def sample_window(
    array: np.ndarray,
    grid: ModelGrid,
    easting: float,
    northing: float,
    radius_m: float,
) -> np.ndarray:
    """All values within a square window around a coordinate.

    Used for occurrence records whose grid reference is coarser than the working
    resolution: the honest question is not "what is the value at this pixel" but
    "what is the range of values within the square this record denotes".
    """
    if not grid.contains(easting, northing):
        return np.array([], dtype="float64")
    row, col = grid.rowcol(easting, northing)
    cells = max(0, int(round(radius_m / grid.resolution)))
    r0, r1 = max(0, row - cells), min(grid.height, row + cells + 1)
    c0, c1 = max(0, col - cells), min(grid.width, col + cells + 1)
    if r0 >= r1 or c0 >= c1:
        return np.array([], dtype="float64")
    window = array[r0:r1, c0:c1]
    return window[np.isfinite(window)]
