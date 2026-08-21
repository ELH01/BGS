/**
 * End-to-end smoke test for the two upload journeys.
 *
 * Uploading an operator logo and seeing it on the quote document, and
 * uploading a developer's metric workbook and getting it back with the
 * off-site tabs filled in from the allocation.
 *
 * Needs the API and web dev server running against an empty database:
 *
 *   pnpm db:reset
 *   pnpm dev
 *   node scripts/smoke-uploads.mjs
 */
import { chromium } from 'playwright';
import { unzipSync, zipSync } from 'fflate';
import ExcelJS from 'exceljs';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? '.';
const errors = [];

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// A workbook shaped like the metric, with a VBA part to prove it survives.
async function metricWorkbook() {
  const workbook = new ExcelJS.Workbook();
  for (const name of [
    'D-2 Off-Site Habitat Creation',
    'E-2 Off-Site Hedge Creation',
    "F-2 Off-Site WaterC' Creation",
  ]) {
    workbook.addWorksheet(name).getCell('A1').value = `${name} header`;
  }
  workbook.addWorksheet('Start').getCell('F12').value = 'Land north of Exeter';
  const buffer = await workbook.xlsx.writeBuffer();
  const files = unzipSync(new Uint8Array(buffer));
  files['xl/vbaProject.bin'] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0x42, 0x42]);
  return Buffer.from(zipSync(files));
}

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const step = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); };

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

await step('create operator, site and a fully recorded parcel', async () => {
  await page.getByRole('link', { name: 'Bank operators' }).click();
  await page.getByRole('button', { name: 'Add operator' }).click();
  await page.fill('input[name="name"]', 'Cosdon Habitat Banks');
  await page.fill('input[name="brandingCompanyName"]', 'Cosdon Consulting Ltd');
  await page.fill('textarea[name="brandingAddress"]', 'Unit 4, Example Park, Devon');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForSelector('td:has-text("Cosdon Habitat Banks")');

  await page.getByRole('link', { name: 'Sites' }).click();
  await page.getByRole('button', { name: 'Add site' }).click();
  await page.fill('input[name="name"]', 'Home Farm');
  await page.fill('input[name="lpaCode"]', 'E07000040');
  await page.fill('input[name="ncaCode"]', 'NCA148');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForSelector('strong:has-text("Home Farm")');

  await page.getByRole('link', { name: 'Stock parcels' }).click();
  await page.getByRole('button', { name: 'Add parcel' }).click();
  await page.fill('input[name="parcelReference"]', 'F1');
  await page.fill('input[name="broadHabitat"]', 'Grassland');
  await page.fill('input[name="habitatType"]', 'Other neutral grassland');
  await page.selectOption('select[name="distinctiveness"]', 'medium');
  await page.selectOption('select[name="condition"]', 'moderate');
  await page.fill('input[name="totalUnits"]', '20.0');
  await page.fill('input[name="listPricePerUnit"]', '20000.00');
  await page.fill('input[name="extent"]', '10.0');
  await page.selectOption('select[name="strategicSignificance"]', 'formally-identified');
  await page.fill('input[name="habitatCreatedInAdvanceYears"]', '3');
  await page.fill('input[name="delayYears"]', '0');
  await page.getByRole('button', { name: 'Add parcel' }).click();
  await page.waitForSelector('.badge:has-text("complete")');
});

await step('upload the operator logo', async () => {
  await page.getByRole('link', { name: 'Bank operators' }).click();
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.waitForSelector('text=No logo uploaded');

  const path = join(tmpdir(), 'cosdon-logo.png');
  writeFileSync(path, PNG);
  await page.setInputFiles('input[type="file"]', path);
  await page.waitForSelector('img[alt$="logo"]');
});

await page.screenshot({ path: out + '/operator-logo.png', fullPage: true });

await step('add a developer and upload their metric workbook', async () => {
  await page.getByRole('link', { name: 'Developers' }).click();
  await page.getByRole('button', { name: 'Add developer' }).click();
  await page.fill('input[name="purchasingEntityName"]', 'Barratt Homes plc');
  await page.fill('input[name="developmentLpaCode"]', 'E07000040');
  await page.fill('input[name="developmentNcaCode"]', 'NCA148');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForSelector('text=none uploaded');

  const path = join(tmpdir(), 'barratt-metric.xlsm');
  writeFileSync(path, await metricWorkbook());
  await page.setInputFiles('input[type="file"]', path);
  await page.waitForSelector('a:has-text("barratt-metric.xlsm")');
});

await page.screenshot({ path: out + '/developer-metric.png', fullPage: true });

await step('quote for the developer and allocate to target', async () => {
  await page.getByRole('link', { name: 'Quotes' }).click();
  await page.getByRole('button', { name: 'New quote' }).click();
  await page.selectOption('select[name="bankOperatorId"]', { label: 'Cosdon Habitat Banks' });
  await page.fill('input[name="required-area"]', '5.0');
  await page.fill('input[name="broad-area"]', 'Grassland');
  await page.fill('input[name="type-area"]', 'Other neutral grassland');
  await page.selectOption('select[name="dist-area"]', 'medium');
  await page.getByRole('button', { name: 'Create and build allocation' }).click();
  await page.waitForSelector('h2:has-text("Area habitat")');

  await page.getByRole('button', { name: 'Use suggested split' }).click();
  await page.waitForSelector('text=/target met/');
  await page.getByRole('button', { name: 'Save allocation' }).click();
  await page.waitForSelector('text=/Allocation saved/');
});

await step('the metric write-back reports itself ready', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('a:has-text("Download developer")');
});

await page.screenshot({ path: out + '/quote-with-exports.png', fullPage: true });

await step('download the quote document, which carries the logo', async () => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download quote document' }).click(),
  ]);
  const path = join(out, 'quote.docx');
  await download.saveAs(path);

  const parts = Object.keys(unzipSync(new Uint8Array(readFileSync(path))));
  if (!parts.some((part) => part.startsWith('word/media/'))) {
    throw new Error('The quote document carries no embedded image.');
  }
});

await step("download the developer's metric with the off-site tab filled in", async () => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('a:has-text("Download developer")').click(),
  ]);
  const path = join(out, 'developer-metric-populated.xlsm');
  await download.saveAs(path);

  const bytes = new Uint8Array(readFileSync(path));
  const parts = unzipSync(bytes);
  if (!parts['xl/vbaProject.bin']) throw new Error("The developer's macros did not survive the write-back.");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(readFileSync(path));
  const sheet = workbook.getWorksheet('D-2 Off-Site Habitat Creation');
  const habitat = sheet.getCell('E11').value;
  const area = sheet.getCell('G11').value;

  if (habitat !== 'Other neutral grassland') {
    throw new Error(`Expected the habitat type in E11, found ${JSON.stringify(habitat)}.`);
  }
  // 5.005 of 20 units is a quarter of the parcel, so a quarter of its 10 ha.
  if (Math.abs(Number(area) - 2.5025) > 0.0001) {
    throw new Error(`Expected 2.5025 ha in G11, found ${JSON.stringify(area)}.`);
  }
  console.log(`      wrote ${habitat} at ${area} ha into D-2`);
});

await browser.close();

// The session probe legitimately 401s before sign-in; that is the app asking
// whether anyone is signed in, not a fault.
const unexpected = errors.filter((message) => !/401/.test(message));
if (unexpected.length > 0) {
  console.log('\nUnexpected browser console errors:');
  for (const message of unexpected) console.log('  -', message);
  process.exit(1);
}
console.log('\nUpload and write-back flows passed with no console errors.');
