-- Authentication surface.
--
-- Login, session lookup and organisation signup all have to happen before an
-- organisation context exists, so they cannot go through the row-level
-- security policies — those policies are defined in terms of the very context
-- these functions establish.
--
-- Rather than granting the application role a way around RLS, each of these is
-- a narrow SECURITY DEFINER function that does exactly one thing and returns
-- only what that step needs. The application role still cannot read app_user
-- or organisation directly without a context.

-- Look up the single account a login attempt refers to.
CREATE FUNCTION app.find_user_for_login(p_email text)
RETURNS TABLE (
    id              uuid,
    organisation_id uuid,
    email           text,
    password_hash   text,
    display_name    text,
    role            user_role,
    is_active       boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT u.id, u.organisation_id, u.email, u.password_hash, u.display_name, u.role, u.is_active
      FROM app_user u
     WHERE u.email = lower(btrim(p_email))
$$;

-- Exchange a session token hash for the identity it represents.
-- Expired and revoked sessions resolve to nothing.
CREATE FUNCTION app.resolve_session(p_token_hash text)
RETURNS TABLE (
    session_id        uuid,
    user_id           uuid,
    organisation_id   uuid,
    organisation_name text,
    organisation_slug text,
    is_platform_operator boolean,
    email             text,
    display_name      text,
    role              user_role,
    expires_at        timestamptz
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    UPDATE user_session s
       SET last_seen_at = now()
      FROM app_user u
      JOIN organisation o ON o.id = u.organisation_id
     WHERE s.token_hash = p_token_hash
       AND s.user_id = u.id
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.is_active
    RETURNING s.id, u.id, o.id, o.name, o.slug, o.is_platform_operator,
              u.email, u.display_name, u.role, s.expires_at
$$;

CREATE FUNCTION app.create_session(
    p_user_id    uuid,
    p_token_hash text,
    p_expires_at timestamptz,
    p_user_agent text DEFAULT NULL,
    p_ip         inet DEFAULT NULL
) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    INSERT INTO user_session (user_id, token_hash, expires_at, user_agent, ip_address)
    VALUES (p_user_id, p_token_hash, p_expires_at, p_user_agent, p_ip)
    RETURNING id
$$;

CREATE FUNCTION app.revoke_session(p_token_hash text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    UPDATE user_session SET revoked_at = now()
     WHERE token_hash = p_token_hash AND revoked_at IS NULL
$$;

CREATE FUNCTION app.record_login(p_user_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    UPDATE app_user SET last_login_at = now() WHERE id = p_user_id
$$;

-- Create an organisation together with its first user, atomically. Used for
-- initial setup and for onboarding a third-party bank operator.
CREATE FUNCTION app.create_organisation_with_owner(
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
BEGIN
    INSERT INTO organisation (name, slug, quote_reference_prefix)
    VALUES (btrim(p_org_name), lower(btrim(p_org_slug)), upper(btrim(p_quote_prefix)))
    RETURNING id INTO new_org;

    INSERT INTO app_user (organisation_id, email, password_hash, display_name, role)
    VALUES (new_org, lower(btrim(p_email)), p_password_hash, btrim(p_display_name), 'owner')
    RETURNING id INTO new_user;

    RETURN QUERY SELECT new_org, new_user;
END;
$$;

-- Which organisations the acting one may reach: itself, plus any it holds a
-- live management grant over. Drives the organisation switcher in the UI.
CREATE FUNCTION app.accessible_organisations()
RETURNS TABLE (
    organisation_id uuid,
    name            text,
    slug            text,
    access          text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT o.id, o.name, o.slug, 'own'::text
      FROM organisation o
     WHERE o.id = app.current_organisation_id()
    UNION ALL
    SELECT o.id, o.name, o.slug, g.access::text
      FROM organisation_grant g
      JOIN organisation o ON o.id = g.subject_organisation_id
     WHERE g.grantee_organisation_id = app.current_organisation_id()
       AND g.revoked_at IS NULL
     ORDER BY 4 DESC, 2
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO bgs_app;

-- These functions run with the owner's rights, so they must not be callable by
-- anyone the application has not vouched for.
REVOKE EXECUTE ON FUNCTION app.find_user_for_login(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.resolve_session(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.create_session(uuid, text, timestamptz, text, inet) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.revoke_session(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.record_login(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.create_organisation_with_owner(text, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.can_access_organisation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_user_for_login(text) TO bgs_app;
GRANT EXECUTE ON FUNCTION app.resolve_session(text) TO bgs_app;
GRANT EXECUTE ON FUNCTION app.create_session(uuid, text, timestamptz, text, inet) TO bgs_app;
GRANT EXECUTE ON FUNCTION app.revoke_session(text) TO bgs_app;
GRANT EXECUTE ON FUNCTION app.record_login(uuid) TO bgs_app;
GRANT EXECUTE ON FUNCTION app.create_organisation_with_owner(text, text, text, text, text, text) TO bgs_app;
GRANT EXECUTE ON FUNCTION app.can_access_organisation(uuid) TO bgs_app;
