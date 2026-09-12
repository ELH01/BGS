"""Behavioural tests for the scoring, calibration and shortlisting logic.

These encode the ecological claims the model makes, so that a future edit to the
weights or curves that breaks one of them fails loudly instead of quietly
producing a different map.
"""

from pathlib import Path

import numpy as np
import pytest

from bogorchid.calibrate import derive_elevation_band, diagnose_sites, percentile_of
from bogorchid.candidates import patch_context, select_candidates
from bogorchid.config import load_config
from bogorchid.raster import grid_from_bounds
from bogorchid.score import ScoringError, score_area

CONFIG = Path(__file__).resolve().parent.parent / "config.yaml"


@pytest.fixture
def config():
    return load_config(CONFIG)


@pytest.fixture
def grid():
    # A small grid containing both precise Dartmoor records.
    return grid_from_bounds((262000, 88500, 265000, 90500), 10.0)


def uniform_layers(grid, **overrides):
    """A grid where every cell is ideal, so a test can vary one thing at a time."""
    shape = grid.shape
    layers = {
        "priority_habitat": np.ones(shape),
        "peat_depth": np.full(shape, 120.0),
        "sphagnum_flag": np.ones(shape),
        "slope_deg": np.full(shape, 3.0),
        "flow_accumulation_log10": np.full(shape, 2.5),
        "flow_accumulation": np.full(shape, 316.0),
        "twi": np.full(shape, 8.0),
        "distance_to_water_m": np.full(shape, 80.0),
        "base_richness": np.full(shape, 3.0),
        "elevation_m": np.full(shape, 420.0),
    }
    layers.update(overrides)
    return layers


# --------------------------------------------------------------------------
# Hard filters
# --------------------------------------------------------------------------

def test_ground_outside_priority_habitat_is_not_scored(config, grid):
    layers = uniform_layers(grid)
    layers["priority_habitat"][:, :50] = 0.0
    result = score_area(config, layers)
    assert np.all(np.isnan(result.score[:, :50]))
    assert np.all(np.isfinite(result.score[:, 50:]))


def test_ground_without_peat_is_not_scored(config, grid):
    layers = uniform_layers(grid)
    layers["peat_depth"][:30, :] = 2.0          # below the 10 cm threshold
    result = score_area(config, layers)
    assert np.all(np.isnan(result.score[:30, :]))


def test_failing_a_filter_gives_nodata_not_a_low_score(config, grid):
    """The distinction matters: 0 would rank above nothing, no-data ranks nowhere."""
    layers = uniform_layers(grid)
    layers["priority_habitat"][:] = 0.0
    layers["priority_habitat"][0, 0] = 1.0
    result = score_area(config, layers)
    assert result.scored_cells == 1


def test_missing_hard_filter_layer_is_an_error_not_a_default(config, grid):
    layers = uniform_layers(grid)
    del layers["peat_depth"]
    with pytest.raises(ScoringError, match="peat_depth"):
        score_area(config, layers)


def test_empty_search_area_raises_rather_than_returning_a_blank_map(config, grid):
    layers = uniform_layers(grid)
    layers["priority_habitat"][:] = 0.0
    with pytest.raises(ScoringError, match="no cell passes"):
        score_area(config, layers)


# --------------------------------------------------------------------------
# The ecological claims
# --------------------------------------------------------------------------

def test_standing_water_scores_below_throughflow(config, grid):
    """BSBI: lateral flow of water, explicitly NOT standing water."""
    flat = score_area(config, uniform_layers(grid, slope_deg=np.full(grid.shape, 0.05)))
    flowing = score_area(config, uniform_layers(grid))
    assert flat.score[0, 0] < flowing.score[0, 0]


def test_steep_ground_scores_below_gentle_ground(config, grid):
    steep = score_area(config, uniform_layers(grid, slope_deg=np.full(grid.shape, 25.0)))
    gentle = score_area(config, uniform_layers(grid))
    assert steep.score[0, 0] < gentle.score[0, 0]


def test_peak_wetness_does_not_score_highest(config, grid):
    """The species sits on hummock margins, not in the wettest pools."""
    mid = score_area(config, uniform_layers(grid, twi=np.full(grid.shape, 8.0)))
    extreme = score_area(config, uniform_layers(grid, twi=np.full(grid.shape, 17.0)))
    dry = score_area(config, uniform_layers(grid, twi=np.full(grid.shape, 2.0)))
    assert mid.score[0, 0] > extreme.score[0, 0]
    assert mid.score[0, 0] > dry.score[0, 0]


