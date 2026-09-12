from pathlib import Path

import pytest
import yaml

from bogorchid.config import ConfigError, load_config, normalised_weights

CONFIG = Path(__file__).resolve().parent.parent / "config.yaml"


def write(tmp_path, data):
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    return path


@pytest.fixture
def base():
    return yaml.safe_load(CONFIG.read_text(encoding="utf-8"))


def test_shipped_config_is_valid():
    config = load_config(CONFIG)
    assert config.crs == "EPSG:27700"
    assert len(config.calibration_sites) >= 2
    assert {v.name for v in config.enabled_variables} >= {
        "sphagnum", "lateral_flow", "wetness", "watercourse_proximity"
    }


def test_shipped_weights_match_the_brief():
    """The brief specifies the relative emphasis; guard against silent drift."""
    config = load_config(CONFIG)
    weights = {v.name: v.weight for v in config.enabled_variables}
    assert weights["lateral_flow"] > weights["sphagnum"] > weights["wetness"]
    assert weights["wetness"] == weights["watercourse_proximity"]
    assert weights["geology"] == min(weights.values())


def test_weights_renormalise_to_one():
    config = load_config(CONFIG)
    normalised = normalised_weights(config.enabled_variables)
    assert sum(normalised.values()) == pytest.approx(1.0)
    subset = [v for v in config.enabled_variables if v.name != "geology"]
    assert sum(normalised_weights(subset).values()) == pytest.approx(1.0)


def test_coarse_reference_cannot_declare_false_precision(base, tmp_path):
    base["known_sites"] = [
        {"name": "vague", "grid_ref": "SX 6 8", "precision_m": 1,
         "use_for_calibration": True}
    ]
    config = load_config(write(tmp_path, base))
    assert config.known_sites[0].precision_m == 10000


def test_rejects_config_with_no_calibration_site(base, tmp_path):
    for site in base["known_sites"]:
        site["use_for_calibration"] = False
    with pytest.raises(ConfigError, match="use_for_calibration"):
        load_config(write(tmp_path, base))


def test_rejects_negative_weight(base, tmp_path):
    base["variables"]["wetness"]["weight"] = -0.5
    with pytest.raises(ConfigError, match="negative"):
        load_config(write(tmp_path, base))


def test_rejects_unknown_curve_type(base, tmp_path):
    base["variables"]["wetness"]["curve"] = {"type": "wishful"}
    with pytest.raises(ConfigError, match="unknown curve type"):
        load_config(write(tmp_path, base))


def test_rejects_unknown_scoring_method(base, tmp_path):
    base["scoring"]["method"] = "vibes"
    with pytest.raises(ConfigError, match="scoring.method"):
        load_config(write(tmp_path, base))


def test_rejects_all_variables_disabled(base, tmp_path):
    for variable in base["variables"].values():
        variable["weight"] = 0.0
    with pytest.raises(ConfigError, match="positive weight"):
        load_config(write(tmp_path, base))


def test_rejects_degenerate_bbox(base, tmp_path):
    base["project"]["study_area_bbox"] = [284000, 98000, 248000, 52000]
    with pytest.raises(ConfigError, match="degenerate"):
        load_config(write(tmp_path, base))
