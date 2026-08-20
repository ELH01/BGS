import { randomBytes } from 'node:crypto';

export interface ApiConfig {
  port: number;
  host: string;
  sessionSecret: string;
  /** The browser origin the client is served from. */
  webOrigin: string;
  /**
   * Every origin allowed to make a state-changing request.
   *
   * More than one, because http://localhost:5173 and http://127.0.0.1:5173 are
   * the same server but different origins, and a person will type whichever
   * comes to hand. Rejecting one of them looks like the app is broken.
   * WEB_ORIGIN may also be a comma-separated list where a deployment serves the
   * client from more than one hostname.
   */
  allowedOrigins: string[];
  storageDir: string;
  sessionTtlHours: number;
  isProduction: boolean;
  /** Default stale-quote threshold in days (§3.7, pending confirmation §5.5). */
  staleQuoteDays: number;
  /** Default buffer above 10% net gain (§4.3.4, pending confirmation §5.4). */
  netGainBufferPercent: string;
}

/**
 * Add the other spelling of loopback to each origin.
 *
 * http://localhost:5173 and http://127.0.0.1:5173 reach the same server, and a
 * browser treats them as different origins. Configuring one should not lock
 * out the other — that reads as the app being broken rather than as a security
 * control doing its job.
 */
function withLoopbackAliases(origins: readonly string[]): string[] {
  const out = new Set<string>();
  for (const origin of origins) {
    out.add(origin);
    if (origin.includes('//localhost')) out.add(origin.replace('//localhost', '//127.0.0.1'));
    if (origin.includes('//127.0.0.1')) out.add(origin.replace('//127.0.0.1', '//localhost'));
  }
  return [...out];
}

export function loadApiConfig(): ApiConfig {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const secret = process.env['SESSION_SECRET'];

  if (isProduction && (!secret || secret.length < 32)) {
    throw new Error(
      'SESSION_SECRET must be set to at least 32 characters in production. Generate one with: openssl rand -hex 32',
    );
  }

  const port = Number(process.env['API_PORT'] ?? 3001);
  const configured = (process.env['WEB_ORIGIN'] ?? 'http://localhost:5173')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  return {
    port,
    // Bound to loopback by default: this runs on your own machine until you
    // deliberately choose to deploy it.
    host: process.env['API_HOST'] ?? '127.0.0.1',
    sessionSecret: secret ?? randomBytes(32).toString('hex'),
    webOrigin: configured[0] ?? 'http://localhost:5173',
    allowedOrigins: withLoopbackAliases([...configured, `http://localhost:${port}`, `http://127.0.0.1:${port}`]),
    storageDir: process.env['STORAGE_DIR'] ?? './storage',
    sessionTtlHours: Number(process.env['SESSION_TTL_HOURS'] ?? 24 * 14),
    isProduction,
    staleQuoteDays: Number(process.env['STALE_QUOTE_DAYS'] ?? 60),
    netGainBufferPercent: process.env['NET_GAIN_BUFFER_PERCENT'] ?? '0.1',
  };
}
