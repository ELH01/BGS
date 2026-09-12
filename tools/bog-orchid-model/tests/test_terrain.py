import numpy as np
import pytest

from bogorchid import terrain


@pytest.fixture
def hillside():
    """A plane falling south-to-north with a valley and a closed hollow."""
    rng = np.random.default_rng(0)
    n = 160
    y, x = np.mgrid[0:n, 0:n]
    dem = 100 - y * 0.3 + rng.normal(0, 0.02, (n, n))
    dem -= 6 * np.exp(-(((x - 80) ** 2) / (2 * 12.0**2)))
    dem[70:90, 30:50] -= 5
    return dem


def test_fill_raises_hollow_to_its_spill_point(hillside):
    filled = terrain.fill_depressions(hillside)
    perimeter = np.zeros(hillside.shape, dtype=bool)
    perimeter[69:91, 29:51] = True
    perimeter[70:90, 30:50] = False
    spill = hillside[perimeter].min()
    assert filled[80, 40] == pytest.approx(spill, abs=0.05)


def test_fill_never_lowers_ground(hillside):
    filled = terrain.fill_depressions(hillside)
    assert np.all(filled >= hillside - 1e-9)


def test_flow_accumulation_conserves_mass(hillside):
    """Every cell's contribution must arrive at exactly one outlet."""
    filled = terrain.fill_depressions(hillside)
    accumulation = terrain.flow_accumulation(filled, 10.0)
    receivers, _ = terrain.d8_receivers(filled, 10.0)
    flat = np.arange(hillside.size)
    outlets = receivers.ravel() == flat
    assert accumulation.ravel()[outlets].sum() == pytest.approx(hillside.size)
    assert accumulation.min() >= 1.0


def test_valley_concentrates_flow(hillside):
    filled = terrain.fill_depressions(hillside)
    accumulation = terrain.flow_accumulation(filled, 10.0)
    assert accumulation[:, 78:83].mean() > 5 * accumulation[:, 8:13].mean()


def test_slope_of_a_known_plane():
    # A plane falling 1 m per 10 m cell is 45 degrees.
    dem = np.tile(np.arange(20, dtype="float64") * 10.0, (20, 1))
    slope = terrain.slope_degrees(dem, 10.0)
    assert slope[10, 10] == pytest.approx(45.0, abs=1e-6)
    flat = terrain.slope_degrees(np.zeros((20, 20)), 10.0)
    assert flat.max() == pytest.approx(0.0, abs=1e-9)


def test_twi_rises_with_area_and_falls_with_slope():
    accumulation = np.array([[10.0, 100.0]])
    slope = np.array([[2.0, 2.0]])
    twi = terrain.topographic_wetness_index(accumulation, slope, 10.0)
    assert twi[0, 1] > twi[0, 0]

    steeper = terrain.topographic_wetness_index(
        np.array([[100.0]]), np.array([[20.0]]), 10.0
    )
    gentler = terrain.topographic_wetness_index(
        np.array([[100.0]]), np.array([[2.0]]), 10.0
    )
    assert gentler[0, 0] > steeper[0, 0]


def test_flat_ground_gives_finite_twi():
    twi = terrain.topographic_wetness_index(
        np.array([[50.0]]), np.array([[0.0]]), 10.0
    )
    assert np.isfinite(twi).all()


def test_nodata_is_preserved_not_invented(hillside):
    dem = hillside.copy()
    dem[0:15, 0:15] = np.nan
    derived = terrain.derive_all(dem, 10.0)
    for name, layer in derived.items():
        assert np.all(np.isnan(layer[0:15, 0:15])), name
        assert np.isfinite(layer[40:, 40:]).all(), name


def test_slope_comes_from_the_unfilled_surface(hillside):
    """Filling imposes an epsilon gradient; reading slope off it would report a
    fake gradient exactly where the mires are."""
    derived = terrain.derive_all(hillside, 10.0, fill=True)
    direct = terrain.slope_degrees(hillside, 10.0)
    assert np.allclose(derived["slope_deg"], direct, equal_nan=True)
