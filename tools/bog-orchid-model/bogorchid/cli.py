"""Command line interface."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from .config import ConfigError, load_config
from .sources import (
    acquire_source,
    format_preflight,
    preflight,
    probe_featureserver,
    source_path,
)

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.yaml"
DEFAULT_DATA = Path("data")
DEFAULT_OUT = Path("outputs")


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG, help="path to config.yaml")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA, help="input data directory")


def _report(result, out_dir: Path) -> None:
    print()
    for line in result.scoring.summary_lines():
        print("  " + line)
    print()
    if result.notes:
        print("  Notes:")
        for note in result.notes:
            print(f"    - {note}")
        print()
    calibration = result.calibration
    if calibration.passed:
        print("  CALIBRATION: PASS - known sites rank above the configured threshold.")
    else:
        print("  CALIBRATION: CHECK REQUIRED")
        for warning in calibration.warnings:
            print(f"    ! {warning}")
    print()
    print(f"  Candidates shortlisted: {len(result.candidates)}")
    if len(result.candidates):
        columns = ["rank", "grid_ref", "suitability_score", "distance_to_nearest_known_site_m"]
        print(result.candidates[columns].head(10).to_string(index=False))
    print()
    print("  Outputs:")
    for name, path in result.outputs.items():
        print(f"    {name:11s} {path}")


def cmd_preflight(args) -> int:
    config = load_config(args.config)
    statuses = preflight(config, args.data_dir)
    print(format_preflight(statuses))

    if args.probe:
        print("\nProbing auto sources:")
        for name, source in config.sources.items():
            if source.mode != "auto" or not source.url:
                continue
            print(f"\n  {name}: {source.url}")
            try:
                info = probe_featureserver(source.url)
            except Exception as exc:
                print(f"    UNREACHABLE: {exc}")
                continue
            print(f"    layer '{info['name']}' ({info['geometryType']}), "
                  f"maxRecordCount={info['maxRecordCount']}")
            print("    fields: " + ", ".join(f["name"] for f in info["fields"]))

    if args.classes:
        import rasterio

        path = source_path(args.data_dir, config.source("peat_vegetation"))
        print(f"\nClass codes in {path}:")
        if not path.exists():
            print("  not present")
        else:
            with rasterio.open(path) as src:
                data = src.read(1, masked=True)
            values, counts = np.unique(data.compressed(), return_counts=True)
            for value, count in zip(values, counts):
                share = 100.0 * count / max(counts.sum(), 1)
                print(f"  {value:>8} {count:>12,} cells  ({share:5.2f}%)")
            print("\n  Set the Sphagnum-dominated code(s) in config.yaml under "
                  "`layers.sphagnum_classes`.")

    missing = [s for s in statuses if not s.present and not s.optional]
    return 1 if missing else 0


def cmd_acquire(args) -> int:
    config = load_config(args.config)
    names = [args.source] if args.source else list(config.sources)
    failures = 0
    for name in names:
        source = config.sources.get(name)
        if source is None:
            print(f"  unknown source {name!r}")
            failures += 1
            continue
        try:
            status = acquire_source(config, name, args.data_dir, overwrite=args.overwrite)
        except Exception as exc:
            print(f"  [FAIL] {name}: {exc}")
            failures += 1
            continue
        if status.mode == "manual" and not status.present:
            print(f"  [MANUAL] {name}: cannot be fetched automatically")
            for line in status.instructions.splitlines():
                print(f"           {line}")
        else:
            print(f"  [OK] {name}: {status.detail} -> {status.path}")
    return 1 if failures else 0


def cmd_run(args) -> int:
    from .pipeline import PipelineError, run

    config = load_config(args.config)
    try:
        result = run(config, args.data_dir, args.out_dir)
    except PipelineError as exc:
        print(f"\nCannot run: {exc}\n", file=sys.stderr)
        return 2
    _report(result, args.out_dir)
    return 0 if result.calibration.passed else 3


def cmd_demo(args) -> int:
    from .pipeline import run
    from .synthetic import BANNER, write_demo_data

    config = load_config(args.config)
    data_dir = Path(args.data_dir)
    print(f"Generating synthetic layers in {data_dir / 'raw'} ...")
    write_demo_data(config, data_dir, seed=args.seed)

    # The synthetic vegetation raster uses class 3 for Sphagnum-dominated bog.
    # For a real run this must be set in config.yaml from the actual peat map.
    config.layers["sphagnum_classes"] = [3]
    config.layers["peat_depth_scale_to_cm"] = 1.0

    header = (
        f"> **{BANNER}**\n>\n"
        "> This run used fictional terrain, peat, habitat, watercourse and geology\n"
        "> layers generated by `bogorchid.synthetic`, because the real datasets\n"
        "> could not be reached. It demonstrates that the pipeline runs and that the\n"
        "> weighting behaves as intended. It is not a statement about real ground and\n"
        "> no site in it should be visited on its strength."
    )
    result = run(
        config, data_dir, args.out_dir,
        banner=BANNER,
        title="DEMONSTRATION - Bog orchid habitat suitability (synthetic data)",
        header_note=header,
    )
    if len(result.candidates):
        path = result.outputs["candidates"]
        body = path.read_text(encoding="utf-8")
        path.write_text(f"# {BANNER}\n{body}", encoding="utf-8")
    _report(result, args.out_dir)
    print(f"  NOTE: {BANNER}\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m bogorchid",
        description=(
            "Bog orchid (Hammarbya paludosa) habitat suitability model for Dartmoor. "
            "An expert-weighted index calibrated against known records - not a "
            "statistically fitted species distribution model."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    p = subparsers.add_parser("preflight", help="report which input layers are present")
    _add_common(p)
    p.add_argument("--probe", action="store_true", help="query auto sources for their schema")
    p.add_argument("--classes", action="store_true",
                   help="list class codes in the peat vegetation raster")
    p.set_defaults(func=cmd_preflight)

    p = subparsers.add_parser("acquire", help="download the automatically fetchable layers")
    _add_common(p)
    p.add_argument("--source", help="fetch only this source")
    p.add_argument("--overwrite", action="store_true")
    p.set_defaults(func=cmd_acquire)

    p = subparsers.add_parser("run", help="run the model on real data")
    _add_common(p)
    p.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    p.set_defaults(func=cmd_run)

    p = subparsers.add_parser(
        "demo", help="generate synthetic layers and run the model on them"
    )
    _add_common(p)
    p.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    p.add_argument("--seed", type=int, default=20240912)
    p.set_defaults(func=cmd_demo)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as exc:
        print(f"\nConfiguration error: {exc}\n", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
