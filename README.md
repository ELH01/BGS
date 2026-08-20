# Habitat Bank Operations Platform

Manages habitat bank stock, developer quotes and BNG unit sales for Cosdon
Consulting Ltd, including banks managed on behalf of third-party operators.

## Shape of the build

Built as a web application that **runs on your own machine to start with**.
Nothing is exposed beyond localhost until you choose to deploy it; when you do,
it is a deployment rather than a rewrite. That decision was taken over an
Electron desktop build for three reasons:

- Third-party bank operators logging in to see their own stock is a near-term
  goal, so tenancy had to be in the schema from the first migration.
- Postgres has a real `NUMERIC` type. SQLite does not — it has numeric
  *affinity* but stores as `REAL` or `INTEGER` — which would have meant
  hand-rolling fixed-point storage for the very figures that must not drift.
- Electron's ongoing cost is not the build, it is code signing, notarisation
  and auto-update.

## Getting started

Requires Node 20+ and either Docker or a local Postgres 16.

```bash
pnpm install
cp .env.example .env          # then set SESSION_SECRET
docker compose up -d          # or point DATABASE_URL at your own Postgres
pnpm db:migrate
pnpm dev                      # API on :3001, web client on :5173
```

Open http://localhost:5173 and choose **Set up a new organisation**.

```bash
pnpm test        # unit and integration suites
pnpm typecheck   # all packages
pnpm db:reset    # drop and rebuild the schema (development only)
```

`scripts/smoke-ui.mjs` drives the real UI in a browser against a running dev
server and an empty database; see the note at the top of that file.

## Layout

| Path | What it holds |
|---|---|
| `packages/core` | Precision primitives, trading rules, spatial multipliers, the allocation solver. No I/O. |
| `packages/metric` | DEFRA metric cell mappings and the off-site workbook write-back. |
| `packages/db` | SQL migrations, tenant-scoped client, repositories. |
| `apps/api` | Fastify HTTP API, session auth. |
| `apps/web` | React client. |

## Three things worth knowing before changing anything

### Precision is enforced in three places, deliberately

Area units are held at 4 decimal places, hedgerow and watercourse at 3. This is
storage precision, not a display convention.

1. **`UnitQuantity`** wraps `decimal.js` and rounds once, at construction, to
   its module's scale. Because addition and subtraction of two values already
   at scale N are exact at scale N, repeated allocate/retire/restore cycles
   cannot accumulate drift — there is no residue below the scale for drift to
   come from. Multiplication and division are the only operations that can
   round, and both make the direction explicit in their signature.
2. **The database** carries a `CHECK` on every unit column asserting the value
   is already rounded to its module's scale. The columns are declared
   `numeric(18, 6)`, wider than any module needs, because declaring them at the
   module's own scale would have Postgres silently round an over-precise value
   on the way in and the `CHECK` would never see it.
3. **The API** accepts quantities as strings only, never JSON numbers. A
   numeric literal has already been through an IEEE double by the time
   `JSON.parse` is done with it.

Money is a separate 2dp system and the two are not interchangeable.
`Money.lineTotal` is the single sanctioned crossing point between them.

### This platform never computes biodiversity units

The metric workbook is what determines units. It takes habitat type, condition,
strategic significance, extent and the temporal figures, and calculates from
them. Nothing here re-implements that arithmetic, and nothing here should: it is
a statutory calculation that DEFRA revises, and a second implementation would
be one more thing to keep in step, silently wrong whenever it fell behind.

So units enter the system one way — read from a bank's own completed metric —
and leave it one way: when an allocation is written into a developer's metric,
the platform writes back the *inputs*, and that workbook recomputes.

The consequence worth internalising: **the developer's workbook recomputes from
scratch, so every input has to reach it.** Miss one and their metric lands on a
different figure from the one the parcel was quoted on, with nothing obviously
wrong on either side. That is why `stock_parcel` carries extent, condition,
strategic significance, years created in advance and delay years alongside the
units themselves, and why the API reports an `exportReadiness` on every parcel
naming anything still missing.

It is also why the spatial multiplier is *not* applied to the extent that gets
written. The multiplier reaches the workbook as the spatial risk category in its
own column, and the workbook applies it. Applying it here as well would deduct
it twice.

### Tenant isolation is the database's job, not the query layer's

`organisation` is the tenant. The allocation management service — Cosdon
managing a bank for a client — is an explicit, revocable grant from the owning
organisation to the managing one, so a single `organisation_id` column and one
policy shape covers every table.

The API connects as `bgs_app`, which is not a superuser and has no
`BYPASSRLS`. Every request runs inside a transaction with
`app.organisation_id` set, and Postgres filters from there. A missed `WHERE`
clause in application code cannot leak another operator's stock levels or
negotiated pricing. A management grant conveys access to bank data but not to
the client's user accounts.

