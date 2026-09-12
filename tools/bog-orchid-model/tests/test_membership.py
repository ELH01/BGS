import numpy as np
import pytest

from bogorchid.membership import build_curve


def test_trapezoid_shape():
    curve = build_curve({"type": "trapezoid", "a": 1.0, "b": 2.0, "c": 4.0, "d": 5.0})
    values = curve(np.array([0.0, 1.0, 1.5, 2.0, 3.0, 4.0, 4.5, 5.0, 9.0]))
    assert np.allclose(values, [0, 0, 0.5, 1, 1, 1, 0.5, 0, 0])


def test_trapezoid_penalises_both_extremes():
    """The ecological point of the wetness curve: wettest is not best."""
    curve = build_curve({"type": "trapezoid", "a": 4.0, "b": 6.5, "c": 9.5, "d": 13.0})
    assert curve(np.array([16.0]))[0] == 0.0     # a standing pool
    assert curve(np.array([8.0]))[0] == 1.0      # a throughflow flush
    assert curve(np.array([2.0]))[0] == 0.0      # dry ground


def test_ramp_and_decay_are_monotonic():
    ramp = build_curve({"type": "ramp", "lo": 0.0, "hi": 10.0})
    decay = build_curve({"type": "decay", "lo": 0.0, "hi": 10.0})
    x = np.linspace(-5, 15, 41)
    assert np.all(np.diff(ramp(x)) >= 0)
    assert np.all(np.diff(decay(x)) <= 0)


def test_categorical_uses_default_for_unlisted_codes():
    curve = build_curve(
        {"type": "categorical", "mapping": {1: 0.75, 3: 1.0}, "default": 0.7}
    )
    assert np.allclose(curve(np.array([1.0, 3.0, 99.0])), [0.75, 1.0, 0.7])


def test_boolean_scores_absence_without_zeroing_it():
    curve = build_curve({"type": "boolean", "true_score": 1.0, "false_score": 0.25})
    assert np.allclose(curve(np.array([1.0, 0.0])), [1.0, 0.25])


def test_rejects_unknown_type_and_bad_parameters():
    with pytest.raises(ValueError):
        build_curve({"type": "sigmoid", "k": 1})
    with pytest.raises(ValueError):
        build_curve({"type": "trapezoid", "a": 5, "b": 4, "c": 3, "d": 2})
    with pytest.raises(ValueError):
        build_curve({"type": "gaussian", "mu": 0, "sigma": 0})
    with pytest.raises(ValueError):
        build_curve({"a": 1})
