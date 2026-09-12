"""Synthetic stand-in layers, for exercising the pipeline without the real data.

THIS GENERATES FICTIONAL TERRAIN. It exists so that the whole chain - read,
reproject, derive, filter, weight, calibrate, rank, render - can be run and
tested end to end in an environment that cannot reach the Natural England,
Environment Agency, BGS and Ordnance Survey download services.

Nothing produced from these layers is a statement about real ground. Outputs of
a demo run are stamped as such, in the map banner, the report and the CSV.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .config import Config
from .raster import ModelGrid, grid_from_bounds, write_raster
from .sources import raw_dir, source_path

# A 9 x 7 km window of northern Dartmoor containing both precise records.
DEMO_BOUNDS = (259000.0, 85500.0, 268000.0, 92500.0)

BANNER = "SYNTHETIC DEMONSTRATION DATA - NOT A REAL RESULT"


def _smooth_noise(shape, rng, sigma, octaves=4, decay=0.5):
    """Sum of Gaussian-smoothed white noise at successively finer scales."""
    from scipy import ndimage

    field = np.zeros(shape, dtype="float64")
    amplitude = 1.0
    for octave in range(octaves):
        noise = rng.normal(0.0, 1.0, shape)
        smoothed = ndimage.gaussian_filter(noise, sigma / (2**octave))
        spread = smoothed.std() or 1.0
        field += amplitude * smoothed / spread
        amplitude *= decay
    return field / (field.std() or 1.0)


def _channel_distance(grid: ModelGrid, lines):
    from shapely.geometry import LineString

    from .raster import distance_to_geometries

    return distance_to_geometries([LineString(line) for line in lines], grid, margin_m=1500)


def _coordinate_grids(grid: ModelGrid):
    """Easting/northing of every cell centre."""
    minx, _, _, maxy = grid.bounds
    x = minx + (np.arange(grid.width) + 0.5) * grid.resolution
    y = maxy - (np.arange(grid.height) + 0.5) * grid.resolution
    return np.meshgrid(x, y)


def _impose_flush_swales(elevation, grid: ModelGrid, sites, rng):
    """Carve a shallow valley-mire swale at each calibration site.

    The fictional landscape has no reason to put mire at the real grid
    references, so without this the demo cannot exercise the path where
    calibration succeeds. What is imposed is TERRAIN - a gently graded, concave
    hollow with a catchment above it - and everything downstream (peat depth,
    vegetation class, Priority Habitat polygons, flow accumulation, TWI and
    therefore the score) is still derived from that terrain by the ordinary
    code. The score is never written at these locations, only the ground it is
    computed from.
    """
    from scipy import ndimage

    eastings, northings = _coordinate_grids(grid)
    regional = ndimage.gaussian_filter(elevation, 30)

    # This landscape falls to the north, so "upslope" of a record is southward.
    catchment_length = 550.0   # how far the hollow extends upslope of the record
    half_width = 170.0         # half-width of the hollow
    edge_taper = 130.0         # how abruptly it blends into the surrounding hill
    along_fall = 0.042         # gradient along the hollow floor (~2.4 degrees)
    concavity = 5.0e-4         # cross-sectional curvature; converges flow to the axis

    for site in sites:
        if not grid.contains(site.easting, site.northing):
            continue
        row, col = grid.rowcol(site.easting, site.northing)
        base = float(regional[row, col])

        dx = eastings - site.easting
        dy = northings - site.northing

        # Flat-topped along the hollow's length: full weight from the record
        # itself to `catchment_length` upslope of it, tapering outside that.
        # A Gaussian centred upslope would leave the record only partly treated,
        # which is exactly what gave it no catchment on the first attempt.
        upslope = np.clip(-dy, 0.0, None)
        along = np.exp(-np.clip(upslope - catchment_length, 0.0, None) ** 2
                       / (2 * edge_taper**2))
        along *= np.exp(-np.clip(dy, 0.0, None) ** 2 / (2 * edge_taper**2))
        across = np.exp(-np.clip(np.abs(dx) - half_width, 0.0, None) ** 2
                        / (2 * edge_taper**2))
        weight = along * across

        target = base - along_fall * dy + concavity * np.clip(np.abs(dx), 0, 400.0) ** 2
        elevation = elevation * (1.0 - weight) + target * weight

    return elevation + 0.08 * _smooth_noise(elevation.shape, rng, sigma=4.0, octaves=1)


def _demo_channels() -> list[list[tuple[float, float]]]:
    """Fictional watercourses, laid out to pass near both known records."""
    return [
        # A north-flowing river past the Steeperton-analogue site.
        [(262100, 85700), (262250, 87200), (262500, 88600), (262700, 90200), (262400, 92300)],
        # A tributary joining it from the east, heading up past the Raybarrow analogue.
        [(265400, 91800), (264900, 90600), (264000, 90000), (263200, 89400), (262600, 89100)],
        # A separate catchment in the south-east.
        [(266800, 85800), (266200, 87400), (265600, 88900), (265200, 90400)],
        # A western stream.
        [(260200, 86200), (260500, 88000), (260900, 90100), (261300, 92200)],
    ]


def build_layers(config: Config, seed: int = 20240912):
    """Generate the synthetic rasters and vectors as in-memory objects."""
    import geopandas as gpd
    from shapely.geometry import LineString, box, shape

    rng = np.random.default_rng(seed)
    grid = grid_from_bounds(DEMO_BOUNDS, config.resolution_m, config.crs)
    rows, cols = grid.shape

    # -- terrain ---------------------------------------------------------
    # Broad upland mass falling to the north, plus tors and shallow basins.
    y_norm = np.linspace(0.0, 1.0, rows).reshape(-1, 1)
    x_norm = np.linspace(0.0, 1.0, cols).reshape(1, -1)
    base = 430.0 + 90.0 * y_norm - 40.0 * np.sin(np.pi * x_norm)
    base = base + 45.0 * _smooth_noise((rows, cols), rng, sigma=45.0, octaves=4)

    channels = _demo_channels()
    channel_distance = _channel_distance(grid, channels)
    # Incise valleys: a smooth trough centred on each channel.
    trough = 34.0 * np.exp(-(channel_distance**2) / (2 * 170.0**2))
    elevation = base - trough + 1.2 * _smooth_noise((rows, cols), rng, sigma=6.0, octaves=2)

    from scipy import ndimage

    elevation = ndimage.gaussian_filter(elevation, 1.4)
    elevation = _impose_flush_swales(elevation, grid, config.calibration_sites, rng)
    elevation = ndimage.gaussian_filter(elevation, 1.2)

    # -- peat depth ------------------------------------------------------
    from . import terrain as terrain_module

    slope = terrain_module.slope_degrees(elevation, grid.resolution)
    peat = (
        150.0
        - 13.0 * slope
        - 0.035 * np.clip(channel_distance - 120.0, 0.0, None)
        + 18.0 * _smooth_noise((rows, cols), rng, sigma=25.0, octaves=3)
    )
    peat = np.clip(peat, 0.0, 340.0)
    peat[slope > 11.0] = 0.0

    # -- vegetation classes ----------------------------------------------
    # 1 dry heath, 2 Molinia, 3 Sphagnum-dominated bog, 4 acid grassland, 5 bare peat
    derived = terrain_module.derive_all(elevation, grid.resolution)
    twi = derived["twi"]
    vegetation = np.full((rows, cols), 4.0)
    vegetation[slope > 7.0] = 1.0
    vegetation[(twi > 7.0) & (slope <= 7.0)] = 2.0
    sphagnum_like = (
        (twi > 8.2) & (slope <= 5.0) & (peat > 55.0)
        & (_smooth_noise((rows, cols), rng, sigma=18.0, octaves=2) > -0.35)
    )
    vegetation[sphagnum_like] = 3.0
    vegetation[(peat > 45.0) & (slope > 9.0)] = 5.0

    # -- priority habitat polygons ---------------------------------------
    from rasterio import features as rio_features

    bog = (peat >= 45.0) & (slope <= 8.0)
    flush = (twi > 8.5) & (slope > 0.8) & (slope <= 9.0) & (peat >= 15.0)
    polygons: list[dict] = []
    for mask, habitat in ((bog, "Blanket Bog"), (flush, "Upland Flushes, Fens and Swamps")):
        cleaned = ndimage.binary_opening(mask, np.ones((3, 3)))
        for geom, value in rio_features.shapes(
            cleaned.astype("uint8"), mask=cleaned, transform=grid.transform
        ):
            if value:
                polygons.append({"geometry": shape(geom), "Main_Habit": habitat})
    priority_habitat = gpd.GeoDataFrame(polygons, crs=config.crs)

    rivers = gpd.GeoDataFrame(
        {"name": [f"Synthetic watercourse {i + 1}" for i in range(len(channels))]},
        geometry=[LineString(line) for line in channels],
        crs=config.crs,
    )

    # Dartmoor is granite with a metamorphic aureole; the aureole is the only
    # place the base-richness variable has anything to say.
    minx, miny, maxx, maxy = grid.bounds
    geology = gpd.GeoDataFrame(
        {"RCS_D": ["Granite", "Hornfels and calc-silicate rock"]},
        geometry=[
            box(minx, miny, maxx, maxy),
            box(maxx - 2600, miny + 400, maxx - 200, miny + 2600),
        ],
        crs=config.crs,
    )

    boundary = gpd.GeoDataFrame(
        {"NAME": ["Synthetic Dartmoor demo area"]},
        geometry=[box(minx + 200, miny + 200, maxx - 200, maxy - 200)],
        crs=config.crs,
    )

    return {
        "grid": grid,
        "elevation": elevation,
        "peat_depth_cm": peat,
        "vegetation": vegetation,
        "priority_habitat": priority_habitat,
        "rivers": rivers,
        "geology": geology,
        "boundary": boundary,
    }


def write_demo_data(config: Config, data_dir: str | Path, seed: int = 20240912) -> dict:
    """Write the synthetic layers to disk in the formats the pipeline expects.

    Writing real files, and reading them back through the ordinary loader, is
    the point: it exercises the reprojection, rasterisation and field-name
    resolution paths rather than bypassing them.
    """
    built = build_layers(config, seed=seed)
    grid: ModelGrid = built["grid"]
    target = raw_dir(data_dir)
    target.mkdir(parents=True, exist_ok=True)

    write_raster(source_path(data_dir, config.source("dtm")), built["elevation"], grid)
    write_raster(source_path(data_dir, config.source("peat")), built["peat_depth_cm"], grid)
    write_raster(
        source_path(data_dir, config.source("peat_vegetation")),
        built["vegetation"], grid, dtype="int16", nodata=-1,
    )
    built["priority_habitat"].to_file(
        source_path(data_dir, config.source("priority_habitat")), driver="GPKG"
    )
    built["rivers"].to_file(source_path(data_dir, config.source("rivers")), driver="GPKG")
    built["geology"].to_file(source_path(data_dir, config.source("geology")), driver="GPKG")
    built["boundary"].to_file(source_path(data_dir, config.source("boundary")), driver="GPKG")

    (target / "SYNTHETIC_DATA_README.txt").write_text(
        "These files are FICTIONAL, generated by bogorchid.synthetic for testing.\n"
        "They are not Environment Agency, Natural England, BGS or Ordnance Survey\n"
        "data and say nothing about real ground. Delete this directory before\n"
        "placing real downloads here.\n",
        encoding="utf-8",
    )
    return built
