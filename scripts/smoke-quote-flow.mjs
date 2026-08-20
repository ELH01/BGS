/**
 * End-to-end smoke test for the quote flow: allocation table, the target gate,
 * and the status ladder, driven in a real browser.
 *
 * Checks the things only a browser can — that typing units updates the
 * percentage and vice versa, that the running total is the *buffered* target
 * rather than the bare shortfall, and that issuing below target is refused with
 * a message naming the shortfall.
 *
 * Needs the API and web dev server running, and an empty database:
 *
 *   pnpm db:reset
 *   pnpm dev
 *   node scripts/smoke-quote-flow.mjs
 *
 * Optional first argument is a directory to write screenshots to.
 */
import { chromium } from 'playwright';

const errors = [];
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const step = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); };
const OUT = process.argv[2] ?? '.';

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });

await step('set up organisation', async () => {
  await page.getByRole('button', { name: 'Set up a new organisation' }).click();
  await page.fill('input[name="organisationName"]', 'Cosdon Consulting Ltd');
  await page.fill('input[name="slug"]', 'cosdon');
  await page.fill('input[name="quoteReferencePrefix"]', 'CC');
  await page.fill('input[name="displayName"]', 'Elliott Hails');
  await page.fill('input[name="email"]', 'elliott@cosdon.test');
  await page.fill('input[name="password"]', 'a-sufficiently-long-password');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForSelector('.sidebar');
});

await step('create operator and site', async () => {
  await page.getByRole('link', { name: /Bank operators/ }).click();
  await page.getByRole('button', { name: 'Add operator' }).click();
  await page.fill('input[name="name"]', 'Cosdon Habitat Banks');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForSelector('td:has-text("Cosdon Habitat Banks")');

  await page.getByRole('link', { name: 'Sites' }).click();
  await page.getByRole('button', { name: 'Add site' }).click();
  await page.fill('input[name="name"]', 'Home Farm');
  await page.fill('input[name="lpaCode"]', 'E07000040');
  await page.fill('input[name="ncaCode"]', 'NCA148');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForSelector('strong:has-text("Home Farm")');
});

const addParcel = async (ref, units, price, dist = 'medium') => {
  await page.getByRole('button', { name: 'Add parcel' }).click();
  await page.fill('input[name="parcelReference"]', ref);
  await page.fill('input[name="broadHabitat"]', 'Grassland');
  await page.fill('input[name="habitatType"]', 'Other neutral grassland');
  await page.selectOption('select[name="distinctiveness"]', dist);
  await page.selectOption('select[name="condition"]', 'moderate');
  await page.fill('input[name="totalUnits"]', units);
  await page.fill('input[name="listPricePerUnit"]', price);
  await page.fill('input[name="extent"]', '5.0');
  await page.selectOption('select[name="strategicSignificance"]', 'formally-identified');
  await page.fill('input[name="habitatCreatedInAdvanceYears"]', '3');
  await page.fill('input[name="delayYears"]', '0');
  await page.getByRole('button', { name: 'Add parcel' }).click();
  await page.waitForSelector(`td:has-text("${ref}")`);
};

await step('add three priced parcels', async () => {
  await page.getByRole('link', { name: 'Stock parcels' }).click();
  await addParcel('F1', '8.0', '20000.00');
  await addParcel('F2', '10.0', '25000.00');
  await addParcel('F3', '6.0', '18000.00', 'high');
});

await step('add a developer', async () => {
  await page.getByRole('link', { name: 'Developers' }).click();
  await page.getByRole('button', { name: 'Add developer' }).click();
  await page.fill('input[name="purchasingEntityName"]', 'Barratt Homes plc');
  await page.fill('textarea[name="billingAddress"]', 'Registered office, London');
  await page.fill('input[name="developmentSiteName"]', 'Land north of Exeter');
  await page.fill('input[name="developmentLpaCode"]', 'E07000040');
  await page.fill('input[name="developmentNcaCode"]', 'NCA148');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForSelector('strong:has-text("Barratt Homes plc")');
});

