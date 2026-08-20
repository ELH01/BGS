-- Give hand-written rule violations their own error code.
--
-- The quote status ladder and the sold-allocation guard raise messages written
-- for a person to read: "A draft quote can only become quoted or cancelled."
-- Those should reach the user unchanged.
--
-- Postgres's own constraint violations should not. Their messages name tables
-- and constraints, and their detail names the failing row — which for this
-- system means stock levels and negotiated pricing. The API must be able to
-- tell the two apart to pass one through and replace the other, and it cannot
-- do that while both arrive as check_violation.
--
-- So the hand-written ones now raise P0001 (plpgsql's own raise_exception),
-- leaving 23514 to mean only "Postgres rejected this", which the API answers
-- with a message of its own writing.

CREATE OR REPLACE FUNCTION app.enforce_quote_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        IF NEW.status = OLD.status THEN
            RETURN NEW;
        END IF;

        IF OLD.status = 'cancelled' THEN
            RAISE EXCEPTION 'Quote % is cancelled; cancelled quotes are terminal and cannot be reopened.', OLD.reference;
        END IF;

        IF OLD.status = 'sold' AND NEW.status NOT IN ('reserved', 'cancelled') THEN
            RAISE EXCEPTION 'A sold quote can only be moved to reserved or cancelled, and only by reversing the sale.';
        END IF;

        IF OLD.status = 'draft' AND NEW.status NOT IN ('quoted', 'cancelled') THEN
            RAISE EXCEPTION 'A draft quote can only become quoted or cancelled.';
        END IF;

        IF OLD.status = 'quoted' AND NEW.status NOT IN ('draft', 'reserved', 'sold', 'cancelled') THEN
            RAISE EXCEPTION 'Invalid transition from quoted to %.', NEW.status;
        END IF;

        IF OLD.status = 'reserved' AND NEW.status NOT IN ('quoted', 'sold', 'cancelled') THEN
            RAISE EXCEPTION 'Invalid transition from reserved to %.', NEW.status;
        END IF;

        RETURN NEW;
    END;
    $$;

CREATE OR REPLACE FUNCTION app.reject_sold_allocation_edit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
        current_status quote_status;
        target_quote uuid;
    BEGIN
        target_quote := COALESCE(NEW.quote_id, OLD.quote_id);
        SELECT status INTO current_status FROM quote WHERE id = target_quote;

        IF current_status = 'sold' THEN
            RAISE EXCEPTION 'Allocation lines on a sold quote cannot be changed; reverse the sale first.';
        END IF;

        RETURN COALESCE(NEW, OLD);
    END;
    $$;
