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
| `packages/core` | Precision primitives, trading rules, spatial multipliers. No I/O. |
| `packages/db` | SQL migrations, tenant-scoped client, repositories. |
| `apps/api` | Fastify HTTP API, session auth. |
| `apps/web` | React client. |

## Two things worth knowing before changing anything

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

Phase 1 of the specification, plus the auth and tenancy that third-party logins
require:

- Organisations, users, sessions, management grants
- Bank operators with per-operator quote branding
- Habitat bank sites, including an LNRS field held ready but unused
- Stock parcels entered by hand, with list pricing
- The derived stock unit pool and exposure view

Not yet built: metric workbook import, the allocation solver and interactive
table, the quote lifecycle, Word export, off-site metric write-back, and backup
and restore. The domain pieces those depend on — trading rules, spatial
multipliers, the buffered target, the quote and allocation schema with its
status ladder — are in place and tested.

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

Also still needed: sample bank and developer metric workbooks to build the
parsers against, branding assets, and a decision on VAT treatment — which
determines whether quotes need a subtotal/VAT/total breakdown or a flat total.

Spatial risk is built as a swappable *scheme* rather than a fixed lookup, so the
signalled move onto LNRS boundaries can be added alongside the current one and
selected per site without the solver changing.
