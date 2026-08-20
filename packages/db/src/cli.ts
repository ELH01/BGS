import { createInterface } from 'node:readline/promises';
import { writeFile } from 'node:fs/promises';
import { loadDbConfig } from './config.js';
import { resetDatabase, runMigrations } from './migrate.js';
import { backupDatabase, restoreDatabase } from './backup.js';

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
  } else if (command === 'backup') {
    const target = process.argv[3];
    const { data, filename } = await backupDatabase(migrationUrl);
    const path = target ?? filename;
    await writeFile(path, data);
    console.log(`Wrote ${(data.length / 1024).toFixed(0)} KB to ${path}`);
  } else if (command === 'restore') {
    const path = process.argv[4 - 1];
    if (!path) {
      throw new Error('Usage: restore <backup-file>');
    }

    // Destructive and irreversible, so it is confirmed by typing rather than
    // by a flag that can be pasted from a half-remembered command.
    console.log(`This will REPLACE everything in ${redacted} with the contents of ${path}.`);
    console.log('Anything created since that backup was taken will be lost.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Type "replace everything" to continue: ');
    rl.close();

    if (answer.trim() !== 'replace everything') {
      console.log('Cancelled. Nothing was changed.');
    } else {
      const output = await restoreDatabase(migrationUrl, path);
      console.log(output.trim() || 'Restore complete.');
    }
  } else {
    throw new Error(`Unknown command "${command}". Expected "migrate", "reset", "backup" or "restore".`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
