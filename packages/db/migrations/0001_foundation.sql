-- Foundation: tenancy, identity, and the row-level security machinery that
-- every later table depends on.
--
-- Tenancy model
-- -------------
-- An `organisation` is the tenant. Cosdon Consulting is one; each third-party
-- bank operator that logs in to see its own stock is another.
--
-- The allocation management service — where Cosdon manages a bank on another
-- operator's behalf — is modelled as an explicit, revocable grant from the
-- data's owning organisation to the managing one. That keeps a single
-- `organisation_id` column on every domain table (so one RLS policy shape
-- covers everything) while still allowing cross-organisation management.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE organisation (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name               text NOT NULL,
    slug               text NOT NULL UNIQUE,
    -- True for the organisation running the platform (Cosdon). Used only to
    -- decide what the UI offers, never to widen data access — a platform
    -- operator still needs an explicit grant to see a client's data.
    is_platform_operator boolean NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT organisation_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT organisation_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

CREATE TYPE user_role AS ENUM ('owner', 'admin', 'member', 'viewer');

CREATE TABLE app_user (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id uuid NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    email           text NOT NULL,
    password_hash   text NOT NULL,
    display_name    text NOT NULL,
    role            user_role NOT NULL DEFAULT 'member',
    is_active       boolean NOT NULL DEFAULT true,
    last_login_at   timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT app_user_email_lowercase CHECK (email = lower(email)),
    CONSTRAINT app_user_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

-- Email identifies a person across the whole platform, not per organisation,
-- so that a login form needs no tenant selector.
CREATE UNIQUE INDEX app_user_email_key ON app_user (email);
CREATE INDEX app_user_organisation_idx ON app_user (organisation_id);

CREATE TABLE user_session (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    -- Only a hash of the session token is stored, so a database disclosure
    -- does not hand over live sessions.
    token_hash      text NOT NULL UNIQUE,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    user_agent      text,
    ip_address      inet
);

CREATE INDEX user_session_user_idx ON user_session (user_id);
CREATE INDEX user_session_expiry_idx ON user_session (expires_at) WHERE revoked_at IS NULL;

CREATE TYPE grant_access AS ENUM ('read', 'manage');

-- Cosdon managing a third party's habitat bank: the third party's
-- organisation is the subject, Cosdon's organisation is the grantee.
CREATE TABLE organisation_grant (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_organisation_id  uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    grantee_organisation_id  uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
    access                   grant_access NOT NULL DEFAULT 'manage',
    note                     text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    created_by               uuid REFERENCES app_user (id) ON DELETE SET NULL,
    revoked_at               timestamptz,
    CONSTRAINT organisation_grant_not_self CHECK (subject_organisation_id <> grantee_organisation_id)
);

CREATE UNIQUE INDEX organisation_grant_active_key
    ON organisation_grant (subject_organisation_id, grantee_organisation_id)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Application connections run as `bgs_app`, which has no BYPASSRLS. Every
-- request opens a transaction and sets `app.organisation_id` to the acting
-- user's organisation; Postgres then filters every domain table to rows that
-- organisation may see. This is deliberately belt and braces: the application
-- also scopes its queries, but a missed WHERE clause cannot leak another
-- operator's stock levels or negotiated pricing.

CREATE FUNCTION app.current_organisation_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('app.organisation_id', true), '')::uuid $$;

-- SECURITY DEFINER so the policy can consult organisation_grant even though
-- that table is itself protected.
CREATE FUNCTION app.can_access_organisation(target uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
        SELECT target IS NOT NULL
           AND app.current_organisation_id() IS NOT NULL
           AND (
                target = app.current_organisation_id()
                OR EXISTS (
                    SELECT 1 FROM organisation_grant g
                     WHERE g.subject_organisation_id = target
                       AND g.grantee_organisation_id = app.current_organisation_id()
                       AND g.revoked_at IS NULL
                )
           )
    $$;

-- Applies the standard tenant policy to a table carrying organisation_id.
CREATE FUNCTION app.apply_tenant_policy(table_name regclass) RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %s USING (app.can_access_organisation(organisation_id)) WITH CHECK (app.can_access_organisation(organisation_id))',
            table_name
        );
    END;
    $$;

-- An organisation is visible to itself and to anyone holding a grant over it.
ALTER TABLE organisation ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organisation
    USING (app.can_access_organisation(id))
    WITH CHECK (app.can_access_organisation(id));

ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;
-- Users are visible only within their own organisation. A management grant
-- conveys access to the bank data, not to the client's user accounts.
CREATE POLICY tenant_isolation ON app_user
    USING (organisation_id = app.current_organisation_id())
    WITH CHECK (organisation_id = app.current_organisation_id());

ALTER TABLE organisation_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organisation_grant
    USING (
        subject_organisation_id = app.current_organisation_id()
        OR grantee_organisation_id = app.current_organisation_id()
    )
    WITH CHECK (subject_organisation_id = app.current_organisation_id());

-- Sessions and login are handled before an organisation context exists, so
-- they are reached through a dedicated SECURITY DEFINER path rather than RLS.
