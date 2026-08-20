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
pnpm db:backup   # write a whole-database backup to a file
pnpm db:restore  # replace the database from one (asks you to confirm by typing)
```

The first organisation created on an instance is treated as the one running it,
which is what gates whole-instance backups. Later organisations — third-party
bank operators being onboarded — are ordinary tenants.

`scripts/smoke-ui.mjs` drives the real UI in a browser against a running dev
server and an empty database; see the note at the top of that file.

## Layout

| Path | What it holds |
|---|---|
| `packages/core` | Precision primitives, trading rules, spatial multipliers, the allocation solver. No I/O. |
| `packages/metric` | DEFRA metric cell mappings and the off-site workbook write-back. |
| `packages/documents` | Quote Word export and VAT treatment. |
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

### Security: what protects the quotes

Stock levels, negotiated pricing, and who is being quoted for what are the
commercially sensitive things here. Four layers protect them, and each is
tested rather than asserted.

**Isolation is enforced by Postgres, not by application code.** See below. The
coverage test reads the database catalogue rather than a list in a test file,
so a table added later without row-level security fails the suite the moment it
exists — that being the realistic way data leaks out of a system like this.

**Nothing is cached.** Every API response carries `no-store, private`. Quote and
allocation responses are exactly what ends up in a shared proxy or on disk in a
browser cache, to be read by the next person at that machine.

**Errors give nothing away.** Postgres's own constraint text names the table and
the constraint, and its detail names the failing row. None of it is forwarded;
constraint violations are answered with messages written here. Rules this
codebase wrote raise a different SQLSTATE so they can still be passed through
verbatim, since those are composed for a reader. A quote belonging to another
organisation answers 404 rather than 403 — 403 would confirm the id exists.
Login gives an identical response and comparable timing whether or not the
account exists.

**Sessions and forgery.** Only a hash of each session token is stored. Cookies
are `HttpOnly` and `SameSite=Lax`, and `Secure` once deployed; state-changing
requests additionally check the `Origin`. Login is rate limited tightly, since a
list of emails and a list of common passwords is the realistic route into
someone else's quote book.

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

Built, with screens for all of it:

- Organisations, users, sessions, management grants
- Bank operators with per-operator quote branding
- Habitat bank sites, including an LNRS field held ready but unused
- Stock parcels with list pricing, physical extent and the metric inputs
- The derived stock unit pool and exposure view
- Developers, keeping the purchasing entity apart from the development site
- The three-module allocation solver
- The interactive allocation table: units and percentages converting both ways,
  a live running total against the buffered target, the hard issue gate
- The quote lifecycle: cancellation, reservation, sale with partial retirement,
  audited sale reversal
- The quote Word export, branded per bank operator
- Metric cell mappings and the off-site workbook write-back
- Backup: per-organisation export and whole-instance backup

Not yet built: the bank and developer metric **importers**. The mapping layer
they need exists; the parsers are waiting on sample workbooks — see below.
Branding logo upload is also outstanding, so quote documents currently show the
operator's name and address but no logo.

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

## Backup is two different things

§4.8 was written for a single local SQLite file, where backup meant copying it.
With third-party operators signing in, that one action is now two, and running
them together would hand every tenant's commercial data to whoever pressed the
button.

- **An organisation export** is a tenant's own data as JSON, safe for any of its
  users to take. It goes through the same row-level security as every other
  query, so it can only contain what that organisation may see — there is a test
  asserting one operator's export cannot contain another's parcel references or
  pricing. Figures are written as text, so a 4dp unit quantity survives exactly.
- **A whole-instance backup** is `pg_dump` output for disaster recovery,
  restricted to an owner or admin of the organisation running the instance.

**Restore is not exposed over HTTP.** An endpoint that replaces the entire
database is not something that should be one mis-click away in a browser
session, and "a clear confirmation step" is served far better by a deliberate
command on the machine holding the data — `pnpm db:restore <file>`, which makes
you type a confirmation phrase. The backup screen shows the command rather than
hiding the capability.

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
