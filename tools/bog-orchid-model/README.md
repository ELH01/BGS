# Bog orchid (*Hammarbya paludosa*) habitat suitability model — Dartmoor

Finds ground on Dartmoor that matches the documented ecology of the bog orchid,
to prioritise field survey. Outputs a suitability raster, a rendered map, and a
ranked shortlist of candidate sites.

**This is a fieldwork-prioritisation tool, not a statistically validated
probability model.** Its value comes from how faithfully it encodes the
species' documented ecology, not from statistical power. Read
[What this model is not](#what-this-model-is-not) before using the output.

---

## Why not a species distribution model

There are two precise Dartmoor records. Two points cannot fit a MaxEnt or
similar model: it would overfit to coincidental features of those exact
locations and report high confidence in the result. Worse, absence of records
elsewhere on the moor almost certainly reflects under-recording rather than
unsuitability — *H. paludosa* is small, green, and easily missed — so the
"background" a presence-only model would train against is not trustworthy
either.

So this is an **expert-knowledge-weighted suitability index**. The weights come
from the species' documented ecology; the known records are used only to
**calibrate and falsify** the result, never to train it. If a known population
does not score well above the moor-wide average, the run says so loudly and you
should not trust the map until the weights are fixed.

## How the ecology maps onto the model

Source: [BSBI species account](https://bsbi.org/learn/resources/species-accounts/hammarbya-paludosa),
corroborated by the *Biological Flora of Britain and Ireland* account
(Tatarenko et al. 2022, *Journal of Ecology*).

| Documented fact | How it is encoded | Weight |
|---|---|---|
| Boggy ground with **lateral flow of water**, not standing water | `lateral_flow` — flow accumulation **×** gentle-to-moderate slope, as a product so both must hold. Flat ground is penalised: zero slope is pooling, not throughflow | **0.30** |
| On the **margins of *Sphagnum* hummocks**, or open moist peat | `sphagnum` — Sphagnum-dominated flag from the England Peat Map. Absence scores 0.25, not 0, because the species also occurs on bare moist peat and the vegetation layer is modelled, not surveyed | **0.25** |
| Not in the wettest pools | `wetness` — TWI as a **trapezoid**, so peak wetness scores *below* mid-range. The upper shoulder is the important half of the curve | 0.15 |
| Flush-fed, associated with runnels | `watercourse_proximity` — distance to OS Open Rivers, near-but-not-on | 0.15 |
| Acidic infertile peat, **occasionally** moderately base-rich flushes | `geology` — a soft nudge, not a filter. Acid ground still scores 0.75; base-rich gets a small lift | 0.05 |
| Up to c.500 m in Britain, but not Dartmoor-specific | `elevation` — band **derived empirically** from the known records at run time, deliberately widened, low weight | 0.10 |
| NVC **M1** / **M21** communities | `nvc` — strong weight if survey data can be obtained; disabled by default | (0.25) |
| Acidic, extremely infertile **peat** | Hard filter: peat ≥ 10 cm | filter |
| Confined to mire and flush habitat | Hard filter: within Priority Habitat *Blanket Bog* or *Upland Flushes, Fens and Swamps*, buffered 50 m | filter |

Why flow-accumulation × slope rather than TWI alone: TWI on its own flags flat
pooling hollows, which is the opposite of what this species wants. Combining
upslope contributing area with a *gentle but non-zero* gradient targets
throughflow instead. TWI is kept as a separate, mid-range-preferring term.

Everything above lives in [`config.yaml`](config.yaml), with the ecological
justification written next to each number. **The config is the model.** Re-tune
it, re-run, and compare the calibration report; nothing is hidden in code.

## Known records

| Site | Grid ref | Precision | Last seen | Role |
|---|---|---|---|---|
| Raybarrow Pool area | SX 64524 90050 | 10 m | — | calibration |
| Steeperton Brook | SX 62406 89005 | 10 m | 1998 | calibration |
| Unnamed SX68 site | SX68 | **10 km** | 2012 | reference only |
| Webburn Valley below Blackaton Tor | SX6978 | 1 km | 1938 | reference only |

The first two were supplied with the brief. **The other two were found during
this work** in *A New Flora of Devon* and were not in the original brief:

- Steeperton Brook matches the Flora's "SX625889" (N. Baldock 1984; six plants
  1997, five 1998, W.H. Tucker) to within ~155 m — same locality.
- The **SX68 site is a separate, recently monitored population**: recorded
  annually from 1994, maximum 25 plants in 2000 "scattered over more than one
  flush" (R.D. Hutchings & R. Avery), five plants 2009, six in 2011 and 2012.
  Only the 10 km square is published, which is far too coarse to calibrate
  against. **Getting its precise grid reference from the BSBI Distribution
  Database or the Devon Biodiversity Records Centre is the single
  highest-value input still missing from this model.**
- The 1938 Webburn Valley record is historic and probably lost, but an
  eastern-Dartmoor locality widens the envelope worth considering.

Records too coarse to localise are **flagged, not excluded**: excluding a 10 km
square would discard most of the moor. Candidates falling inside one carry it
in the `within_coarse_record` column — one of them may simply *be* that site.

## Installing

```bash
pip install -r requirements.txt
```

## Getting the data

```bash
python -m bogorchid preflight            # what is present, what is missing, where to get it
python -m bogorchid preflight --probe    # query the ArcGIS services for their current schema
python -m bogorchid acquire              # fetch what can be fetched unattended
```

`preflight` prints a download instruction for every missing layer. Two layers
can be fetched automatically (Natural England ArcGIS FeatureServer, paged);
the rest are portal downloads behind a form or licence click-through.

| Layer | Source | Licence | Role |
|---|---|---|---|
| Priority Habitats Inventory | Natural England ArcGIS FeatureServer | OGL | Hard filter — bounds the search to mire/flush |
| National Park boundary | Natural England ArcGIS FeatureServer | OGL | Study area |
| Peat depth + vegetation | [England Peat Map (NERR149, 2025)](https://england-peat-map-portal-ncea.hub.arcgis.com/) | OGL | Hard filter + Sphagnum flag |
| LIDAR Composite DTM 1 m (2 m fallback) | [EA Survey Open Data](https://environment.data.gov.uk/survey) | OGL | Slope, flow accumulation, TWI |
| OS Open Rivers | [OS OpenData](https://osdatahub.os.uk/downloads/open/OpenRivers) | OGL | Distance to watercourse |
| BGS bedrock geology | [BGS OpenGeoscience](https://www.bgs.ac.uk/datasets/bgs-geology-625k-digmapgb-625/) | check terms | Base-richness proxy (optional) |
| NVC survey data | Enquire: Natural England / Dartmoor NPA | by agreement | M1/M21 match (optional, off by default) |

**Two things must be checked against the real data before trusting any output:**

1. `layers.sphagnum_classes` — the England Peat Map vegetation class codes that
   count as Sphagnum-dominated. Run `python -m bogorchid preflight --classes` to
   list the codes actually in the raster, then set them. Until you do, the
   `sphagnum` variable (joint-heaviest in the model) is **dropped** and its
   weight redistributed, with a warning.
2. `layers.peat_depth_scale_to_cm` — the peat depth threshold is in centimetres.

## Running

```bash
python -m bogorchid run                  # real data in ./data/raw, outputs to ./outputs
python -m bogorchid demo                 # synthetic data, to see the pipeline work
```

Exit codes: `0` success, `2` cannot run (missing data or bad config), `3` ran
but **calibration failed** — outputs were written, and should not be trusted.

### Outputs

| File | Contents |
|---|---|
| `suitability.tif` | Suitability raster, EPSG:27700, 0–1, no-data where filtered out |
| `suitability_map.png` | Rendered map: suitability over hillshade, known sites, top candidates |
| `candidates.csv` | Ranked shortlist — grid ref, score, distance to nearest known site, every environmental value, and each variable's membership so you can see *why* a cell ranks where it does |
| `calibration_report.md` | **Read this first.** Filters, weights actually used, derived elevation band, per-site diagnostics, and a pass/fail verdict |
| `run_manifest.json` | Full config snapshot and provenance, so a map can be traced back to the run that made it |

### Tuning

Edit `config.yaml`, re-run, compare `calibration_report.md`. Useful knobs:

- `scoring.method: weighted_geometric` — limiting-factor behaviour, where any
  one variable scoring near zero drags the whole cell down. Arguably truer for a
  species this habitat-specific than the forgiving arithmetic default.
- `hard_filters.priority_habitat.buffer_m` — raise it if known sites fall just
  outside PHI polygons (their edges are generalised from OS MasterMap and do not
  follow the true mire margin).
- `candidates.min_separation_m` — how far apart shortlisted sites must be.

## Running the tests

```bash
python -m pytest tests/ -q      # 83 tests, ~10s
```

The suite encodes the ecological claims as assertions — that standing water
scores below throughflow, that peak wetness does not score highest, that acid
ground stays viable, that a known site failing the filters fails calibration —
so a later change to the weights that breaks one of them fails loudly.

## What this model is not

- **Not a probability.** A score of 0.9 does not mean a 90% chance of finding
  the species. It means the ground matches the documented habitat description
  well. Use it to order survey effort, nothing more.
- **Not validated.** With two precise records, calibration can only falsify the
  model, never confirm it. Passing calibration means the weights reproduce
  ground the species is known from — it is no evidence the model is right
  anywhere else.
- **Not a dispersal or connectivity model.** By design. *H. paludosa* disperses
  poorly and habitat fragmentation has severely limited colonisation, so
  suitable-but-unoccupied habitat is the expected case, not an anomaly.
- **Only as good as its inputs.** The England Peat Map vegetation layer is
  modelled by machine learning, not surveyed. PHI polygon edges are
  generalised. Neither resolves an individual flush.
- **Ties are real.** Trapezoid plateaus mean many cells are genuinely, equally
  suitable by the model's own logic. Ranking among tied cells is broken by mean
  suitability within 100 m — a coherent flush system is a better survey target
  than an isolated pixel — but a rank-1 and a rank-40 cell may be
  indistinguishable on the model's own terms. The `patch_score` column shows
  what broke the tie.

### Known technical limitations

- Flow routing is **D8**, which produces the characteristic radiating streaks
  visible on the map where flow is forced into one of eight directions.
  D-infinity or MFD would be smoother; D8 was chosen for a transparent,
  dependency-free implementation. It does not affect the broad pattern.
- Terrain derivatives are computed at the working resolution (10 m by default),
  set by the peat and geology layers rather than by the LIDAR. Flush-scale
  detail in the 1 m DTM is lost. Raising the resolution is a config change, but
  the peat map will not get any sharper.
- The whole-park grid is ~16.5M cells at 10 m; depression filling and flow
  accumulation take roughly 60–90 s.

## Layout

```
config.yaml              the model: filters, weights, curves, sources
bogorchid/
  osgb.py                British National Grid references
  membership.py          the scoring curves
  config.py              loading and strict validation
  terrain.py             pit filling, slope, D8 flow accumulation, TWI
  raster.py              model grid, reprojection, rasterising, distance
  sources.py             acquisition and preflight
  score.py               hard filters and the weighted overlay
  calibrate.py           known-site diagnostics and the pass/fail verdict
  candidates.py          ranked shortlist
  render.py              the map
  pipeline.py            orchestration
  synthetic.py           fictional layers, for testing without the real data
  cli.py                 command line
tests/                   83 tests
example_output/          a demo run, on synthetic data
```

## Provenance note

This model was built in an environment with no network access to the Natural
England, Environment Agency, BGS, Ordnance Survey, NBN Atlas or BSBI services —
all are blocked by egress policy. The pipeline has therefore **never been run
against the real layers**. It has been run end to end against synthetic layers
(see `example_output/`), which exercises every step including file I/O,
reprojection and field-name resolution, but the acquisition URLs and the
field-name lists in `pipeline.py` are written from documentation and have not
been confirmed against the live services. **Run `preflight --probe` first** and
expect to correct a layer index or a field name.
