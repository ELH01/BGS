"""Rendering the suitability surface to a reviewable map."""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LightSource
from matplotlib.lines import Line2D

from .config import Config
from .raster import ModelGrid
from .score import ScoringResult


def _scale_bar(ax, grid: ModelGrid) -> None:
    minx, miny, maxx, maxy = grid.bounds
    span = maxx - minx
    for candidate in (20000, 10000, 5000, 2000, 1000, 500, 200):
        if candidate <= span * 0.3:
            length = candidate
            break
    else:  # pragma: no cover - only for absurdly small extents
        length = span * 0.25
    x0 = minx + span * 0.05
    y0 = miny + (maxy - miny) * 0.05
    height = (maxy - miny) * 0.008
    ax.add_patch(
        plt.Rectangle((x0, y0), length, height, facecolor="black", edgecolor="black", zorder=6)
    )
    ax.text(
        x0 + length / 2,
        y0 + height * 3.0,
        f"{length / 1000:g} km" if length >= 1000 else f"{length:g} m",
        ha="center",
        va="bottom",
        fontsize=8,
        zorder=6,
    )


def render_map(
    path: str | Path,
    config: Config,
    grid: ModelGrid,
    result: ScoringResult,
    layers: dict[str, np.ndarray],
    candidates=None,
    title: str = "Bog orchid (Hammarbya paludosa) habitat suitability - Dartmoor",
    banner: str = "",
    attribution: str = "",
) -> Path:
    """Write a PNG of the suitability surface with known sites and candidates."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    minx, miny, maxx, maxy = grid.bounds
    extent = (minx, maxx, miny, maxy)
    aspect = (maxy - miny) / max(maxx - minx, 1.0)
    width = 11.0
    # The image keeps a 1:1 aspect, so size the figure to the axes box the data
    # will actually occupy (~80% of the width, the rest being the colourbar);
    # sizing to the full width leaves a band of white above and below the map.
    axes_width = width * 0.80
    height = max(5.0, min(18.0, axes_width * aspect + 1.5 + (0.4 if banner else 0.0)))
    fig, ax = plt.subplots(figsize=(width, height))

    # Hillshaded terrain as context, so the reader can see that the high-scoring
    # ground really is in valley mires and flushes.
    elevation = layers.get("elevation_m")
    if elevation is not None and np.isfinite(elevation).any():
        filled = np.where(np.isfinite(elevation), elevation, np.nanmin(elevation))
        shade = LightSource(azdeg=315, altdeg=45).hillshade(
            filled, vert_exag=2.0, dx=grid.resolution, dy=grid.resolution
        )
        ax.imshow(shade, cmap="gray", extent=extent, origin="upper", alpha=0.55, zorder=1)

    masked = np.ma.masked_invalid(result.score)
    image = ax.imshow(
        masked,
        cmap="magma",
        extent=extent,
        origin="upper",
        vmin=0.0,
        vmax=1.0,
        alpha=0.92,
        zorder=2,
        interpolation="nearest",
    )

    handles: list[Line2D] = []
    # Only list sites that actually fall in the rendered extent, so the legend
    # does not promise a marker the reader will hunt for and never find.
    visible = [s for s in config.known_sites if grid.contains(s.easting, s.northing)]
    calibration = [s for s in visible if s.use_for_calibration]
    reference = [s for s in visible if not s.use_for_calibration]

    if calibration:
        ax.scatter(
            [s.easting for s in calibration],
            [s.northing for s in calibration],
            s=170, marker="*", facecolor="#00e5ff", edgecolor="black",
            linewidth=0.9, zorder=5,
        )
        handles.append(
            Line2D([], [], marker="*", color="none", markerfacecolor="#00e5ff",
                   markeredgecolor="black", markersize=15,
                   label="Known record (used for calibration)")
        )
    if reference:
        ax.scatter(
            [s.easting for s in reference],
            [s.northing for s in reference],
            s=110, marker="P", facecolor="#9fe870", edgecolor="black",
            linewidth=0.9, zorder=5,
        )
        handles.append(
            Line2D([], [], marker="P", color="none", markerfacecolor="#9fe870",
                   markeredgecolor="black", markersize=11,
                   label="Known record (imprecise / historic)")
        )

    if candidates is not None and len(candidates):
        ax.scatter(
            candidates["easting"], candidates["northing"],
            s=42, marker="o", facecolor="none", edgecolor="#00ff9c",
            linewidth=1.3, zorder=4,
        )
        top = candidates.head(10)
        for _, row in top.iterrows():
            ax.annotate(
                str(int(row["rank"])),
                (row["easting"], row["northing"]),
                textcoords="offset points", xytext=(5, 4),
                fontsize=7, color="#00ff9c", zorder=6,
            )
        handles.append(
            Line2D([], [], marker="o", color="none", markerfacecolor="none",
                   markeredgecolor="#00ff9c", markersize=9,
                   label=f"Candidate site (top {len(candidates)}, ranked)")
        )

    ax.set_xlim(minx, maxx)
    ax.set_ylim(miny, maxy)
    ax.set_xlabel("Easting (EPSG:27700)", fontsize=9)
    ax.set_ylabel("Northing (EPSG:27700)", fontsize=9)
    ax.ticklabel_format(style="plain")
    ax.tick_params(labelsize=8)
    ax.set_title(title, fontsize=13, pad=14)
    ax.set_facecolor("#dcdcdc")

    if handles:
        ax.legend(handles=handles, loc="upper right", fontsize=8, framealpha=0.9)

    colorbar = fig.colorbar(image, ax=ax, fraction=0.035, pad=0.02)
    colorbar.set_label("Habitat suitability index (0-1)", fontsize=9)
    colorbar.ax.tick_params(labelsize=8)

    _scale_bar(ax, grid)
    ax.annotate(
        "N\n^", xy=(0.965, 0.10), xycoords="axes fraction",
        ha="center", va="bottom", fontsize=10, fontweight="bold",
    )

    footer = attribution or (
        "Expert-weighted habitat suitability index. Grey = excluded by hard filters "
        "(outside mire/flush Priority Habitat, or no peat)."
    )
    fig.text(0.01, 0.012, footer, fontsize=7.5, va="bottom", ha="left", color="#333333")

    if banner:
        fig.text(
            0.5, 0.992, banner,
            ha="center", va="top", fontsize=11, fontweight="bold", color="white",
            bbox={"facecolor": "#b00020", "edgecolor": "none", "pad": 6.0},
            zorder=10,
        )

    fig.tight_layout(rect=(0, 0.03, 1, 0.965 if banner else 1.0))
    fig.savefig(path, dpi=170)
    plt.close(fig)
    return path