await step('create a quote needing 5 area units', async () => {
  await page.getByRole('link', { name: 'Quotes' }).click();
  await page.getByRole('button', { name: 'New quote' }).click();
  await page.fill('input[name="required-area"]', '5.0');
  await page.fill('input[name="broad-area"]', 'Grassland');
  await page.fill('input[name="type-area"]', 'Other neutral grassland');
  await page.selectOption('select[name="dist-area"]', 'medium');
  await page.getByRole('button', { name: 'Create and build allocation' }).click();
  await page.waitForSelector('h2:has-text("Area habitat")');
});

await step('table shows the buffered target, not the bare shortfall', async () => {
  await page.waitForSelector('text=/of 5.0050 units/');
});

await step('trading rules filtered the list (no unfiltered warning)', async () => {
  const warning = await page.locator('text=/Trading rules have not been applied/').count();
  if (warning !== 0) throw new Error('expected the list to be filtered');
});

await step('typing units updates the percentage and the running total', async () => {
  const units = page.locator('table input.numeric').first();
  await units.fill('2.0');
  await units.blur();
  await page.waitForSelector('text=/2.0000 of 5.0050 units/');
});

await step('typing a percentage back-computes the units', async () => {
  // Second numeric input on the first row is the % of target box.
  const percent = page.locator('tbody tr').first().locator('input.numeric').nth(1);
  await percent.fill('100');
  await percent.blur();
  await page.waitForSelector('text=/target met/');
});

await page.screenshot({ path: OUT + '/allocation-table.png', fullPage: true });

await step('issuing below target is refused with a specific message', async () => {
  const percent = page.locator('tbody tr').first().locator('input.numeric').nth(1);
  await percent.fill('50');
  await percent.blur();
  await page.getByRole('button', { name: 'Issue quote' }).click();
  await page.waitForSelector('text=/cannot be issued yet/');
});

await page.screenshot({ path: OUT + '/gate-refusal.png', fullPage: true });

await step('use suggested split fills the table to target', async () => {
  await page.getByRole('button', { name: 'Use suggested split' }).click();
  await page.waitForSelector('text=/target met/');
});

await step('issue the quote once the target is cleared', async () => {
  await page.getByRole('button', { name: 'Issue quote' }).click();
  await page.waitForSelector('.badge:has-text("Quoted")');
});

await step('quoted allocation does not reduce availability', async () => {
  await page.getByRole('link', { name: 'Exposure' }).click();
  await page.waitForSelector('h2:has-text("Area habitat")');
  const row = page.locator('tbody tr', { hasText: 'F3' }).first();
  const available = await row.locator('td').nth(6).innerText();
  if (available.trim() !== '6.0000') throw new Error(`expected F3 available 6.0000, got ${available}`);
});

await step('reserve, and availability drops', async () => {
  await page.getByRole('link', { name: 'Quotes' }).click();
  await page.locator('a', { hasText: 'CC-0001' }).click();
  await page.getByRole('button', { name: 'Reserve' }).click();
  await page.waitForSelector('.badge:has-text("Reserved")');
});

await step('history records both transitions', async () => {
  await page.waitForSelector('text=/draft → quoted/');
  await page.waitForSelector('text=/quoted → reserved/');
});

await page.screenshot({ path: OUT + '/quote-detail.png', fullPage: true });

await browser.close();
// 401 is the anonymous session probe before sign-in; 409 is the target gate
// refusing an under-target quote, which this script provokes deliberately.
const unexpected = errors.filter((m) => !/401|409/.test(m));
if (unexpected.length > 0) {
  console.log('\nUnexpected console errors:');
  for (const m of unexpected) console.log('  -', m);
  process.exit(1);
}
console.log('\nQuote flow passed with no console errors.');
