import pytest

from bogorchid.osgb import (
    GridRefError,
    easting_northing_to_gridref,
    gridref_precision_m,
    gridref_to_easting_northing,
)


@pytest.mark.parametrize(
    "gridref,easting,northing",
    [
        ("SX 64524 90050", 264524, 90050),   # Raybarrow Pool area
        ("SX 62406 89005", 262406, 89005),   # Steeperton Brook
        ("SX625889", 262500, 88900),         # Flora of Devon, 100 m precision
        ("SX 6 8", 260000, 80000),           # the hectad SX68, SW corner
        ("SX 69 78", 269000, 78000),         # Webburn valley, 1 km
        ("TQ 00000 00000", 500000, 100000),  # a 100 km square origin elsewhere
    ],
)
def test_parses_to_south_west_corner(gridref, easting, northing):
    assert gridref_to_easting_northing(gridref) == (easting, northing)


def test_round_trip_is_exact_at_one_metre():
    for easting, northing in [(264524, 90050), (262406, 89005), (250001, 52999)]:
        gridref = easting_northing_to_gridref(easting, northing)
        assert gridref_to_easting_northing(gridref) == (easting, northing)


def test_centre_offsets_by_half_the_square():
    # SX68 is a 10 km square; its centre is 5 km in from the corner.
    assert gridref_to_easting_northing("SX 6 8", centre=True) == (265000, 85000)
    assert gridref_to_easting_northing("SX 69 78", centre=True) == (269500, 78500)


def test_formatting_truncates_rather_than_rounds():
    # A grid reference names the square a point is in, so it must never round up
    # into the neighbouring square.
    assert easting_northing_to_gridref(264529, 90059, digits=6) == "SX 645 900"


def test_precision_reflects_digit_count():
    assert gridref_precision_m("SX 64524 90050") == 1
    assert gridref_precision_m("SX625889") == 100
    assert gridref_precision_m("SX 6 8") == 10000


@pytest.mark.parametrize("bad", ["SI 123 456", "SX 123 45", "XX", "SX 12345", ""])
def test_rejects_malformed_references(bad):
    with pytest.raises(GridRefError):
        gridref_to_easting_northing(bad)


def test_rejects_coordinates_off_the_grid():
    with pytest.raises(GridRefError):
        easting_northing_to_gridref(-5000, 90050)
