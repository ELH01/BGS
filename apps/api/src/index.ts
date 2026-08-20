import { closePool } from '@bgs/db';
import { loadApiConfig } from './env.js';
import { buildServer } from './server.js';

const config = loadApiConfig();
const app = await buildServer();

if (!config.isProduction && !process.env['SESSION_SECRET']) {
  app.log.warn(
    'SESSION_SECRET is not set; a random one has been generated for this run. Existing sessions will not survive a restart.',
  );
}

try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`API listening on http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await app.close();
      await closePool();
      process.exit(0);
    })();
  });
}
