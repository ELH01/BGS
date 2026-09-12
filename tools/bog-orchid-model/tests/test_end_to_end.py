"""One full run of the whole pipeline, on synthetic layers written to disk.

Deliberately goes through the real file formats and the real loader rather than
handing arrays straight to the scorer: it is the reprojection, rasterisation and
field-name resolution that break quietly when a dependency moves.
"""

from pathlib import Path

import numpy as np
import pytest
import rasterio

from bogorchid.config import load_config
from bogorchid.pipeline import run
from bogorchid.synthetic import write_demo_data

CONFIG = Path(__file__).resolve().parent.parent / "config.yaml"


@pytest.fixture(scope="module")
def completed_run(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("e2e")
    config = load_config(CONFIG)
    write_demo_data(config, tmp / "data")
    config.layers["sphagnum_classes"] = [3]
    return run(config, tmp / "data", tmp / "out", banner="TEST"), config, tmp


def test_every_declared_output_is_written(completed_run):
    result, _, _ = completed_run
    for name in ("raster", "map", "candidates", "report", "manifest"):
        assert result.outputs[name].exists(), name
        assert result.outputs[name].stat().st_size > 0, name


def test_raster_is_georeferenced_geotiff_in_british_national_grid(completed_run):
    result, config, _ = completed_run
    with rasterio.open(result.outputs["raster"]) as src:
        assert src.crs.to_string() == config.crs
        assert src.driver == "GTiff"
        assert abs(src.transform.a) == config.resolution_m
        data = src.read(1)
    valid = data[np.isfinite(data)]
    assert valid.size > 0
    assert valid.min() >= 0.0 and valid.max() <= 1.0


def test_filters_discard_the_majority_of_the_area(completed_run):
    """Step 1 of the brief: bounding to mire and flush should remove most ground."""
    result, _, _ = completed_run
    assert result.scoring.filter_stats["combined"]["percent_of_area"] < 100.0
    assert result.scoring.scored_cells < result.grid.width * result.grid.height


def test_candidate_table_has_the_columns_the_brief_asks_for(completed_run):
    result, _, _ = completed_run
    table = result.candidates
    assert len(table) > 0
    for column in ("grid_ref", "suitability_score", "distance_to_nearest_known_site_m"):
        assert column in table.columns
    assert table["grid_ref"].str.match(r"^S[XY] \d{5} \d{5}$").all()


def test_candidate_grid_references_match_their_coordinates(completed_run):
    from bogorchid.osgb import gridref_to_easting_northing

    result, _, _ = completed_run
    for _, row in result.candidates.iterrows():
        easting, northing = gridref_to_easting_northing(row["grid_ref"])
        assert abs(easting - row["easting"]) <= 1.0
        assert abs(northing - row["northing"]) <= 1.0


def test_report_and_manifest_record_what_was_actually_done(completed_run):
    import json

    result, _, _ = completed_run
    report = result.outputs["report"].read_text(encoding="utf-8")
    assert "Weights used" in report and "Verdict" in report
    manifest = json.loads(result.outputs["manifest"].read_text(encoding="utf-8"))
    assert sum(manifest["weights_used"].values()) == pytest.approx(1.0)
    assert manifest["provenance"]["priority_habitat"]["field"] == "Main_Habit"
    assert manifest["config_snapshot"]["variables"]["lateral_flow"]["weight"] == 0.30


def test_known_sites_rank_well_on_the_demo_landscape(completed_run):
    result, config, _ = completed_run
    assert result.calibration.passed, result.calibration.warnings
    for diagnostic in result.calibration.diagnostics:
        if diagnostic.site.use_for_calibration:
            assert diagnostic.percentile >= config.calibration["min_expected_percentile"]
