import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { loadApiConfig } from './env.js';
import { describeDatabaseError } from './http.js';
import sessionPlugin from './auth/session.js';
import authRoutes from './routes/auth.js';
import configRoutes from './routes/config.js';
import developerRoutes from './routes/developers.js';
import operatorRoutes from './routes/operators.js';
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

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(cors, {
    // The browser client is served from a different port in development.
    // Credentials are required because the session lives in a cookie.
    origin: config.webOrigin,
    credentials: true,
  });

  await app.register(sessionPlugin);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const described = describeDatabaseError(error);
    if (described) {
      return reply.code(described.status).send({ error: described.message });
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
  await app.register(operatorRoutes);
  await app.register(developerRoutes);
  await app.register(stockRoutes);
  await app.register(quoteRoutes);
  await app.register(quoteExportRoutes);
  await app.register(solverRoutes);

  return app;
}