Authentication necessarily happens before an organisation context exists, so it
goes through a few narrow `SECURITY DEFINER` functions rather than a hole in
the policies.

## What is built, and what is not

Built:

- Organisations, users, sessions, management grants
- Bank operators with per-operator quote branding
- Habitat bank sites, including an LNRS field held ready but unused
- Stock parcels with list pricing and physical extent
- The derived stock unit pool and exposure view
- Developers, keeping the purchasing entity apart from the development site
- The three-module allocation solver, over an API endpoint
- The quote lifecycle: allocation, the hard target gate, exposure,
  cancellation, reservation, sale with partial retirement, audited sale
  reversal
- Metric cell mappings and the off-site workbook write-back

Not yet built: the bank and developer metric **importers** (the mapping layer
they need exists; the parsers are waiting on sample workbooks — see below), the
interactive allocation table in the browser, the quote Word export, and backup
and restore.

The web client currently covers phase 1 — operators, sites, stock and exposure.
The solver and quote lifecycle are reachable over the API but do not yet have
screens.

## Values awaiting confirmation

These ship as **placeholders, marked unconfirmed**, so the platform can be
built and tested end to end without presenting unverified figures as
authoritative. The Configuration page lists them, and anything derived from
them is flagged wherever it appears.

| Value | Where | Status |
|---|---|---|
| Spatial risk multipliers | `packages/core/src/spatial-multiplier.ts` | Placeholder |
| Trading rule definitions | `packages/core/src/trading-rules.ts` | From public DEFRA guidance, unconfirmed |
| Buffer above 10% net gain | `NET_GAIN_BUFFER_PERCENT`, default `0.1` | Suggested |
| Stale-quote threshold | `STALE_QUOTE_DAYS`, default `60` | Suggested |

| Metric 4.0 cell mapping | `packages/metric/src/versions/metric-4-0.ts` | Transcribed from a working tool, five discrepancies open |
| Metric 4.0 dropdown wording | `packages/metric/src/labels.ts` | Placeholder wording — the highest-risk unconfirmed item, see below |

Also still needed: sample bank and developer metric workbooks to build the
parsers against, branding assets, and a decision on VAT treatment — which
determines whether quotes need a subtotal/VAT/total breakdown or a flat total.

Spatial risk is built as a swappable *scheme* rather than a fixed lookup, so the
signalled move onto LNRS boundaries can be added alongside the current one and
selected per site without the solver changing.

## The metric cell mapping

`packages/metric` holds the sheet, row and column addresses for the statutory
metric, isolated from everything else so that a new DEFRA version is a new
mapping file and nothing more. The 4.0 mapping was transcribed from a working
QGIS export tool that writes into these workbooks in the field, so the addresses
have been used against real files rather than inferred.

Two things to know before touching it.

**Sheet names are reproduced exactly, typos included.** The workbook spells one
sheet "Enhancment" and drops the apostrophe from "WaterC'" on one sheet alone.
Tidying either means the sheet is never found.

**Five discrepancies are recorded rather than resolved**, listed in that file's
`discrepancies` array and surfaced through the API. The most significant: `A-3`
and `D-3` map column `AE` to different fields, and the two off-site enhancement
sheets have no spatial risk column mapped though every other off-site sheet
does. Each needs checking against a real workbook; guessing would produce a file
that looks right and is wrong.

The writer patches the XML inside the workbook zip rather than round-tripping
through a spreadsheet library, so the VBA project, data validation and
conditional formatting the metric depends on survive untouched. It writes only
the cells asked for, keeps each cell's existing style, marks the workbook to
recalculate on open — nothing here evaluates the metric's formulas — and reports
any cell that held a formula before being written, since the metric's input
cells should not contain formulas and that almost certainly means the mapping is
pointing somewhere wrong.

Note that the metric takes **hectares and kilometres, not units**. An allocation
is written as the fraction of the parcel being sold applied to its physical
extent, which is why `stock_parcel.extent` exists.

### The dropdown wording is the riskiest unconfirmed thing here

`labels.ts` holds the exact text the metric's dropdowns use — condition,
strategic significance, spatial risk category — because the platform stores
stable slugs and the workbook wants its own words.

These carry more risk than the cell addresses. A wrong column puts a value
somewhere visible and someone notices. A wrong dropdown label writes text the
metric's lookup formulas do not recognise, and since data validation only fires
on manual entry, Excel accepts it without complaint — the units come out as an
error or a zero rather than as an obvious fault. Confirm this wording against a
real workbook's dropdown lists before trusting an export.
