-- Derived views, invariant-enforcing triggers, and the least-privilege
-- application role.

-- ---------------------------------------------------------------------------
-- §3.4 Stock Unit Pool
-- ---------------------------------------------------------------------------
-- Derived rather than stored, so the pool can never drift out of step with the
-- allocations and retirements it is a function of.
--
-- The invariant from §3.4: a quote is soft and does NOT reduce availability —
-- it only marks units as exposed. A reservation is firm and does reduce it, as
-- does a completed sale.
--
--   available = total - retired - reserved
--
-- security_invoker means the view is filtered by the querying role's
-- row-level security, not the view owner's.
CREATE VIEW stock_unit_pool WITH (security_invoker = true) AS
SELECT
    p.id                AS stock_parcel_id,
    p.organisation_id,
    p.site_id,
    p.module,
    p.broad_habitat,
    p.habitat_type,
    p.distinctiveness,
    p.condition,
    p.parcel_reference,
    p.list_price_per_unit,
    p.total_units,
    p.retired_units     AS sold_units,
    a.draft_units,
    a.quoted_units,
    a.reserved_units,
    -- Soft exposure: everything live against this parcel, whether or not it
    -- has reduced availability yet.
    a.quoted_units + a.reserved_units AS exposed_units,
    p.total_units - p.retired_units - a.reserved_units AS available_units,
    -- Over-quoting is permitted and expected, but must be visible rather than
    -- hidden (§4.4).
    (a.quoted_units + a.reserved_units)
        > (p.total_units - p.retired_units) AS is_over_exposed
FROM stock_parcel p
CROSS JOIN LATERAL (
    SELECT
        COALESCE(SUM(l.raw_quantity) FILTER (WHERE q.status = 'draft'), 0)    AS draft_units,
        COALESCE(SUM(l.raw_quantity) FILTER (WHERE q.status = 'quoted'), 0)   AS quoted_units,
        COALESCE(SUM(l.raw_quantity) FILTER (WHERE q.status = 'reserved'), 0) AS reserved_units
    FROM allocation_line l
    JOIN quote q ON q.id = l.quote_id
    WHERE l.stock_parcel_id = p.id
) a;

-- ---------------------------------------------------------------------------
-- Quote status ladder (§4.4–§4.6)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.enforce_quote_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        IF NEW.status = OLD.status THEN
            RETURN NEW;
        END IF;

        -- Cancelled is terminal: history stays intact rather than a quote
        -- being revived and its conversion record muddled (§3.7).
        IF OLD.status = 'cancelled' THEN
            RAISE EXCEPTION 'Quote % is cancelled; cancelled quotes are terminal and cannot be reopened.', OLD.reference
                USING ERRCODE = 'check_violation';
        END IF;

        -- Leaving Sold is only ever a deliberate reversal, which restores the
        -- retired stock and records a reason (§4.6.6).
        IF OLD.status = 'sold' AND NEW.status NOT IN ('reserved', 'cancelled') THEN
            RAISE EXCEPTION 'A sold quote can only be moved to reserved or cancelled, and only by reversing the sale.'
                USING ERRCODE = 'check_violation';
        END IF;

        IF OLD.status = 'draft' AND NEW.status NOT IN ('quoted', 'cancelled') THEN
            RAISE EXCEPTION 'A draft quote can only become quoted or cancelled.'
                USING ERRCODE = 'check_violation';
        END IF;

        IF OLD.status = 'quoted' AND NEW.status NOT IN ('draft', 'reserved', 'sold', 'cancelled') THEN
            RAISE EXCEPTION 'Invalid transition from quoted to %.', NEW.status
                USING ERRCODE = 'check_violation';
        END IF;

        IF OLD.status = 'reserved' AND NEW.status NOT IN ('quoted', 'sold', 'cancelled') THEN
            RAISE EXCEPTION 'Invalid transition from reserved to %.', NEW.status
                USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
    END;
    $$;

CREATE TRIGGER quote_transition_guard
    BEFORE UPDATE OF status ON quote
    FOR EACH ROW EXECUTE FUNCTION app.enforce_quote_transition();

-- A sold quote's allocation figures are the record of what was retired and
-- must not be edited in place; corrections go through a sale reversal (§4.6).
CREATE FUNCTION app.reject_sold_allocation_edit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
        current_status quote_status;
        target_quote uuid;
    BEGIN
        target_quote := COALESCE(NEW.quote_id, OLD.quote_id);
        SELECT status INTO current_status FROM quote WHERE id = target_quote;

        IF current_status = 'sold' THEN
            RAISE EXCEPTION 'Allocation lines on a sold quote cannot be changed; reverse the sale first.'
                USING ERRCODE = 'check_violation';
        END IF;

        RETURN COALESCE(NEW, OLD);
    END;
    $$;

CREATE TRIGGER allocation_line_sold_guard
    BEFORE INSERT OR UPDATE OR DELETE ON allocation_line
    FOR EACH ROW EXECUTE FUNCTION app.reject_sold_allocation_edit();

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        NEW.updated_at := now();
        RETURN NEW;
    END;
    $$;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'organisation', 'app_user', 'bank_operator', 'habitat_bank_site',
        'stock_parcel', 'developer', 'developer_metric', 'quote',
        'allocation_line', 'sale_record'
    ] LOOP
        EXECUTE format(
            'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
            t, t
        );
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Quote references (§3.7): CC-Q-0001 style, per organisation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.next_quote_reference(org uuid) RETURNS text
    LANGUAGE plpgsql
    AS $$
    DECLARE
        prefix text;
        seq integer;
    BEGIN
        SELECT quote_reference_prefix INTO prefix FROM organisation WHERE id = org;
        IF prefix IS NULL THEN
            RAISE EXCEPTION 'Unknown organisation %', org;
        END IF;

        INSERT INTO quote_counter (organisation_id, next_value)
        VALUES (org, 2)
        ON CONFLICT (organisation_id)
        DO UPDATE SET next_value = quote_counter.next_value + 1
        RETURNING CASE WHEN xmax = 0 THEN 1 ELSE quote_counter.next_value - 1 END INTO seq;

        RETURN prefix || '-' || lpad(seq::text, 4, '0');
    END;
    $$;

-- ---------------------------------------------------------------------------
-- Application role
-- ---------------------------------------------------------------------------
-- The API connects as bgs_app, which is deliberately NOT a superuser and has
-- no BYPASSRLS: row-level security therefore applies to every query it makes.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bgs_app') THEN
        CREATE ROLE bgs_app LOGIN PASSWORD 'bgs_app_dev';
    END IF;
END;
$$;

GRANT USAGE ON SCHEMA public, app TO bgs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bgs_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO bgs_app;

-- The audit log is append-only for the application (§3.10): entries can be
-- written and read, never amended or removed.
REVOKE UPDATE, DELETE ON audit_log FROM bgs_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bgs_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO bgs_app;
