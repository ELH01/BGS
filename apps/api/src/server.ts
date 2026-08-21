import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { loadApiConfig } from './env.js';
import { describeDatabaseError } from './http.js';
import sessionPlugin, { SESSION_COOKIE } from './auth/session.js';
import securityPlugin, { generalRateLimit } from './security.js';
import authRoutes from './routes/auth.js';
import backupRoutes from './routes/backup.js';
import configRoutes from './routes/config.js';
import developerRoutes from './routes/developers.js';
import operatorRoutes from './routes/operators.js';
import metricExportRoutes from './routes/metric-export.js';
import positionRoutes from './routes/positions.js';
import uploadRoutes from './routes/uploads.js';
import quoteExportRoutes from './routes/quote-export.js';
import quoteRoutes from './routes/quotes.js';
import solverRoutes from './routes/solver.js';
import stockRoutes from './routes/stock.js';

export async function buildServer(): Promise<FastifyInstance> {
  const config = loadApiConfig();

  const app = Fastify({
    logger: config.isProduction
      ? true
      : { level: process.env['LOG_LEVEL'] ?? 'warn' },
    // Behind a reverse proxy in a deployed setting; request.ip should then be
    // the client's, not the proxy's.
    trustProxy: config.isProduction,
    bodyLimit: 2 * 1024 * 1024,
  });

  // Sensible security headers on everything. The API serves JSON and file
  // downloads rather than pages, so the content policy can be as tight as it
  // goes: nothing here should ever be framed, scripted or embedded.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    // Only meaningful once served over TLS, which is why it is production-only.
    hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  // Registered before the rate limiter, whose key generator reads the session
  // cookie and would otherwise run before anything had parsed it.
  await app.register(cookie, { secret: config.sessionSecret });

  await app.register(rateLimit, {
    global: true,
    ...generalRateLimit(),
    // Keyed by session where there is one, so a shared office IP does not
    // throttle everyone because of one busy user.
    keyGenerator: (request) => request.cookies?.[SESSION_COOKIE] ?? request.ip,
    // statusCode included so the shape matches what the error handler expects;
    // without it a legitimate 429 surfaces as an unhandled 500.
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too many requests. Wait a moment and try again.',
    }),
  });

  // Uploads: logos and metric workbooks. Per-route limits are tighter still.
  await app.register(multipart, {
    limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 10 },
  });

  await app.register(cors, {
    // The browser client is served from a different port in development.
    // Credentials are required because the session lives in a cookie.
    origin: config.allowedOrigins,
    credentials: true,
  });

  await app.register(securityPlugin);
  await app.register(sessionPlugin);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const described = describeDatabaseError(error);
    if (described) {
      return reply.code(described.status).send({ error: described.message });
    }

    // A rate-limit rejection is a legitimate answer, not a server fault.
    if (error.statusCode === 429) {
      return reply.code(429).send({ error: 'Too many requests. Wait a moment and try again.' });
    }

    request.log.error({ err: error }, 'Unhandled request error');
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    // Internal failures are never described to the caller; a validation or
    // permission message is safe and useful.
    return reply.code(status).send({
      error: status >= 500 ? 'Something went wrong.' : error.message,
    });
  });

  await app.register(authRoutes);
  await app.register(configRoutes);
  await app.register(backupRoutes);
  await app.register(operatorRoutes);
  await app.register(developerRoutes);
  await app.register(stockRoutes);
  await app.register(quoteRoutes);
  await app.register(positionRoutes);
  await app.register(uploadRoutes);
  await app.register(metricExportRoutes);
  await app.register(quoteExportRoutes);
  await app.register(solverRoutes);

  return app;
}
