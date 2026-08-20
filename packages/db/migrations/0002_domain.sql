-- Core domain tables (specification §3).
--
-- Precision (§2) is enforced here, not only in application code: every unit
-- quantity column carries a CHECK that the stored value is already rounded to
-- its module's scale — 4dp for area, 3dp for hedgerow and watercourse. A value
-- that has drifted below the scale cannot be written at all.
--
-- The columns are declared numeric(18, 6), deliberately wider than any module
-- needs. Declaring them at the module's own scale would have Postgres silently
-- round an over-precise value on the way in, and the CHECK would then never
-- see it. The headroom means an unrounded value arrives intact and is
-- rejected, so the constraint — not a quiet coercion — is what governs
-- precision for all three modules alike.

CREATE TYPE metric_module AS ENUM ('area', 'hedgerow', 'watercourse');
CREATE TYPE distinctiveness_band AS ENUM ('very-low', 'low', 'medium', 'high', 'very-high');
CREATE TYPE condition_band AS ENUM ('n/a', 'poor', 'fairly-poor', 'moderate', 'fairly-good', 'good');
CREATE TYPE spatial_band AS ENUM ('same-lpa', 'neighbouring-lpa-same-nca', 'outside');

CREATE FUNCTION app.module_scale(m metric_module) RETURNS integer
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT CASE m WHEN 'area' THEN 4 ELSE 3 END $$;

-- ---------------------------------------------------------------------------
-- Uploaded files: branding logos and metric workbooks.
-- ---------------------------------------------------------------------------
CREATE TYPE stored_file_kind AS ENUM ('branding-logo', 'bank-metric', 'developer-metric', 'other');

