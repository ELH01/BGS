import { withoutTenantContext, type Queryable } from './client.js';

export type UserRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface LoginCandidate {
  id: string;
  organisationId: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  organisationId: string;
  organisationName: string;
  organisationSlug: string;
  isPlatformOperator: boolean;
  email: string;
  displayName: string;
  role: UserRole;
  expiresAt: Date;
}

export interface AccessibleOrganisation {
  organisationId: string;
  name: string;
  slug: string;
  /** 'own' for the user's own organisation, otherwise the granted access level. */
  access: 'own' | 'manage' | 'read';
}

export async function findUserForLogin(email: string): Promise<LoginCandidate | null> {
  return withoutTenantContext(async (db) => {
    const { rows } = await db.query<{
      id: string;
      organisation_id: string;
      email: string;
      password_hash: string;
      display_name: string;
      role: UserRole;
      is_active: boolean;
    }>('SELECT * FROM app.find_user_for_login($1)', [email]);

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      organisationId: row.organisation_id,
      email: row.email,
      passwordHash: row.password_hash,
      displayName: row.display_name,
      role: row.role,
      isActive: row.is_active,
    };
  });
}

export async function resolveSession(tokenHash: string): Promise<ResolvedSession | null> {
  return withoutTenantContext(async (db) => {
    const { rows } = await db.query<{
      session_id: string;
      user_id: string;
      organisation_id: string;
      organisation_name: string;
      organisation_slug: string;
      is_platform_operator: boolean;
      email: string;
      display_name: string;
      role: UserRole;
      expires_at: Date;
    }>('SELECT * FROM app.resolve_session($1)', [tokenHash]);

    const row = rows[0];
    if (!row) return null;

    return {
      sessionId: row.session_id,
      userId: row.user_id,
      organisationId: row.organisation_id,
      organisationName: row.organisation_name,
      organisationSlug: row.organisation_slug,
      isPlatformOperator: row.is_platform_operator,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      expiresAt: row.expires_at,
    };
  });
}

export async function createSession(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}): Promise<string> {
  return withoutTenantContext(async (db) => {
    const { rows } = await db.query<{ create_session: string }>(
      'SELECT app.create_session($1, $2, $3, $4, $5) AS create_session',
      [input.userId, input.tokenHash, input.expiresAt, input.userAgent ?? null, input.ipAddress ?? null],
    );
    const id = rows[0]?.create_session;
    if (!id) throw new Error('Failed to create session.');
    return id;
  });
}

export async function revokeSession(tokenHash: string): Promise<void> {
  await withoutTenantContext((db) => db.query('SELECT app.revoke_session($1)', [tokenHash]));
}

export async function recordLogin(userId: string): Promise<void> {
  await withoutTenantContext((db) => db.query('SELECT app.record_login($1)', [userId]));
}

export async function createOrganisationWithOwner(input: {
  organisationName: string;
  slug: string;
  quoteReferencePrefix: string;
  email: string;
  passwordHash: string;
  displayName: string;
}): Promise<{ organisationId: string; userId: string }> {
  return withoutTenantContext(async (db) => {
    const { rows } = await db.query<{ organisation_id: string; user_id: string }>(
      'SELECT * FROM app.create_organisation_with_owner($1, $2, $3, $4, $5, $6)',
      [
        input.organisationName,
        input.slug,
        input.quoteReferencePrefix,
        input.email,
        input.passwordHash,
        input.displayName,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Failed to create organisation.');
    return { organisationId: row.organisation_id, userId: row.user_id };
  });
}

/**
 * Organisations the acting organisation may work in: its own, plus any it
 * holds a live management grant over. Requires a tenant context.
 */
export async function listAccessibleOrganisations(db: Queryable): Promise<AccessibleOrganisation[]> {
  const { rows } = await db.query<{
    organisation_id: string;
    name: string;
    slug: string;
    access: AccessibleOrganisation['access'];
  }>('SELECT * FROM app.accessible_organisations()');

  return rows.map((r) => ({
    organisationId: r.organisation_id,
    name: r.name,
    slug: r.slug,
    access: r.access,
  }));
}
