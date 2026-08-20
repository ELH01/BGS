/**
 * End-to-end smoke test: drives the real UI in a real browser.
 *
 * Complements the unit and integration suites by checking the parts they
 * cannot — that the pages render, the forms post what the API expects, and
 * that a quantity typed at five decimal places comes back displayed at its
 * module's own precision.
 *
 * Needs the API and the web dev server already running, and an empty database:
 *
 *   pnpm db:reset
 *   pnpm dev
 *   node scripts/smoke-ui.mjs
 *
 * Optional first argument is a directory to write screenshots to.
 */
import { chromium } from 'playwright';

const errors = [];
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const step = async (name, fn) => {
  await fn();
  console.log(`  ok  ${name}`);
};

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });

await step('sign-up form renders', async () => {
  await page.getByRole('button', { name: 'Set up a new organisation' }).click();
  await page.waitForSelector('input[name="organisationName"]');
});

await step('create organisation and land signed in', async () => {
  await page.fill('input[name="organisationName"]', 'Cosdon Consulting Ltd');
  await page.fill('input[name="slug"]', 'cosdon');
  await page.fill('input[name="quoteReferencePrefix"]', 'CC');
  await page.fill('input[name="displayName"]', 'Elliott Hails');
  await page.fill('input[name="email"]', 'elliott@cosdon.test');
  await page.fill('input[name="password"]', 'a-sufficiently-long-password');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForSelector('.sidebar', { timeout: 15000 });
});

await step('exposure page shows empty state', async () => {
  await page.waitForSelector('text=No stock recorded');
});

await step('create a bank operator with branding', async () => {
  await page.getByRole('link', { name: /Bank operators/ }).click();
  await page.getByRole('button', { name: 'Add operator' }).click();
  await page.fill('input[name="name"]', 'Cosdon Habitat Banks');
  await page.fill('input[name="brandingCompanyName"]', 'Cosdon Consulting Ltd');
  await page.fill('input[name="brandingAccentColour"]', '#2F5D3A');
  await page.fill('textarea[name="brandingAddress"]', 'Unit 4, Example Business Park, Devon');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForSelector('td:has-text("Cosdon Habitat Banks")');
});

await step('create a site', async () => {
  await page.getByRole('link', { name: 'Sites' }).click();
  await page.getByRole('button', { name: 'Add site' }).click();
  await page.fill('input[name="name"]', 'Home Farm');
  await page.fill('input[name="lpaCode"]', 'E07000040');
  await page.fill('input[name="lpaName"]', 'East Devon');
  await page.fill('input[name="ncaCode"]', 'NCA148');
  await page.fill('input[name="bgsRegisterReference"]', 'BGS-000123');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForSelector('strong:has-text("Home Farm")');
});

await step('add an area parcel with over-precise units', async () => {
  await page.getByRole('link', { name: 'Stock parcels' }).click();
  await page.getByRole('button', { name: 'Add parcel' }).click();
  await page.fill('input[name="parcelReference"]', 'F1');
  await page.fill('input[name="broadHabitat"]', 'Grassland');
  await page.fill('input[name="habitatType"]', 'Other neutral grassland');
  await page.selectOption('select[name="distinctiveness"]', 'medium');
  await page.selectOption('select[name="condition"]', 'moderate');
  await page.fill('input[name="totalUnits"]', '12.34567');
  await page.fill('input[name="listPricePerUnit"]', '25000.00');
  await page.getByRole('button', { name: 'Add parcel' }).click();
  await page.waitForSelector('td:has-text("12.3457")');
});

await step('parcel missing metric inputs is flagged as incomplete', async () => {
  // The workbook computes units from these, so a parcel without them cannot
  // be written into a developer's metric.
  await page.waitForSelector('.badge.over:has-text("missing")');
});

await step('add a parcel with every metric input recorded', async () => {
  await page.getByRole('button', { name: 'Add parcel' }).click();
  await page.fill('input[name="parcelReference"]', 'F2');
  await page.fill('input[name="broadHabitat"]', 'Grassland');
  await page.fill('input[name="habitatType"]', 'Other neutral grassland');
  await page.selectOption('select[name="distinctiveness"]', 'medium');
  await page.selectOption('select[name="condition"]', 'good');
  await page.fill('input[name="totalUnits"]', '11.7285');
  await page.fill('input[name="listPricePerUnit"]', '22000.00');
  await page.fill('input[name="extent"]', '5.0');
  await page.selectOption('select[name="strategicSignificance"]', 'formally-identified');
  await page.fill('input[name="habitatCreatedInAdvanceYears"]', '3');
  await page.fill('input[name="delayYears"]', '0');
  await page.getByRole('button', { name: 'Add parcel' }).click();
  await page.waitForSelector('.badge:has-text("complete")');
});

await page.screenshot({ path: (process.argv[2] ?? '.') + '/stock.png', fullPage: true });

await step('add a hedgerow parcel, held at 3dp', async () => {
  await page.getByRole('button', { name: 'Add parcel' }).click();
  await page.selectOption('select[name="module"]', 'hedgerow');
  await page.fill('input[name="parcelReference"]', 'H1');
  await page.fill('input[name="broadHabitat"]', 'Hedgerow');
  await page.fill('input[name="habitatType"]', 'Native hedgerow');
  await page.fill('input[name="totalUnits"]', '4.5678');
  await page.getByRole('button', { name: 'Add parcel' }).click();
  await page.waitForSelector('td:has-text("4.568")');
});

await step('edit a list price inline', async () => {
  await page.getByRole('button', { name: '—' }).first().click();
  await page.keyboard.type('12500.50');
  await page.keyboard.press('Enter');
  await page.waitForSelector('button:has-text("£12,500.50")');
});

await step('exposure shows both modules with correct precision', async () => {
  await page.getByRole('link', { name: 'Exposure' }).click();
  await page.waitForSelector('h2:has-text("Area habitat")');
  await page.waitForSelector('h2:has-text("Hedgerow")');
  await page.waitForSelector('td:has-text("12.3457")');
  await page.waitForSelector('td:has-text("4.568")');
});

await step('unconfirmed multiplier warning is visible', async () => {
  await page.waitForSelector('text=/has not been confirmed/');
});

await page.screenshot({ path: (process.argv[2] ?? '.') + '/exposure.png', fullPage: true });

await step('configuration page lists outstanding confirmations', async () => {
  await page.getByRole('link', { name: /Configuration/ }).click();
  await page.waitForSelector('h2:has-text("Spatial risk multipliers")');
  await page.waitForSelector('text=/still to be confirmed/');
});

await page.screenshot({ path: (process.argv[2] ?? '.') + '/settings.png', fullPage: true });

await step('sign out returns to the sign-in screen', async () => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForSelector('text=Sign in to your organisation.');
});

await browser.close();

// The session probe returns 401 before sign-in and again after sign-out, which
// is the app asking whether anyone is signed in — not a fault.
const unexpected = errors.filter((message) => !/401/.test(message));

if (unexpected.length > 0) {
  console.log('\nUnexpected browser console errors:');
  for (const message of unexpected) console.log('  -', message);
  process.exit(1);
}
console.log('\nAll UI steps passed with no console errors.');
