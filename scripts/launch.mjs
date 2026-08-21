#!/usr/bin/env node
/**
 * One-click launcher for daily local use.
 *
 * Brings up the database, applies any pending migrations, starts the API and
 * web client, waits until the client actually answers, and opens the browser.
 *
 * Written for the person using the platform rather than the person building
 * it: every failure it can anticipate is reported as a sentence saying what to
 * do next, not as a stack trace. Nothing here reaches the network beyond
 * loopback and the container runtime.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = join(ROOT, 'logs');
const LOG_FILE = join(LOG_DIR, 'launch.log');
const WEB_URL = 'http://localhost:5173';
const CONTAINER = 'bgs-postgres';
const IS_WINDOWS = process.platform === 'win32';
const PNPM = IS_WINDOWS ? 'pnpm.cmd' : 'pnpm';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
};

function log(message) {
  process.stdout.write(message + '\n');
}
function step(message) {
  log(`${C.dim}  ...${C.reset} ${message}`);
}
function ok(message) {
  log(`${C.green}  OK ${C.reset} ${message}`);
}
function warn(message) {
  log(`${C.yellow}  !  ${C.reset} ${message}`);
}

/** Report a problem in terms of what to do about it, then stop. */
function fail(problem, remedy) {
  log('');
  log(`${C.red}${C.bold}  Could not start.${C.reset}`);
  log(`  ${problem}`);
  if (remedy) {
    log('');
    log(`  ${C.bold}What to do:${C.reset} ${remedy}`);
  }
  log('');
  log(`  ${C.dim}Full output: ${LOG_FILE}${C.reset}`);
  waitForKeypressThenExit(1);
}

/**
 * Hold the window open on failure.
 *
 * A double-clicked launcher closes its terminal the moment the process exits,
 * which would take the error message with it.
 */
