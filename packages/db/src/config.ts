/** Connection settings, read from the environment with local defaults. */
export interface DbConfig {
  /** Connection string used to run migrations. Needs ownership of the schema. */
  migrationUrl: string;
  /**
   * Connection string the application itself uses. This should point at the
   * least-privilege `bgs_app` role, which has no BYPASSRLS — so row-level
   * security applies to every query the API makes.
   */
  appUrl: string;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

export function loadDbConfig(): DbConfig {
  const isTest = process.env['NODE_ENV'] === 'test' || process.env['VITEST'] === 'true';
  const migrationUrl = isTest
    ? required('TEST_DATABASE_URL', 'postgres://bgs:bgs_dev@127.0.0.1:5432/bgs_test')
    : required('DATABASE_URL', 'postgres://bgs:bgs_dev@127.0.0.1:5432/bgs_dev');

  const appUrl = process.env['APP_DATABASE_URL'] ?? migrationUrl.replace('//bgs:bgs_dev@', '//bgs_app:bgs_app_dev@');

  return { migrationUrl, appUrl };
}
