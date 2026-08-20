import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createOrganisationWithOwner,
  createSession,
  findUserForLogin,
  listAccessibleOrganisations,
  recordLogin,
  revokeSession,
  withTenant,
} from '@bgs/db';
import { hashPassword, verifyPassword, wasteTimeLikeAVerification } from '../auth/password.js';
import { SESSION_COOKIE, hashToken, issueSessionToken, sessionCookieOptions } from '../auth/session.js';
import { loadApiConfig } from '../env.js';
import { describeDatabaseError, parseBody } from '../http.js';

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(1024),
});

const signupSchema = z.object({
  organisationName: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Use lower-case letters, numbers and hyphens.'),
  quoteReferencePrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9-]{0,11}$/, 'Start with a letter; letters, numbers and hyphens only.')
    .default('Q'),
  email: z.string().email().max(255),
  // Length is the property that actually matters; composition rules mostly
  // push people toward predictable substitutions.
  password: z.string().min(12, 'Use at least 12 characters.').max(1024),
  displayName: z.string().trim().min(1).max(200),
});

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const config = loadApiConfig();

  app.post('/api/auth/login', async (request, reply) => {
    const body = parseBody(loginSchema, request.body, reply);
    if (!body) return;

    const email = body.email.trim().toLowerCase();
    const candidate = await findUserForLogin(email);

    // Same failure shape and comparable timing whether or not the account
    // exists, so this endpoint cannot be used to enumerate users.
    if (!candidate || !candidate.isActive) {
      await wasteTimeLikeAVerification(body.password);
      return reply.code(401).send({ error: 'Email or password is incorrect.' });
    }

    if (!(await verifyPassword(body.password, candidate.passwordHash))) {
      return reply.code(401).send({ error: 'Email or password is incorrect.' });
    }

    const { token, tokenHash } = issueSessionToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);

    await createSession({
      userId: candidate.id,
      tokenHash,
      expiresAt,
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });
    await recordLogin(candidate.id);

    return reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions()).send({
      user: {
        id: candidate.id,
        email: candidate.email,
        displayName: candidate.displayName,
        role: candidate.role,
        organisationId: candidate.organisationId,
      },
    });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await revokeSession(hashToken(token));
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  /**
   * Create an organisation and its first user.
   *
   * Open by default so the platform can be stood up on a fresh database, and
   * so a third-party bank operator can be onboarded. Set SIGNUP_OPEN=false to
   * close it once the accounts that should exist do.
   */
  app.post('/api/auth/signup', async (request, reply) => {
    if (process.env['SIGNUP_OPEN'] === 'false') {
      return reply.code(403).send({ error: 'Sign-up is closed on this instance.' });
    }

    const body = parseBody(signupSchema, request.body, reply);
    if (!body) return;

    try {
      const passwordHash = await hashPassword(body.password);
      const { organisationId, userId } = await createOrganisationWithOwner({
        organisationName: body.organisationName,
        slug: body.slug,
        quoteReferencePrefix: body.quoteReferencePrefix ?? 'Q',
        email: body.email.trim().toLowerCase(),
        passwordHash,
        displayName: body.displayName,
      });

      const { token, tokenHash } = issueSessionToken();
      await createSession({
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + config.sessionTtlHours * 3600 * 1000),
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      });

      return reply
        .code(201)
        .setCookie(SESSION_COOKIE, token, sessionCookieOptions())
        .send({ organisationId, userId });
    } catch (error) {
      const described = describeDatabaseError(error);
      if (described?.status === 409) {
        return reply.code(409).send({ error: 'That organisation slug or email address is already in use.' });
      }
      throw error;
    }
  });

  app.get('/api/auth/me', { onRequest: [app.requireAuth] }, async (request) => {
    const auth = request.auth!;
    const organisations = await withTenant(auth.organisationId, (tx) => listAccessibleOrganisations(tx));

    return {
      user: {
        id: auth.userId,
        email: auth.email,
        displayName: auth.displayName,
        role: auth.role,
      },
      organisation: {
        id: auth.organisationId,
        name: auth.organisationName,
        slug: auth.organisationSlug,
        isPlatformOperator: auth.isPlatformOperator,
      },
      // The user's own organisation plus any it manages on behalf of a client.
      accessibleOrganisations: organisations,
    };
  });
}
