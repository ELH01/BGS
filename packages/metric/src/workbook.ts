import { unzipSync, zipSync } from 'fflate';
import { applyCellWrites, forceFullCalcOnLoad, type CellWrite } from './sheet-xml.js';

/**
 * Opens a metric workbook as the zip of XML parts it is, patches only the
 * cells asked for, and writes it back with every other part carried through
 * unchanged.
 *
 * Carrying parts through untouched is the point. The statutory metric is a
 * macro-enabled workbook, and `xl/vbaProject.bin` — along with the data
 * validation, conditional formatting and named ranges the metric relies on —
 * survives simply because nothing here looks at it.
 */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Earliest timestamp the zip format can store. */
const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1));

export interface SheetCellWrites {
  /** Sheet name exactly as it appears in the workbook. */
  sheet: string;
  writes: readonly CellWrite[];
}

export interface WorkbookPatchResult {
  file: Uint8Array;
  /** Cells that held a formula before being written. See sheet-xml.ts. */
  overwrittenFormulas: string[];
  sheetsWritten: string[];
}

interface SheetLocation {
  name: string;
  path: string;
}

function readPart(files: Record<string, Uint8Array>, path: string): string {
  const part = files[path];
  if (!part) {
    throw new Error(`Workbook is missing ${path}; it does not look like an Excel file.`);
  }
  return decoder.decode(part);
}

/**
 * Map sheet names to their part paths, via the workbook's relationships.
 *
 * Sheet order in `workbook.xml` does not reliably match the `sheetN.xml`
 * numbering, so the relationship id is the only dependable link between a name
 * and a file.
 */
function locateSheets(files: Record<string, Uint8Array>): SheetLocation[] {
  const workbookXml = readPart(files, 'xl/workbook.xml');
  const relsXml = readPart(files, 'xl/_rels/workbook.xml.rels');

  const relationships = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (!id || !target) continue;
    const normalised = target.replace(/^\/xl\//, '').replace(/^\.\//, '');
    relationships.set(id, normalised.startsWith('xl/') ? normalised : `xl/${normalised}`);
  }

  const sheets: SheetLocation[] = [];
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const tag = match[0];
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    const relationId = /\br:id="([^"]+)"/.exec(tag)?.[1];
    if (!name || !relationId) continue;
    const path = relationships.get(relationId);
    if (path) sheets.push({ name: decodeXmlEntities(name), path });
  }
  return sheets;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function listSheetNames(workbook: Uint8Array): string[] {
  return locateSheets(unzipSync(workbook)).map((sheet) => sheet.name);
}

/**
 * Write cells into a workbook.
 *
 * The input buffer is not modified; a new one is returned, so the developer's
 * original workbook is never altered in place (§4.7 asks for the allocation to
 * be written into a *copy*).
 */
export function patchWorkbook(
  workbook: Uint8Array,
  sheetWrites: readonly SheetCellWrites[],
): WorkbookPatchResult {
  const files = unzipSync(workbook);
  const sheets = locateSheets(files);
  const byName = new Map(sheets.map((sheet) => [sheet.name, sheet.path]));

  const overwrittenFormulas: string[] = [];
  const sheetsWritten: string[] = [];

  for (const { sheet, writes } of sheetWrites) {
    if (writes.length === 0) continue;

    const path = byName.get(sheet);
    if (!path) {
      throw new Error(
        `Worksheet "${sheet}" not found. The workbook contains: ${sheets.map((s) => s.name).join(', ')}.`,
      );
    }

    const result = applyCellWrites(readPart(files, path), writes);
    files[path] = encoder.encode(result.xml);
    sheetsWritten.push(sheet);
    for (const reference of result.overwrittenFormulas) {
      overwrittenFormulas.push(`${sheet}!${reference}`);
    }
  }

  if (sheetsWritten.length > 0) {
    files['xl/workbook.xml'] = encoder.encode(forceFullCalcOnLoad(readPart(files, 'xl/workbook.xml')));
  }

  return {
    // Fixed mtime so the same inputs produce the same bytes, which makes the
    // output diffable and testable. The zip format cannot represent anything
    // before 1980, so that is the floor.
    file: zipSync(files, { level: 6, mtime: ZIP_EPOCH }),
    overwrittenFormulas,
    sheetsWritten,
  };
}

/** Whether a workbook carries a VBA project, i.e. whether it is macro-enabled. */
export function hasVbaProject(workbook: Uint8Array): boolean {
  return 'xl/vbaProject.bin' in unzipSync(workbook);
}
