-- Quotes, allocations, sales and audit (specification §3.7–§3.10, §4.4–§4.6).

-- Human-readable quote references, e.g. CC-Q-0001. The prefix is per
-- organisation so a third-party operator's quotes carry their own reference
-- series rather than Cosdon's.
ALTER TABLE organisation ADD COLUMN quote_reference_prefix text NOT NULL DEFAULT 'Q';
ALTER TABLE organisation ADD CONSTRAINT organisation_quote_prefix_format
    CHECK (quote_reference_prefix ~ '^[A-Z][A-Z0-9-]{0,11}$');

CREATE TABLE quote_counter (
    organisation_id uuid PRIMARY KEY REFERENCES organisation (id) ON DELETE CASCADE,
    next_value      integer NOT NULL DEFAULT 1 CHECK (next_value >= 1)
);
SELECT app.apply_tenant_policy('quote_counter');

CREATE TYPE quote_status AS ENUM ('draft', 'quoted', 'reserved', 'sold', 'cancelled');
CREATE TYPE quote_priority AS ENUM ('high', 'medium', 'low');
CREATE TYPE module_target_source AS ENUM ('metric', 'manual');

CREATE TABLE quote (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id     uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    reference           text NOT NULL,
    developer_id        uuid NOT NULL REFERENCES developer (id) ON DELETE RESTRICT,
    -- Null for the manual entry path, where the user states the units required
    -- directly without a developer metric import (§4.4).
    developer_metric_id uuid REFERENCES developer_metric (id) ON DELETE SET NULL,
    status              quote_status NOT NULL DEFAULT 'draft',
    priority            quote_priority NOT NULL DEFAULT 'medium',

    -- Sum of allocation line totals, maintained alongside the lines.
    total_price         numeric(16, 2) NOT NULL DEFAULT 0,

    -- Snapshotted so that a later change to the multiplier scheme or the
    -- buffer cannot silently restate the value of an existing quote.
    spatial_scheme_id   text NOT NULL,
    buffer_percent      numeric(6, 3) NOT NULL,

    notes               text,

    -- Drives the stale flag (§3.7). Refreshed on any substantive edit, not on
    -- mere viewing, so "no update in N days" means what it says.
    last_activity_at    timestamptz NOT NULL DEFAULT now(),

    reserved_at         timestamptz,
    reservation_expires_at timestamptz,
    cancelled_at        timestamptz,
    cancellation_reason text,
    sold_at             timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES app_user (id) ON DELETE SET NULL,

    CONSTRAINT quote_total_price_non_negative CHECK (total_price >= 0),
    CONSTRAINT quote_buffer_percent_sane CHECK (buffer_percent >= 0 AND buffer_percent <= 100),
    CONSTRAINT quote_cancelled_has_timestamp CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
    CONSTRAINT quote_sold_has_timestamp CHECK ((status = 'sold') = (sold_at IS NOT NULL)),
    CONSTRAINT quote_reserved_has_timestamp CHECK (status <> 'reserved' OR reserved_at IS NOT NULL)
);
CREATE UNIQUE INDEX quote_reference_key ON quote (organisation_id, reference);
CREATE INDEX quote_developer_idx ON quote (developer_id);
CREATE INDEX quote_status_idx ON quote (organisation_id, status);
CREATE INDEX quote_activity_idx ON quote (organisation_id, last_activity_at) WHERE status IN ('quoted', 'reserved');
SELECT app.apply_tenant_policy('quote');

-- Units required per module, from either entry path (§4.4).
CREATE TABLE quote_module_target (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    quote_id        uuid NOT NULL REFERENCES quote (id) ON DELETE CASCADE,
    module          metric_module NOT NULL,
    source          module_target_source NOT NULL,
    -- The bare shortfall, before the buffer is applied.
    required_units  numeric(18, 6) NOT NULL,
    -- The figure the allocation must actually clear: shortfall plus buffer,
    -- rounded up (§4.3.4). Stored rather than recomputed so the target a quote
    -- was accepted against is preserved.
    buffered_target_units numeric(18, 6) NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT quote_module_target_required_scale
        CHECK (required_units = round(required_units, app.module_scale(module))),
    CONSTRAINT quote_module_target_buffered_scale
        CHECK (buffered_target_units = round(buffered_target_units, app.module_scale(module))),
    CONSTRAINT quote_module_target_non_negative
        CHECK (required_units >= 0 AND buffered_target_units >= 0),
    CONSTRAINT quote_module_target_buffer_not_below_requirement
        CHECK (buffered_target_units >= required_units)
);
CREATE UNIQUE INDEX quote_module_target_key ON quote_module_target (quote_id, module);
SELECT app.apply_tenant_policy('quote_module_target');