CREATE TABLE stored_file (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id   uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    kind              stored_file_kind NOT NULL,
    original_filename text NOT NULL,
    content_type      text NOT NULL,
    byte_size         bigint NOT NULL CHECK (byte_size >= 0),
    sha256            text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    storage_path      text NOT NULL,
    uploaded_by       uuid REFERENCES app_user (id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stored_file_organisation_idx ON stored_file (organisation_id, kind);
SELECT app.apply_tenant_policy('stored_file');

-- ---------------------------------------------------------------------------
-- §3.1 Bank Operator, including per-operator branding for quote exports.
-- Branding lives here rather than globally so a quote drawn from a third
-- party's stock carries that operator's branding, not Cosdon's.
-- ---------------------------------------------------------------------------
CREATE TABLE bank_operator (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id    uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    name               text NOT NULL,
    contact_name       text,
    contact_email      text,
    contact_phone      text,
    notes              text,
    -- Branding for quote exports (§3.1, §4.7).
    branding_company_name text,
    branding_address   text,
    branding_contact   text,
    branding_logo_file_id uuid REFERENCES stored_file (id) ON DELETE SET NULL,
    branding_accent_colour text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bank_operator_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT bank_operator_accent_colour_hex
        CHECK (branding_accent_colour IS NULL OR branding_accent_colour ~ '^#[0-9A-Fa-f]{6}$')
);
CREATE INDEX bank_operator_organisation_idx ON bank_operator (organisation_id);
SELECT app.apply_tenant_policy('bank_operator');

-- ---------------------------------------------------------------------------
-- §3.2 Habitat Bank Site
-- ---------------------------------------------------------------------------
CREATE TABLE habitat_bank_site (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id     uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    bank_operator_id    uuid NOT NULL REFERENCES bank_operator (id) ON DELETE RESTRICT,
    name                text NOT NULL,
    location            text,
    lpa_code            text,
    lpa_name            text,
    nca_code            text,
    nca_name            text,
    -- Ready for the signalled move of spatial risk onto Local Nature Recovery
    -- Strategy areas; unused until that methodology is confirmed (§5.3).
    lnrs_area_code      text,
    lnrs_area_name      text,
    bgs_register_reference text,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT habitat_bank_site_name_not_blank CHECK (btrim(name) <> '')
);
CREATE INDEX habitat_bank_site_operator_idx ON habitat_bank_site (bank_operator_id);
CREATE INDEX habitat_bank_site_organisation_idx ON habitat_bank_site (organisation_id);
SELECT app.apply_tenant_policy('habitat_bank_site');

-- ---------------------------------------------------------------------------
-- §3.3 / §4.1 Metric imports, held in a reviewable draft state so parsing
-- problems surface for correction before anything is committed to stock.
-- ---------------------------------------------------------------------------
CREATE TYPE metric_import_kind AS ENUM ('bank', 'developer');
CREATE TYPE metric_import_status AS ENUM ('draft', 'confirmed', 'discarded');

CREATE TABLE metric_import (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id  uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    kind             metric_import_kind NOT NULL,
    status           metric_import_status NOT NULL DEFAULT 'draft',
    site_id          uuid REFERENCES habitat_bank_site (id) ON DELETE CASCADE,
    file_id          uuid REFERENCES stored_file (id) ON DELETE SET NULL,
    -- Which DEFRA metric version this workbook was read as. Version handling
    -- is config-driven, never auto-detected (§7).
    metric_version   text NOT NULL,
    -- Rows the parser could not read cleanly, surfaced to the user for manual
    -- correction rather than failing the import silently (§4.1.4).
    parse_warnings   jsonb NOT NULL DEFAULT '[]'::jsonb,
    imported_by      uuid REFERENCES app_user (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    confirmed_at     timestamptz,
    CONSTRAINT metric_import_bank_has_site CHECK (kind <> 'bank' OR site_id IS NOT NULL),
    CONSTRAINT metric_import_confirmed_has_timestamp
        CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
);
CREATE INDEX metric_import_organisation_idx ON metric_import (organisation_id, kind, status);
SELECT app.apply_tenant_policy('metric_import');

-- ---------------------------------------------------------------------------
-- §3.3 Stock Parcel
-- ---------------------------------------------------------------------------
CREATE TABLE stock_parcel (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id     uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    site_id             uuid NOT NULL REFERENCES habitat_bank_site (id) ON DELETE CASCADE,
    metric_import_id    uuid REFERENCES metric_import (id) ON DELETE SET NULL,
    -- Reference as it appears in the source metric workbook.
    parcel_reference    text NOT NULL,
    module              metric_module NOT NULL,
    broad_habitat       text NOT NULL,
    habitat_type        text NOT NULL,
    distinctiveness     distinctiveness_band NOT NULL,
    condition           condition_band NOT NULL DEFAULT 'n/a',

    -- Units generated by this parcel, at the module's precision.
    total_units         numeric(18, 6) NOT NULL,
    -- Permanently retired against completed sales. Never decreases except
    -- through an explicit, audited sale reversal (§4.6.6).
    retired_units       numeric(18, 6) NOT NULL DEFAULT 0,

    -- Set by the user after import; a separate 2dp system from the unit
    -- quantities above and never to be conflated with them (§3.3).
    list_price_per_unit numeric(14, 2),

    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT stock_parcel_total_units_non_negative CHECK (total_units >= 0),
    CONSTRAINT stock_parcel_retired_units_non_negative CHECK (retired_units >= 0),
    CONSTRAINT stock_parcel_retired_within_total CHECK (retired_units <= total_units),
    CONSTRAINT stock_parcel_list_price_non_negative
        CHECK (list_price_per_unit IS NULL OR list_price_per_unit >= 0),
    -- Precision enforced at the point of storage (§2), per module.
    CONSTRAINT stock_parcel_total_units_scale
        CHECK (total_units = round(total_units, app.module_scale(module))),
    CONSTRAINT stock_parcel_retired_units_scale
        CHECK (retired_units = round(retired_units, app.module_scale(module)))
);
CREATE INDEX stock_parcel_site_idx ON stock_parcel (site_id, module);
CREATE INDEX stock_parcel_organisation_idx ON stock_parcel (organisation_id);
CREATE UNIQUE INDEX stock_parcel_reference_key ON stock_parcel (site_id, module, parcel_reference);
SELECT app.apply_tenant_policy('stock_parcel');

-- ---------------------------------------------------------------------------
-- §3.5 Developer. The purchasing entity and the development site are held
-- separately and deliberately: the quote is addressed to the purchaser's
-- billing address, while the spatial risk lookup uses the development site.
-- ---------------------------------------------------------------------------
CREATE TABLE developer (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id          uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    purchasing_entity_name   text NOT NULL,
    billing_address          text,
    development_site_name    text,
    development_site_address text,
    development_lpa_code     text,
    development_lpa_name     text,
    development_nca_code     text,
    development_nca_name     text,
    contact_name             text,
    contact_email            text,
    contact_phone            text,
    notes                    text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT developer_name_not_blank CHECK (btrim(purchasing_entity_name) <> '')
);
CREATE INDEX developer_organisation_idx ON developer (organisation_id);
SELECT app.apply_tenant_policy('developer');

-- ---------------------------------------------------------------------------
-- §3.6 Developer metric import: headline figures per module, plus the
-- per-habitat requirements that drive trading-rule filtering.
-- ---------------------------------------------------------------------------
CREATE TABLE developer_metric (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id     uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    developer_id        uuid NOT NULL REFERENCES developer (id) ON DELETE CASCADE,
    metric_import_id    uuid REFERENCES metric_import (id) ON DELETE SET NULL,
    development_lpa_code text,
    development_lpa_name text,
    development_nca_code text,
    development_nca_name text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX developer_metric_developer_idx ON developer_metric (developer_id);
SELECT app.apply_tenant_policy('developer_metric');

-- One row per module: each is a separate DEFRA headline figure and they are
-- never summed together.
CREATE TABLE developer_metric_module (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id         uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    developer_metric_id     uuid NOT NULL REFERENCES developer_metric (id) ON DELETE CASCADE,
    module                  metric_module NOT NULL,
    baseline_units          numeric(18, 6) NOT NULL,
    post_intervention_units numeric(18, 6) NOT NULL,
    -- Percentage change is a reported figure, held at 4dp for reporting only.
    percent_change          numeric(10, 4),
    -- Effective units that must be met off-site, at the module's precision.
    shortfall_units         numeric(18, 6) NOT NULL DEFAULT 0,
    created_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT developer_metric_module_baseline_scale
        CHECK (baseline_units = round(baseline_units, app.module_scale(module))),
    CONSTRAINT developer_metric_module_post_scale
        CHECK (post_intervention_units = round(post_intervention_units, app.module_scale(module))),
    CONSTRAINT developer_metric_module_shortfall_scale
        CHECK (shortfall_units = round(shortfall_units, app.module_scale(module))),
    CONSTRAINT developer_metric_module_non_negative
        CHECK (baseline_units >= 0 AND post_intervention_units >= 0 AND shortfall_units >= 0)
);
CREATE UNIQUE INDEX developer_metric_module_key ON developer_metric_module (developer_metric_id, module);
SELECT app.apply_tenant_policy('developer_metric_module');

-- What off-site stock is eligible to fill each shortfall, per habitat.
CREATE TABLE developer_metric_requirement (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id     uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    developer_metric_id uuid NOT NULL REFERENCES developer_metric (id) ON DELETE CASCADE,
    module              metric_module NOT NULL,
    broad_habitat       text NOT NULL,
    habitat_type        text NOT NULL,
    distinctiveness     distinctiveness_band NOT NULL,
    units_required      numeric(18, 6) NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT developer_metric_requirement_scale
        CHECK (units_required = round(units_required, app.module_scale(module))),
    CONSTRAINT developer_metric_requirement_non_negative CHECK (units_required >= 0)
);
CREATE INDEX developer_metric_requirement_metric_idx
    ON developer_metric_requirement (developer_metric_id, module);
SELECT app.apply_tenant_policy('developer_metric_requirement');
