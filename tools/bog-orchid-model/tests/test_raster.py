import numpy as np
import pytest
from shapely.geometry import LineString, box

from bogorchid.raster import (
    buffer_mask,
    distance_to_geometries,
    grid_from_bounds,
    rasterize_vector,
    sample_at,
    sample_window,
)


@pytest.fixture
def grid():
    return grid_from_bounds((260000, 86000, 268000, 92000), 10.0)


def test_grid_covers_requested_bounds(grid):
    assert grid.shape == (600, 800)
    assert grid.bounds == (260000.0, 86000.0, 268000.0, 92000.0)


def test_bounds_are_snapped_outwards():
    grid = grid_from_bounds((260001, 86001, 267999, 91999), 10.0)
    minx, miny, maxx, maxy = grid.bounds
    assert minx <= 260001 and miny <= 86001
    assert maxx >= 267999 and maxy >= 91999


def test_coordinate_round_trip(grid):
    row, col = grid.rowcol(264524, 90050)
    x, y = grid.xy(np.array([row]), np.array([col]))
    assert abs(x[0] - 264524) <= grid.resolution
    assert abs(y[0] - 90050) <= grid.resolution


def test_distance_transform_is_metric(grid):
    line = LineString([(262000, 86000), (262000, 92000)])
    distance = distance_to_geometries([line], grid)
    row, _ = grid.rowcol(262000, 89000)
    _, on_line = grid.rowcol(262000, 89000)
    _, one_km = grid.rowcol(263000, 89000)
    assert distance[row, on_line] == pytest.approx(0.0, abs=10.0)
    assert distance[row, one_km] == pytest.approx(1000.0, abs=10.0)


def test_buffer_grows_by_metres_not_cells(grid):
    seed = np.zeros(grid.shape, dtype=bool)
    row, col = grid.rowcol(264000, 89000)
    seed[row, col] = True
    buffered = buffer_mask(seed, grid, 100.0)
    # A 100 m radius at 10 m resolution is a disc of radius 10 cells.
    assert buffered.sum() == pytest.approx(np.pi * 10**2, rel=0.2)
    assert not buffer_mask(seed, grid, 0.0)[row, col - 5]


def test_rasterize_burns_polygon_values(grid):
    polygon = box(262000, 88000, 263000, 89000)
    burned = rasterize_vector([polygon], grid, values=[7.0])
    row, col = grid.rowcol(262500, 88500)
    assert burned[row, col] == 7.0
    outside_row, outside_col = grid.rowcol(266000, 91000)
    assert burned[outside_row, outside_col] == 0.0


def test_sample_outside_the_grid_is_nodata(grid):
    array = np.ones(grid.shape)
    assert np.isnan(sample_at(array, grid, 100000, 100000))


def test_window_covers_the_square_a_coarse_reference_denotes(grid):
    array = np.zeros(grid.shape)
    row, col = grid.rowcol(264000, 89000)
    array[row - 5 : row + 6, col - 5 : col + 6] = 3.0
    window = sample_window(array, grid, 264000, 89000, radius_m=50.0)
    assert window.size == 11 * 11
    assert np.all(window == 3.0)
