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
| VAT | Per bank operator | Settled — see below |
| Buffer above the shortfall | `NET_GAIN_BUFFER_PERCENT`, default `0` | Settled — target is the shortfall exactly |
| Stale-quote threshold | `STALE_QUOTE_DAYS`, default `60` | Advisory only; quotes are kept until deleted |

| Metric 4.0 cell mapping | `packages/metric/src/versions/metric-4-0.ts` | Transcribed from a working tool, five discrepancies open |
| Metric 4.0 dropdown wording | `packages/metric/src/labels.ts` | Placeholder wording — the highest-risk unconfirmed item, see below |

Also still needed: sample bank and developer metric workbooks to build the
parsers against, branding assets, and a decision on VAT treatment — which
determines whether quotes need a subtotal/VAT/total breakdown or a flat total.

Spatial risk is built as a swappable *scheme* rather than a fixed lookup, so the
signalled move onto LNRS boundaries can be added alongside the current one and
selected per site without the solver changing.

## Branding

The interface follows the Cosdon guidelines:

| | |
|---|---|
| Cosdon Green | `#385B4F` — primary actions, links, accents |
| Cosdon Dark | `#33443C` — the sidebar and headings |
| Off White (Rocks) | `#FAF9F1` — the cairn in the logo, and type on dark ground |
| Neutral background | `#F8F8F8` |

Everything is driven from custom properties at the top of
`apps/web/src/styles.css`, so a change to the palette is a change in one place.

The logo is used in two forms: the original for light ground, and a reversed
version — off-white disc, green cairn — for the dark sidebar and the sign-in
screen. Both are generated into `apps/web/public/`.

**Fonts are not committed.** Intro Rust and Aileron are licensed to Cosdon, not
to this repository. `apps/web/public/fonts/README.md` says which files to drop
in; until then the app falls back to the closest system faces without any
change in layout.

Note the distinction between this and the **per-operator branding** on quote
documents. This section is the application's own identity, which is Cosdon's.
A quote drawn from a third party's stock carries *their* branding, taken from
the bank operator record — see §3.1.

## A quote supplies one bank

A quotation goes out under the operator whose stock it draws on — their name,
their branding, their units. That operator may hold several sites and a quote
may draw from any of them, but it does not straddle two, because the document
would have to claim to come from both.

The supplying operator is chosen when the quote is created. Everything else
follows: the allocation table offers only that operator's stock, saving a line
that reaches another operator's parcel is refused by name, and the document's
branding is read straight off the quote with nothing to infer.

## VAT belongs to the operator, not to the platform

A quotation goes out under the bank operator whose stock it supplies, so it is
**their** VAT position that governs it. Cosdon may not be registered while a
client bank is, and the same platform has to produce a correct document either
way — which one global setting cannot do.

Each operator records whether it is registered, its number, its rate, and an
invoicing address for where payment is sent. Registration is explicit rather
than inferred from having a number, because "no number recorded yet" and "not
registered" are different states, and treating the first as the second would
quietly drop VAT from a registered operator's quote.

Quotes always print three figures: total excluding VAT, the VAT, and total
including VAT. Where the operator is not registered the lines still appear, with
the VAT line reading "not charged" and a note saying so — a missing line reads
as an oversight, an explicit zero reads as a decision.

## What a quote targets

The target is the stated shortfall **exactly**. The metric workbook is what
confirms whether the resulting figure passes, so there is no reason for this
platform to second-guess it with a margin of its own.

The buffer mechanism remains and is one environment variable away
(`NET_GAIN_BUFFER_PERCENT`) if quotes start coming back short after an LPA
re-rounds them.

## Quotes are kept until you delete them

Nothing expires or disappears on its own. A quote past its stale threshold is
flagged and nothing more; a cancelled one stays as the record of a deal that did
not convert.

Deletion is available and deliberate — for duplicates, tests, enquiries that
went nowhere. A **sold** quote is refused: its allocation is the record of what
was retired from stock, and removing it would leave the retirement unexplained.
So is one with a reversed sale against it, for the same reason. The deletion
itself is written to the audit log, which is append-only, so the record outlives
the quote.

A reservation asks how long the stock is held for. Nothing is released
automatically when that date passes — the quote is flagged as expired and waits
for you, so stock never quietly frees up underneath a deal you thought you had.

## Uploads

Two things get uploaded, and both are handled the same careful way.

**An operator's logo**, on the bank operator record, appears at the top of that
operator's quote documents — so a quote drawn from a client's stock carries
their logo, not Cosdon's.

**A developer's metric workbook**, on the developer record. It is kept, not
merely read: the off-site write-back below patches this very file.

Three rules apply to both, and they are tested:

- **The path on disk owes nothing to the uploader.** It is built from the
  organisation's id and a generated file id, both UUIDs. The original filename
  is stored for display and used when the file is sent back, but never touches
  the filesystem — which removes path traversal as a category rather than as a
  case to defend against.
- **Type is decided by content.** The declared content-type and the extension
  are both attacker-controlled, so what is accepted is decided by inspecting the
  leading bytes. A script named `logo.png` and typed `image/png` is refused.
- **Nothing is served statically.** Files live outside any web root and come
  back only through authenticated, tenant-scoped endpoints.

## Writing the allocation back into the developer's metric

Once a quote has an allocation, `Download developer's metric` on the quote
returns **their own workbook** with the off-site creation tabs filled in — D-2,
E-2 or F-2 depending on module.

Their file is patched rather than rebuilt, so its macros, data validation and
every figure already in it survive. The uploaded original is never modified; a
copy is generated on each download.

The screen says what is standing in the way before you try: no workbook
uploaded, no allocation lines, or a parcel missing a metric input. That last one
is a stop rather than a silent omission — writing a parcel without the inputs
the workbook computes from would give the developer a different unit figure from
the one they were quoted.

## Exporting the position

`Export positions` on the exposure screen downloads a spreadsheet of the
commercial picture, filterable by bank and by status. Three sheets, because
there are three questions and they want different shapes:

| Sheet | Answers |
|---|---|
| Allocations | What have I committed, from which parcel, to whom, at what price |
| Quotes | Which deals are live, what are they worth, when do they expire |
| Stock position | How much is left to sell, and where am I over-quoted |

A cover sheet records when the export was taken and what it was filtered to, so
a file found on a drive months later is not mistaken for the whole picture.

Quantities are written as numbers at each module's own precision, so the sheet
sorts and totals properly. That conversion is the one place the platform's exact
decimals become floats; it is deliberate, one-way, and safe at these
magnitudes — nothing is ever read back from the file.

## Running several habitat banks

A bank operator holds sites, and sites hold parcels, so more than one bank sits
naturally in the model. The interface follows that shape rather than the
storage shape: exposure opens on a roll-up across every bank, showing where each
one stands and which have gone over-quoted, before any individual parcel. From
there you can narrow to one bank, then to one of its sites.

Stock and exposure both filter by bank as well as by site, and every parcel row
names its bank and site once you hold more than one — the reference alone stops
being enough to place it.

The solver deliberately searches across every bank at once by default, since a
developer's shortfall does not care which of your banks fills it. Scoping to a
single site remains an option (§4.3.1) where it should.

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