-- §3.8 Allocation Line
CREATE TABLE allocation_line (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id     uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    quote_id            uuid NOT NULL REFERENCES quote (id) ON DELETE CASCADE,
    stock_parcel_id     uuid NOT NULL REFERENCES stock_parcel (id) ON DELETE RESTRICT,
    module              metric_module NOT NULL,

    -- Units drawn from the parcel, before the spatial multiplier.
    raw_quantity        numeric(18, 6) NOT NULL,
    -- The band and factor in force when this line was written. Snapshotted:
    -- revising the multiplier scheme must not restate existing quotes.
    spatial_band        spatial_band NOT NULL,
    spatial_factor      numeric(6, 4) NOT NULL,
    -- Units this line delivers toward the target after the multiplier.
    effective_units     numeric(18, 6) NOT NULL,

    unit_price          numeric(14, 2) NOT NULL DEFAULT 0,
    line_total          numeric(16, 2) NOT NULL DEFAULT 0,

    -- Why this stock is eligible for this shortfall (§3.8).
    trading_rule_justification text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT allocation_line_quantity_positive CHECK (raw_quantity > 0),
    CONSTRAINT allocation_line_effective_non_negative CHECK (effective_units >= 0),
    CONSTRAINT allocation_line_price_non_negative CHECK (unit_price >= 0 AND line_total >= 0),
    CONSTRAINT allocation_line_factor_range CHECK (spatial_factor > 0 AND spatial_factor <= 1),
    CONSTRAINT allocation_line_raw_scale
        CHECK (raw_quantity = round(raw_quantity, app.module_scale(module))),
    CONSTRAINT allocation_line_effective_scale
        CHECK (effective_units = round(effective_units, app.module_scale(module))),
    -- Effective units may never overstate what the multiplier actually
    -- delivers; the application rounds this figure down for that reason.
    CONSTRAINT allocation_line_effective_not_overstated
        CHECK (effective_units <= raw_quantity * spatial_factor),
    -- Line total is quantity x unit price, to the penny (§3.8).
    CONSTRAINT allocation_line_total_matches
        CHECK (line_total = round(raw_quantity * unit_price, 2))
);
CREATE INDEX allocation_line_quote_idx ON allocation_line (quote_id, module);
CREATE INDEX allocation_line_parcel_idx ON allocation_line (stock_parcel_id);
SELECT app.apply_tenant_policy('allocation_line');

-- An allocation line must draw from a parcel of its own module. Enforced with
-- a composite foreign key so the two can never disagree.
CREATE UNIQUE INDEX stock_parcel_id_module_key ON stock_parcel (id, module);
ALTER TABLE allocation_line
    ADD CONSTRAINT allocation_line_parcel_module_fk
    FOREIGN KEY (stock_parcel_id, module) REFERENCES stock_parcel (id, module);

-- §3.9 Sale Record
CREATE TABLE sale_record (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id          uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    quote_id                 uuid NOT NULL UNIQUE REFERENCES quote (id) ON DELETE RESTRICT,
    planning_application_reference text,
    bgs_register_submission_date date,
    sold_date                date NOT NULL,
    reversed_at              timestamptz,
    reversal_reason          text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sale_record_reversal_has_reason
        CHECK (reversed_at IS NULL OR btrim(coalesce(reversal_reason, '')) <> '')
);
SELECT app.apply_tenant_policy('sale_record');

-- Snapshot of what was retired from each parcel at the moment of sale, so a
-- reversal restores exactly the figures that were taken (§3.9, §4.6.6).
CREATE TABLE sale_retirement (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id  uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    sale_record_id   uuid NOT NULL REFERENCES sale_record (id) ON DELETE CASCADE,
    stock_parcel_id  uuid NOT NULL REFERENCES stock_parcel (id) ON DELETE RESTRICT,
    module           metric_module NOT NULL,
    quantity         numeric(18, 6) NOT NULL,
    restored_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sale_retirement_quantity_positive CHECK (quantity > 0),
    CONSTRAINT sale_retirement_scale CHECK (quantity = round(quantity, app.module_scale(module)))
);
CREATE INDEX sale_retirement_sale_idx ON sale_retirement (sale_record_id);
CREATE INDEX sale_retirement_parcel_idx ON sale_retirement (stock_parcel_id);
SELECT app.apply_tenant_policy('sale_retirement');

-- §3.10 Audit Log
CREATE TABLE audit_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    entity_type     text NOT NULL,
    entity_id       uuid NOT NULL,
    action          text NOT NULL,
    from_status     text,
    to_status       text,
    note            text,
    -- Full before/after detail for allocation edits, where "what changed"
    -- cannot be expressed as a status transition.
    detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
    actor_user_id   uuid REFERENCES app_user (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (organisation_id, entity_type, entity_id, created_at DESC);
SELECT app.apply_tenant_policy('audit_log');
