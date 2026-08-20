import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { resolveSession, type ResolvedSession } from '@bgs/db';
import { loadApiConfig } from '../env.js';

export const SESSION_COOKIE = 'bgs_session';

/** Tokens are random and opaque; only their hash is ever stored. */
export function issueSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in identity, or null for an anonymous request. */
    auth: ResolvedSession | null;
  }
  interface FastifyInstance {
    /** Rejects the request with 401 unless it carries a live session. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Rejects with 403 unless the signed-in user may modify data. */
    requireWriteAccess: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

async function sessionPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    request.auth = await resolveSession(hashToken(token));
  });

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) {
      await reply.code(401).send({ error: 'Not signed in.' });
    }
  });

  app.decorate('requireWriteAccess', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) {
      await reply.code(401).send({ error: 'Not signed in.' });
      return;
    }
    if (request.auth.role === 'viewer') {
      await reply.code(403).send({ error: 'Your account has read-only access.' });
    }
  });

}

export default fp(sessionPlugin, { name: 'session' });

/** Cookie attributes for the session cookie. Secure only once deployed. */
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  const config = loadApiConfig();
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    maxAge: config.sessionTtlHours * 3600,
  };
}

/**
 * Constant-time string comparison, for anywhere a secret is compared outside
 * the password path.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
