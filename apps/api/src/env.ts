import { randomBytes } from 'node:crypto';

export interface ApiConfig {
  port: number;
  host: string;
  sessionSecret: string;
  webOrigin: string;
  storageDir: string;
  sessionTtlHours: number;
  isProduction: boolean;
  /** Default stale-quote threshold in days (§3.7, pending confirmation §5.5). */
  staleQuoteDays: number;
  /** Default buffer above 10% net gain (§4.3.4, pending confirmation §5.4). */
  netGainBufferPercent: string;
}

export function loadApiConfig(): ApiConfig {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const secret = process.env['SESSION_SECRET'];

  if (isProduction && (!secret || secret.length < 32)) {
    throw new Error(
      'SESSION_SECRET must be set to at least 32 characters in production. Generate one with: openssl rand -hex 32',
    );
  }

  return {
    port: Number(process.env['API_PORT'] ?? 3001),
    // Bound to loopback by default: this runs on your own machine until you
    // deliberately choose to deploy it.
    host: process.env['API_HOST'] ?? '127.0.0.1',
    sessionSecret: secret ?? randomBytes(32).toString('hex'),
    webOrigin: process.env['WEB_ORIGIN'] ?? 'http://localhost:5173',
    storageDir: process.env['STORAGE_DIR'] ?? './storage',
    sessionTtlHours: Number(process.env['SESSION_TTL_HOURS'] ?? 24 * 14),
    isProduction,
    staleQuoteDays: Number(process.env['STALE_QUOTE_DAYS'] ?? 60),
    netGainBufferPercent: process.env['NET_GAIN_BUFFER_PERCENT'] ?? '0.1',
  };
}