function waitForKeypressThenExit(code) {
  if (!process.stdin.isTTY) process.exit(code);
  log(`  ${C.dim}Press Enter to close.${C.reset}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question('', () => {
    rl.close();
    process.exit(code);
  });
}

function record(text) {
  try {
    appendFileSync(LOG_FILE, text);
  } catch {
    // Logging must never be the reason the app will not start.
  }
}

/** Run a command to completion, capturing output for the log. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: IS_WINDOWS,
    ...options,
  });
  record(`\n$ ${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- environment ------------------------------------------------------------

/**
 * Read .env into a plain object, creating it on first run.
 *
 * The generated SESSION_SECRET matters more than it looks: without one the API
 * invents a new secret at every startup, which silently signs you out each time
 * the launcher is used.
 */
function loadEnvFile() {
  const envPath = join(ROOT, '.env');

  if (!existsSync(envPath)) {
    const examplePath = join(ROOT, '.env.example');
    if (!existsSync(examplePath)) {
      fail('There is no .env or .env.example in the project folder.', 'Re-download the project — a file is missing.');
    }
    const seeded = readFileSync(examplePath, 'utf8').replace(
      /^SESSION_SECRET=.*$/m,
      `SESSION_SECRET=${randomBytes(32).toString('hex')}`,
    );
    writeFileSync(envPath, seeded, { mode: 0o600 });
    ok('Created .env with a freshly generated session secret.');
  }

  const env = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }

  // An unchanged placeholder secret is the same problem as no secret at all.
  if (!env['SESSION_SECRET'] || env['SESSION_SECRET'].startsWith('change-me')) {
    const generated = randomBytes(32).toString('hex');
    const updated = readFileSync(envPath, 'utf8').replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${generated}`);
    writeFileSync(envPath, updated, { mode: 0o600 });
    env['SESSION_SECRET'] = generated;
    ok('Replaced the placeholder session secret with a generated one.');
  }

  return env;
}

/**
 * Whether the configured database already answers.
 *
 * If it does, Docker is irrelevant — the project has always supported pointing
 * DATABASE_URL at your own Postgres, and someone who has done that should not
 * be told to install a container runtime they do not use.
 */
async function databaseAlreadyReachable(databaseUrl) {
  if (!databaseUrl) return false;
  let host;
  let port;
  try {
    const parsed = new URL(databaseUrl);
    host = parsed.hostname;
    port = Number(parsed.port || 5432);
  } catch {
    return false;
  }

  const { Socket } = await import('node:net');
  return new Promise((resolve) => {
    const socket = new Socket();
    const settle = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
    socket.connect(port, host);
  });
}

// --- prerequisites ----------------------------------------------------------

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    fail(
      `This needs Node 20 or newer. You have ${process.versions.node}.`,
      'Install the current LTS release from https://nodejs.org and run the launcher again.',
    );
  }
}

function checkPnpm() {
  if (run(PNPM, ['--version']).status !== 0) {
    fail('pnpm is not installed.', 'Open a terminal and run:  npm install -g pnpm');
  }
}

function checkDependencies() {
  if (existsSync(join(ROOT, 'node_modules'))) return;
  step('Installing dependencies (first run only, this takes a few minutes)...');
  if (run(PNPM, ['install'], { stdio: 'inherit' }).status !== 0) {
    fail('Dependencies failed to install.', `Open a terminal in this folder and run:  pnpm install`);
  }
  ok('Dependencies installed.');
}

/** True once the Docker daemon answers, not merely once the CLI exists. */
function dockerIsRunning() {
  return run('docker', ['info']).status === 0;
}

async function ensureDocker() {
  if (run('docker', ['--version']).status !== 0) {
    fail(
      'Docker is not installed. The database runs inside it.',
      'Install Docker Desktop from https://docker.com/products/docker-desktop then run the launcher again.',
    );
  }

  if (dockerIsRunning()) return;

  const hasDesktop = process.platform === 'darwin' || IS_WINDOWS;
  if (!hasDesktop) {
    fail(
      'The Docker daemon is installed but not running.',
      'Start it with:  sudo systemctl start docker',
    );
  }

  step('Docker is not running — starting it (this can take a minute)...');
  if (process.platform === 'darwin') run('open', ['-a', 'Docker']);
  else run('cmd', ['/c', 'start', '""', '"Docker Desktop"']);

  // Docker Desktop takes its time on a cold start; a short timeout here would
  // be a false alarm. Progress is shown so the wait does not look like a hang.
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(2000);
    if (dockerIsRunning()) {
      process.stdout.write('\n');
      ok('Docker is running.');
      return;
    }
    process.stdout.write(`${C.dim}.${C.reset}`);
  }

  process.stdout.write('\n');
  fail(
    'Docker did not finish starting after two minutes.',
    'Start Docker Desktop yourself, wait until it reports it is running, then use the launcher again.',
  );
}

async function ensureDatabase() {
  step('Starting the database...');
  if (run('docker', ['compose', 'up', '-d']).status !== 0) {
    fail('The database container would not start.', `Check ${LOG_FILE} for what Docker reported.`);
  }

  // The container being up is not the same as Postgres being ready to accept
  // a connection, and migrations run immediately after this.
  for (let attempt = 0; attempt < 45; attempt++) {
    const health = run('docker', ['inspect', '--format', '{{.State.Health.Status}}', CONTAINER]);
    if (health.stdout.trim() === 'healthy') {
      databaseStarted = true;
      ok('Database ready.');
      return;
    }
    await sleep(1000);
  }

  fail('The database started but never reported itself healthy.', `Check ${LOG_FILE}, or run:  docker compose logs postgres`);
}

function applyMigrations() {
  step('Checking for database updates...');
  const result = run(PNPM, ['db:migrate']);
  if (result.status !== 0) {
    fail('The database schema could not be brought up to date.', `Check ${LOG_FILE} for the error.`);
  }
  const applied = (result.stdout.match(/applied/gi) ?? []).length;
  ok(applied > 0 ? 'Database updated.' : 'Database up to date.');
}

// --- servers ----------------------------------------------------------------

const children = [];

function startServer(name, filter) {
  const child = spawn(PNPM, ['--filter', filter, 'dev'], {
    cwd: ROOT,
    shell: IS_WINDOWS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const capture = (stream) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => record(`[${name}] ${chunk}`));
  };
  capture(child.stdout);
  capture(child.stderr);

  child.on('exit', (code) => {
    // A server dying after startup leaves the browser tab looking merely
    // broken, so say so in the window the launcher opened.
    if (code !== 0 && !shuttingDown) {
      warn(`The ${name} server stopped unexpectedly (exit code ${code}). See ${LOG_FILE}`);
    }
  });

  children.push({ name, child });
  return child;
}

async function waitForWeb() {
  step('Starting the application...');
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(1000);
    try {
      const response = await fetch(WEB_URL, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // Not up yet. Expected for the first few seconds.
    }
  }
  return false;
}

function openBrowser(url) {
  if (process.platform === 'darwin') run('open', [url]);
  else if (IS_WINDOWS) run('cmd', ['/c', 'start', '""', url]);
  else run('xdg-open', [url]);
}

let shuttingDown = false;
let databaseStarted = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  log('');
  step('Shutting down...');
  for (const { child } of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }

  // The database is deliberately left running: it holds no session state, and
  // stopping it makes the next launch slower for no benefit. Stop it with
  // `docker compose down` if you want the container gone.
  if (databaseStarted) {
    log(`${C.dim}  The database is still running. Closing it is not necessary.${C.reset}`);
  }
  log('');
  process.exit(0);
}

// --- main -------------------------------------------------------------------

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(LOG_FILE, `Launch at ${new Date().toISOString()}\n`);

  log('');
  log(`${C.bold}  Habitat Bank Operations Platform${C.reset}`);
  log(`${C.dim}  Everything runs on this machine. No data leaves it.${C.reset}`);
  log('');

  checkNode();
  checkPnpm();
  const env = loadEnvFile();
  checkDependencies();

  if (await databaseAlreadyReachable(env['DATABASE_URL'])) {
    ok('Database already running.');
  } else {
    await ensureDocker();
    await ensureDatabase();
  }

  applyMigrations();

  startServer('api', '@bgs/api');
  startServer('web', '@bgs/web');

  if (!await waitForWeb()) {
    fail('The application did not finish starting.', `Check ${LOG_FILE} for what the API or web server reported.`);
  }

  ok('Running.');
  log('');
  log(`  ${C.bold}${WEB_URL}${C.reset}`);
  log('');
  log(`${C.dim}  Opening your browser. Keep this window open while you work —${C.reset}`);
  log(`${C.dim}  closing it, or pressing Ctrl+C, shuts the application down.${C.reset}`);
  log('');

  openBrowser(WEB_URL);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((error) => {
  record(`\nUnexpected error:\n${error?.stack ?? String(error)}\n`);
  fail(`Something unexpected went wrong: ${error?.message ?? error}`, `The details are in ${LOG_FILE}`);
});
