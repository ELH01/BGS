import { loadDbConfig } from './config.js';
import { resetDatabase, runMigrations } from './migrate.js';

const command = process.argv[2] ?? 'migrate';
const { migrationUrl } = loadDbConfig();

const redacted = migrationUrl.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@');

try {
  if (command === 'migrate') {
    const result = await runMigrations(migrationUrl);
    console.log(`Database ${redacted}`);
    if (result.applied.length === 0) {
      console.log(`Already up to date (${result.alreadyApplied.length} migrations).`);
    } else {
      for (const name of result.applied) console.log(`  applied  ${name}`);
    }
  } else if (command === 'reset') {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('Refusing to reset a production database.');
    }
    const result = await resetDatabase(migrationUrl);
    console.log(`Reset ${redacted}; applied ${result.applied.length} migrations.`);
  } else {
    throw new Error(`Unknown command "${command}". Expected "migrate" or "reset".`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
