-- The first organisation on an instance runs it.
--
-- `organisation.is_platform_operator` has existed since the first migration but
-- nothing ever set it, so on a fresh install nobody could take a whole-instance
-- backup — the one action reserved for whoever runs the platform.
--
-- Whoever stands the instance up is that person, so the first organisation
-- created gets the flag and every later one (a third-party bank operator being
-- onboarded) does not. It confers no data access on its own: reaching another
-- organisation's records still needs an explicit grant, and the row-level
-- security policies do not consult this column.

CREATE OR REPLACE FUNCTION app.create_organisation_with_owner(
    p_org_name      text,
    p_org_slug      text,
    p_quote_prefix  text,
    p_email         text,
    p_password_hash text,
    p_display_name  text
) RETURNS TABLE (organisation_id uuid, user_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    new_org uuid;
    new_user uuid;
    is_first boolean;
BEGIN
    SELECT NOT EXISTS (SELECT 1 FROM organisation) INTO is_first;

    INSERT INTO organisation (name, slug, quote_reference_prefix, is_platform_operator)
    VALUES (btrim(p_org_name), lower(btrim(p_org_slug)), upper(btrim(p_quote_prefix)), is_first)
    RETURNING id INTO new_org;

    INSERT INTO app_user (organisation_id, email, password_hash, display_name, role)
    VALUES (new_org, lower(btrim(p_email)), p_password_hash, btrim(p_display_name), 'owner')
    RETURNING id INTO new_user;

    RETURN QUERY SELECT new_org, new_user;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.create_organisation_with_owner(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_organisation_with_owner(text, text, text, text, text, text) TO bgs_app;