def test_no_upslope_water_defeats_a_perfect_slope(config, grid):
    """lateral_flow is a product: a gradient with nothing flowing down it is not
    a flush."""
    dry = score_area(
        config, uniform_layers(grid, flow_accumulation_log10=np.full(grid.shape, 0.2))
    )
    assert dry.memberships["lateral_flow"][0, 0] == 0.0


def test_acid_ground_still_scores_well(config, grid):
    """Geology is a soft nudge, not a filter: Dartmoor granite must stay viable."""
    acid = score_area(config, uniform_layers(grid, base_richness=np.ones(grid.shape)))
    base_rich = score_area(config, uniform_layers(grid))
    assert acid.score[0, 0] > 0.9
    assert base_rich.score[0, 0] > acid.score[0, 0]
    assert base_rich.score[0, 0] - acid.score[0, 0] < 0.05


def test_absent_sphagnum_is_penalised_but_not_disqualifying(config, grid):
    """The species also occurs on open moist peat, and the peat map's vegetation
    layer is modelled rather than surveyed."""
    without = score_area(config, uniform_layers(grid, sphagnum_flag=np.zeros(grid.shape)))
    assert 0.4 < without.score[0, 0] < 0.9


# --------------------------------------------------------------------------
# Graceful degradation
# --------------------------------------------------------------------------

def test_missing_optional_layer_drops_its_variable_and_renormalises(config, grid):
    layers = uniform_layers(grid)
    del layers["base_richness"]
    result = score_area(config, layers)
    assert "geology" in result.dropped
    assert "geology" not in result.weights
    assert sum(result.weights.values()) == pytest.approx(1.0)


def test_a_nodata_cell_in_one_layer_does_not_zero_the_cell(config, grid):
    layers = uniform_layers(grid)
    layers["twi"][0, 0] = np.nan
    result = score_area(config, layers)
    assert np.isfinite(result.score[0, 0])
    # Re-weighted across the remaining variables, not scored as if wetness were 0.
    assert result.score[0, 0] > 0.9


def test_geometric_combination_punishes_a_single_failure_harder(config, grid):
    layers = uniform_layers(grid, twi=np.full(grid.shape, 17.0))
    arithmetic = score_area(config, layers).score[0, 0]
    config.scoring["method"] = "weighted_geometric"
    geometric = score_area(config, layers).score[0, 0]
    assert geometric < arithmetic


# --------------------------------------------------------------------------
# Calibration
# --------------------------------------------------------------------------

def test_percentile_ranking():
    values = np.sort(np.linspace(0.0, 1.0, 101))
    assert percentile_of(0.5, values) == pytest.approx(50.5, abs=1.0)
    assert percentile_of(1.0, values) == 100.0
    assert np.isnan(percentile_of(np.nan, values))


def test_elevation_band_is_derived_from_the_sites_not_assumed(config, grid):
    elevation = np.full(grid.shape, 400.0)
    for site in config.calibration_sites:
        if grid.contains(site.easting, site.northing):
            row, col = grid.rowcol(site.easting, site.northing)
            elevation[row, col] = 430.0
    band, note = derive_elevation_band(config, elevation, grid)
    a, b, c, d = band
    assert a < b <= c < d
    assert b <= 400.0 <= c            # the observed values sit on the plateau
    assert d <= config.calibration["elevation"]["hard_max_m"]
    assert "derived from" in note


def test_elevation_band_is_capped_at_the_documented_ceiling(config, grid):
    """Dartmoor's high plateau is blanket bog, not flush, so the band is capped."""
    band, note = derive_elevation_band(config, np.full(grid.shape, 420.0), grid)
    assert band[3] <= config.calibration["elevation"]["hard_max_m"]
    assert "WARNING" not in note


def test_a_record_above_the_ceiling_overrides_the_ceiling(config, grid):
    """A record is evidence; the ceiling is an assumption. Scoring a known
    population as unsuitable to preserve an assumption would be backwards."""
    band, note = derive_elevation_band(config, np.full(grid.shape, 900.0), grid)
    assert band[2] >= 900.0
    assert "WARNING" in note


