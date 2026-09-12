"""British National Grid (EPSG:27700) reference parsing and formatting.

Pure standard library: the grid-letter arithmetic is self-contained so that grid
references can be read from config and written into the candidate table without
depending on the geospatial stack.
"""

from __future__ import annotations

import re

# The National Grid letter alphabet omits 'I'.
_ALPHABET = "ABCDEFGHJKLMNOPQRSTUVWXYZ"

_GRIDREF_RE = re.compile(
    r"^\s*([A-Za-z]{2})\s*([0-9]+(?:\.[0-9]+)?)\s+?([0-9]+(?:\.[0-9]+)?)\s*$"
)
_GRIDREF_COMPACT_RE = re.compile(r"^\s*([A-Za-z]{2})\s*([0-9]+)\s*$")


class GridRefError(ValueError):
    """Raised when a grid reference cannot be interpreted."""


def easting_northing_to_gridref(easting: float, northing: float, digits: int = 10) -> str:
    """Format an EPSG:27700 coordinate as a lettered grid reference.

    ``digits`` is the total number of digits (5 per axis for a 1 m reference,
    which is what ``SX 64524 90050`` is).
    """
    if digits % 2 or not 2 <= digits <= 12:
        raise GridRefError(f"digits must be an even number between 2 and 12, got {digits}")

    e100k, n100k = int(easting // 100_000), int(northing // 100_000)
    if not (0 <= e100k < 7 and 0 <= n100k < 14):
        raise GridRefError(
            f"coordinate ({easting:.1f}, {northing:.1f}) falls outside the National Grid"
        )

    # Standard OS index arithmetic for the 500 km and 100 km square letters.
    first = (19 - n100k) - (19 - n100k) % 5 + (e100k + 10) // 5
    second = (19 - n100k) * 5 % 25 + e100k % 5
    letters = _ALPHABET[first] + _ALPHABET[second]

    per_axis = digits // 2
    # Truncate (do not round) towards the south-west corner, as OS references do.
    divisor = 10 ** (5 - per_axis)
    e = int((easting % 100_000) // divisor)
    n = int((northing % 100_000) // divisor)
    return f"{letters} {e:0{per_axis}d} {n:0{per_axis}d}"


def gridref_to_easting_northing(gridref: str, centre: bool = False) -> tuple[float, float]:
    """Parse a lettered grid reference into EPSG:27700 metres.

    By default returns the south-west corner of the referenced square, which is
    what a grid reference literally denotes. ``centre=True`` returns the middle
    of the square instead — the right choice for a low-precision record such as
    a 1 km ``SX6978``, where the corner would bias the point south-west.
    """
    text = gridref.strip()
    match = _GRIDREF_RE.match(text)
    if match:
        letters, e_str, n_str = match.groups()
    else:
        compact = _GRIDREF_COMPACT_RE.match(text)
        if not compact:
            raise GridRefError(f"could not parse grid reference {gridref!r}")
        letters, digits_str = compact.groups()
        if len(digits_str) % 2:
            raise GridRefError(
                f"grid reference {gridref!r} has an odd number of digits"
            )
        half = len(digits_str) // 2
        e_str, n_str = digits_str[:half], digits_str[half:]

    letters = letters.upper()
    if len(e_str) != len(n_str):
        raise GridRefError(
            f"grid reference {gridref!r} has mismatched easting/northing precision"
        )
    try:
        first = _ALPHABET.index(letters[0])
        second = _ALPHABET.index(letters[1])
    except ValueError as exc:  # 'I' or a non-letter
        raise GridRefError(f"invalid National Grid letters {letters!r}") from exc

    e100k = ((first - 2) % 5) * 5 + (second % 5)
    n100k = (19 - (first // 5) * 5) - (second // 5)
    if not (0 <= e100k < 7 and 0 <= n100k < 14):
        raise GridRefError(f"grid letters {letters!r} are outside the National Grid")

    per_axis = len(e_str)
    multiplier = 10 ** (5 - per_axis)
    easting = e100k * 100_000 + float(e_str) * multiplier
    northing = n100k * 100_000 + float(n_str) * multiplier
    if centre:
        easting += multiplier / 2
        northing += multiplier / 2
    return easting, northing


def gridref_precision_m(gridref: str) -> float:
    """Size, in metres, of the square a grid reference denotes."""
    text = gridref.strip()
    digits = sum(c.isdigit() for c in text)
    if digits % 2:
        raise GridRefError(f"grid reference {gridref!r} has an odd number of digits")
    return float(10 ** (5 - digits // 2))
