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

Six Devon records are known to this model. Only two are precise enough to
calibrate against.

| Site | Grid ref | Precision | Date | Role |
|---|---|---|---|---|
| Raybarrow Pool area | SX 64524 90050 | 10 m | — | **calibration** |
| Steeperton Brook | SX 62406 89005 | 10 m | 1984–1998 | **calibration** |
| Unnamed SX68 site | SX68 | 10 km | 1994–2012 | reference |
| Webburn Valley below Blackaton Tor | SX6978 | 1 km | 1938 | reference |
| Great Haldon | Haldon, c.SX88 | 10 km | 1863 | context (outside study area) |
| Combe Martin area | c.SS54 | 10 km | 19th c. | context (outside study area) |

The first two came with the brief. The other four were found in
[*A New Flora of Devon*](https://devonassoc.org.uk/f16/Flora22.pdf) during this
work. **Every one of them is old enough, or vague enough, that the land it
refers to may no longer be what it was** — which is exactly why they are
weighted the way they are.

### The extant records

**Steeperton Brook, SX625889** — recorded 1984 (N. Baldock), six plants 1997
and five 1998 (W.H. Tucker). Matches the supplied SX 62406 89005 to ~155 m, so
they are taken to be the same locality. *Land use caveat:* this site sits
immediately upstream of **Taw Marsh**, where the North Devon Water Board sank
production boreholes under the 1959 North Devon Water Act, over the objections
of the Dartmoor amenity societies. Most of Taw Marsh was drained as a result.
The scheme has since **closed**, which raises a real possibility of
hydrological recovery in the Taw valley — and makes this catchment worth
surveying on its own merits, not only where the model scores it highest. No
record here since 1998.

**Unnamed SX68 site** — recorded annually from 1994, maximum 25 plants in 2000
*"scattered over more than one flush"* (R.D. Hutchings & R. Avery); five plants
2009 (N. Baldock); six in 2011 and again in 2012 (R.E.N. Smith). This is a
genuinely extant, monitored population and the best-documented of the lot — and
the only published location is the **10 km square**. That is far too coarse to
calibrate against and far too coarse to exclude from the shortlist without
discarding most of the moor.

> **This is the single highest-value input still missing.** A precise grid
> reference for this site, from the BSBI Distribution Database or the Devon
> Biodiversity Records Centre, would take the calibration set from two points to
> three and would let the model be tested against a population still present.
> The "more than one flush" detail is also directly informative: it implies a
> flush *system*, which is what the patch-context tie-break is designed to find.

### The lapsed records, and what happened to the ground

These are the ones to treat with most care. A record is evidence that the
habitat was suitable **then**; it is not evidence about now.

**Webburn Valley below Blackaton Tor, SX6978, 1938** — two plants in a bog,
L.A. Harvey, det. T. Stephenson (in Harvey & Leger-Gordon 1953; Greig 1957).
Nearly 90 years old, 1 km precision, and the only record from **east** Dartmoor;
both extant sites are in the north. Worth re-checking in the field, and worth
noting that it widens the envelope the model should be willing to consider
beyond the northern high moor. The tor name should be verified against the
original record — the Flora spells it "Blackaton", and there is a Blackadon
Tor / Blackadon Down in this general area; the grid square is the reliable part.

**Great Haldon, 1863, R. Shute** — the Haldon Hills, c.20 km east of Dartmoor.
The lowland heath and valley bog here was extensively **planted with conifer in
the early 20th century**; what survives is fragmented into Great Haldon Heaths
and Little Haldon Heaths SSSIs. The habitat that held this record is very
unlikely to still exist.

**Combe Martin area, 19th century** — North Devon, on the Exmoor fringe. Only
"reported once from the Combe Martin area" in the account consulted; no date or
recorder recovered. Listed for completeness of the Devon record set.

Both 19th-century sites are outside the study area and are never scored. They
are kept because they make the brief's premise concrete: *H. paludosa* has
declined in Britain since the late 19th century principally through **drainage
of its mire habitats**, so absence of modern records reflects a mixture of
under-recording *and* genuine habitat destruction — not evidence that the
remaining ground is unsuitable.

### How the model treats record age and precision

- Only `use_for_calibration: true` records are used to rank the map or derive
  the elevation band. Currently that is the two precise ones.
- Records coarser than the working resolution are **flagged, not excluded**.
  Candidates falling inside a coarse record's square carry it in the
  `within_coarse_record` column — one of them may simply *be* that site.
- Nothing in the model down-weights a record for age, because a record's age
  tells you about the *site*, not about the *habitat description* the weights
  are built from. Age is surfaced in the report and this README so you can
  judge it; it is not silently baked into a number.

## Installing

```bash
pip install -r requirements.txt
```

## Getting the data

Nothing needs to be downloaded by hand where a service exists. Each live source
is asked for **only the study bounding box**, at the working resolution, and
cached under `data/raw/`. For the 1 m LIDAR that is the difference between tens
of megabytes and a national dataset.

```bash
python -m bogorchid preflight            # what is present, what is missing, which keys are unset
python -m bogorchid preflight --probe    # ask each service to describe itself
python -m bogorchid acquire              # fetch everything fetchable
python -m bogorchid records              # pull occurrence records; report calibration candidates
```

### Supplying endpoints

Endpoints live in config, not code. Copy the example overlay and fill in
whatever you have:

```bash
cp sources.local.example.yaml sources.local.yaml
```

`sources.local.yaml` is deep-merged over `config.yaml` and is **gitignored**, so
site-specific endpoints never reach version control. Supported protocols:

| `kind` | Use | Notes |
|---|---|---|
| `arcgis_featureserver` | Vector, ArcGIS REST | Paged on `resultOffset`; handles `exceededTransferLimit` |
| `arcgis_imageserver` | Raster, ArcGIS REST | `exportImage`, tiled under the service cap and mosaicked |
| `ogc_wcs` | Raster, OGC WCS | `GetCoverage`, versions 2.0.1 and 1.0.0 |
| `ogc_api_features` | Vector, OGC API - Features | Follows the `next` link, as OS NGD implements it |
| `wfs` | Vector, OGC WFS | Index-paged; 2.0.0 and 1.1.0 parameter names |
| `nbn_occurrences` | Species records | NBN Atlas occurrence search, reprojected to EPSG:27700 |

**API keys are never stored in config.** A source names an environment variable
via `api_key_env`; the key is read from the environment at request time and is
never written to disk, logged, or included in `run_manifest.json`. `auth.style`
selects `query`, `header` or `bearer` placement.

### Layers and where they come from

| Layer | Source | Licence | Role |
|---|---|---|---|
| Priority Habitats Inventory | Natural England ArcGIS FeatureServer | OGL | Hard filter — bounds the search to mire/flush |
| National Park boundary | Natural England ArcGIS FeatureServer | OGL | Study area |
| Peat depth + vegetation | [England Peat Map (NERR149, 2025)](https://england-peat-map-portal-ncea.hub.arcgis.com/) | OGL | Hard filter + Sphagnum flag |
| LIDAR Composite DTM 1 m | [EA Survey Open Data](https://environment.data.gov.uk/survey) | OGL | Slope, flow accumulation, TWI |
| OS Open Rivers / NGD | [OS Data Hub](https://osdatahub.os.uk/) | OGL | Distance to watercourse |
| BGS bedrock geology | [BGS OpenGeoscience](https://www.bgs.ac.uk/) | check terms | Base-richness proxy (optional) |
| Occurrence records | [NBN Atlas](https://nbnatlas.org/) | per dataset | Finding records the model does not know about |
| NVC survey data | Enquire: Natural England / Dartmoor NPA | by agreement | M1/M21 match (optional, off by default) |

The BSBI Distribution Database has no open API. Its Dartmoor records need a
request to BSBI or to the Devon Biodiversity Records Centre; add what you get
to `known_sites` by hand.

**Records are never promoted into `known_sites` automatically.** Whether a
record is precise enough to calibrate against is an ecological judgement, so
`records` reports what it found — year, coordinate uncertainty, distance to the
nearest site already known — and flags the ones that look both precise and new.
You decide.

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
python -m pytest tests/ -q      # 101 tests, ~11s
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
sources.local.example.yaml  template for your own service endpoints
bogorchid/
  osgb.py                British National Grid references
  membership.py          the scoring curves
  config.py              loading and strict validation
  terrain.py             pit filling, slope, D8 flow accumulation, TWI
  raster.py              model grid, reprojection, rasterising, distance
  services.py            live-service clients: ArcGIS, WCS, OGC API, WFS, NBN
  sources.py             acquisition, caching and preflight
  score.py               hard filters and the weighted overlay
  calibrate.py           known-site diagnostics and the pass/fail verdict
  candidates.py          ranked shortlist
  render.py              the map
  pipeline.py            orchestration
  synthetic.py           fictional layers, for testing without the real data
  cli.py                 command line
tests/                   101 tests
example_output/          a demo run, on synthetic data
```

## Provenance note

This model was built in an environment with no network access to the Natural
England, Environment Agency, BGS, Ordnance Survey, NBN Atlas or BSBI services —
all are blocked by egress policy, which refuses the connection before any
authentication happens — so API keys would not have helped there either. The
pipeline has therefore **never been run against the real layers**.

It has been run end to end against synthetic layers (see `example_output/`),
which exercises every step including file I/O, reprojection, rasterisation and
field-name resolution. The service clients are covered by tests against a stub
transport, which pins down paging, credential placement, raster tiling and error
handling — but not whether any given URL is correct.

**Every endpoint in `config.yaml` and `sources.local.example.yaml` should be
treated as a guess until `preflight --probe` says otherwise**, and the
field-name lists in `pipeline.py` (PHI habitat field, BGS lithology field) are
written from documentation. Expect to correct a layer index or a field name on
first contact. The failure modes are loud by design: a wrong layer id gives
"the service returned no features for the study area", a wrong coverage gives
"returned N bytes that are not a TIFF", and a blocked host gives a message that
says so explicitly.
