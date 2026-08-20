import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { loadApiConfig } from './env.js';

/**
 * Transport-level hardening.
 *
 * The commercially sensitive things in this system are stock levels, negotiated
 * pricing, and who is quoting whom for what. Tenant isolation is the database's
 * job and is proven separately; this file deals with everything around it —
 * keeping responses out of caches, making a stolen session hard to obtain, and
 * making a brute-force attempt expensive.
 */

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function securityPlugin(app: FastifyInstance): Promise<void> {
  const config = loadApiConfig();

  /**
   * Nothing this API returns should ever be cached.
   *
   * Quote and allocation responses are exactly the kind of thing that ends up
   * sitting in a shared proxy or on disk in a browser cache, and being read by
   * the next person at that machine. `no-store` is stronger than `no-cache`:
   * it forbids writing the response down at all.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store, no-cache, must-revalidate, private');
      reply.header('pragma', 'no-cache');
      reply.header('expires', '0');
    }
    return payload;
  });

  /**
   * Reject state-changing requests that did not come from our own front end.
   *
   * The session cookie is already SameSite=Lax, which stops a cross-site form
   * post from carrying it. This is the belt to that pair of braces, and it
   * costs one string comparison.
   *
   * Requests with no Origin at all — curl, a server-to-server call — are let
   * through, since they carry no ambient cookie authority in the first place;
   * they still need a valid session.
   */
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!STATE_CHANGING.has(request.method)) return;

    const origin = request.headers.origin;
    if (!origin) return;

    if (!config.allowedOrigins.includes(origin)) {
      request.log.warn({ origin, url: request.url }, 'Rejected cross-origin state-changing request');
      await reply.code(403).send({ error: 'Request rejected: unrecognised origin.' });
    }
  });
}

export default fp(securityPlugin, { name: 'security' });

/**
 * How hard the login endpoints are to hammer.
 *
 * Deliberately tight. An attacker with a list of email addresses and a list of
 * common passwords is the realistic route to someone else's quote book, and
 * unlike a human they do not get tired.
 *
 * Read when a server is built rather than when this module is first imported,
 * so the value is whatever the environment says at that moment. A constant
 * evaluated at import time silently ignores any later configuration, which is
 * the sort of thing that is only noticed when the limit fails to apply.
 */
export function authRateLimit(): { max: number; timeWindow: string } {
  return {
    max: Number(process.env['AUTH_RATE_LIMIT_MAX'] ?? 10),
    timeWindow: process.env['AUTH_RATE_LIMIT_WINDOW'] ?? '5 minutes',
  };
}

/** A looser limit for everything else, to blunt scraping. */
export function generalRateLimit(): { max: number; timeWindow: string } {
  return {
    max: Number(process.env['RATE_LIMIT_MAX'] ?? 600),
    timeWindow: process.env['RATE_LIMIT_WINDOW'] ?? '1 minute',
  };
}