def test_calibration_fails_loudly_when_a_known_site_is_filtered_out(config, grid):
    """The single most important safety check in the model."""
    layers = uniform_layers(grid)
    for site in config.calibration_sites:
        if grid.contains(site.easting, site.northing):
            row, col = grid.rowcol(site.easting, site.northing)
            layers["priority_habitat"][row - 3 : row + 4, col - 3 : col + 4] = 0.0
    result = score_area(config, layers)
    calibration = diagnose_sites(config, grid, layers, result)
    assert not calibration.passed
    assert any("FAILED the hard filters" in w for w in calibration.warnings)


def test_calibration_fails_when_a_known_site_ranks_poorly(config, grid):
    layers = uniform_layers(grid)
    for site in config.calibration_sites:
        if grid.contains(site.easting, site.northing):
            row, col = grid.rowcol(site.easting, site.northing)
            layers["twi"][row, col] = 17.0           # implausibly wet
            layers["sphagnum_flag"][row, col] = 0.0
            layers["slope_deg"][row, col] = 0.02
    result = score_area(config, layers)
    calibration = diagnose_sites(config, grid, layers, result)
    assert not calibration.passed
    assert any("percentile" in w for w in calibration.warnings)


def test_calibration_passes_when_known_sites_rank_well(config, grid):
    layers = uniform_layers(grid, sphagnum_flag=np.zeros(grid.shape))
    for site in config.calibration_sites:
        if grid.contains(site.easting, site.northing):
            row, col = grid.rowcol(site.easting, site.northing)
            layers["sphagnum_flag"][row - 2 : row + 3, col - 2 : col + 3] = 1.0
    result = score_area(config, layers)
    calibration = diagnose_sites(config, grid, layers, result)
    assert calibration.passed, calibration.warnings


# --------------------------------------------------------------------------
# Candidate shortlist
# --------------------------------------------------------------------------

def test_candidates_avoid_known_sites_and_each_other(config, grid):
    layers = uniform_layers(grid)
    result = score_area(config, layers)
    table, notes = select_candidates(config, grid, result, layers)
    assert len(table) == config.candidates["count"]

    separation = config.candidates["min_separation_m"]
    points = table[["easting", "northing"]].to_numpy()
    for i, (x, y) in enumerate(points):
        others = np.delete(points, i, axis=0)
        assert np.hypot(others[:, 0] - x, others[:, 1] - y).min() >= separation - 1e-6

    buffer_m = config.candidates["exclusion_buffer_m"]
    for site in config.known_sites:
        if site.precision_m > config.candidates["max_record_precision_for_exclusion_m"]:
            continue
        distance = np.hypot(points[:, 0] - site.easting, points[:, 1] - site.northing)
        assert distance.min() >= buffer_m - grid.resolution


def test_candidates_are_ranked_by_score_descending(config, grid):
    rng = np.random.default_rng(1)
    layers = uniform_layers(grid, twi=rng.uniform(5.0, 12.0, grid.shape))
    result = score_area(config, layers)
    table, _ = select_candidates(config, grid, result, layers)
    scores = table["suitability_score"].to_numpy()
    assert np.all(np.diff(scores) <= 1e-9), "rank order must never invert"


def test_ties_are_broken_by_patch_context_not_raster_order(config, grid):
    layers = uniform_layers(grid)
    result = score_area(config, layers)
    # Every cell is identical, so only the tie-break can distinguish them; the
    # interior of the grid has more suitable neighbours than the margins.
    table, notes = select_candidates(config, grid, result, layers)
    assert any("share the top score" in note for note in notes)
    assert table["patch_score"].iloc[0] >= table["patch_score"].iloc[-1]


def test_patch_context_prefers_coherent_blocks_over_isolated_pixels(grid):
    score = np.full(grid.shape, np.nan)
    score[100:140, 100:140] = 0.9        # a coherent block
    score[10, 10] = 0.9                  # an isolated pixel
    patch = patch_context(score, grid, radius_m=100.0)
    assert patch[120, 120] > patch[10, 10]


def test_coarse_records_are_flagged_rather_than_excluded(config, grid):
    layers = uniform_layers(grid)
    result = score_area(config, layers)
    table, notes = select_candidates(config, grid, result, layers)
    assert any("NOT excluded" in note for note in notes)
    assert "within_coarse_record" in table.columns


def test_empty_shortlist_is_reported_not_faked(config, grid):
    config.candidates["min_score"] = 0.999999
    layers = uniform_layers(grid, sphagnum_flag=np.zeros(grid.shape))
    result = score_area(config, layers)
    table, notes = select_candidates(config, grid, result, layers)
    assert len(table) == 0
    assert any("min_score" in note for note in notes)
