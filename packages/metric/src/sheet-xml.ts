import { columnToIndex } from './fields.js';

/**
 * Minimal, targeted editing of a worksheet's XML.
 *
 * The DEFRA metric is a macro-enabled workbook full of formulas, named ranges,
 * data validation and conditional formatting. Round-tripping it through a
 * spreadsheet library would rebuild all of that from the library's own
 * understanding of the file, and anything it did not model would be lost — the
 * VBA project included.
 *
 * So instead the workbook is treated as what it is: a zip of XML parts. Only
 * the specific cells being written are touched, and every other byte of every
 * other part is carried through untouched.
 */

/** Characters XML 1.0 forbids outright, which Excel refuses to open. */
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');

export type CellValue =
  | { kind: 'number'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'blank' };

export interface CellWrite {
  /** Column letter, e.g. "AB". */
  column: string;
  row: number;
  value: CellValue;
}

export interface SheetWriteResult {
  xml: string;
  /**
   * Cells that held a formula before being written.
   *
   * In the metric this is a warning sign rather than a routine event: the
   * input sheets are input cells, so writing over a formula usually means the
   * mapping is pointing at a computed cell. Reported rather than silently
   * accepted, because the resulting workbook would look plausible and be wrong.
   */
  overwrittenFormulas: string[];
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Remove the control characters XML forbids, which Excel rejects outright. */
export function sanitiseText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, '');
}

function buildCell(reference: string, styleAttr: string, value: CellValue): string {
  switch (value.kind) {
    case 'blank':
      return `<c r="${reference}"${styleAttr}/>`;
    case 'number':
      // No `t` attribute: numeric is the default cell type, and this is what
      // makes the workbook's own formulas treat the value as a number.
      return `<c r="${reference}"${styleAttr}><v>${value.value}</v></c>`;
    case 'text': {
      const text = escapeXml(sanitiseText(value.value));
      // An inline string, so the shared string table is never touched — one
      // fewer part to keep consistent.
      return `<c r="${reference}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
    }
  }
}

/** Locate one `<c>` element for `reference` within a row's inner XML. */
function findCell(rowInner: string, reference: string): { start: number; end: number; raw: string } | null {
  const pattern = new RegExp(`<c\\b[^>]*\\br="${reference}"[^>]*(?:/>|>)`, 'g');
  const match = pattern.exec(rowInner);
  if (!match) return null;

  const start = match.index;
  if (match[0].endsWith('/>')) {
    return { start, end: start + match[0].length, raw: match[0] };
  }

  const closing = rowInner.indexOf('</c>', start);
  if (closing === -1) return null;
  const end = closing + '</c>'.length;
  return { start, end, raw: rowInner.slice(start, end) };
}

function styleAttributeOf(rawCell: string): string {
  const match = /\bs="(\d+)"/.exec(rawCell);
  return match ? ` s="${match[1]}"` : '';
}

/** Insert a cell into a row's inner XML, keeping cells in column order. */
function insertCellInOrder(rowInner: string, reference: string, cellXml: string): string {
  const targetIndex = columnToIndex(/^[A-Z]+/.exec(reference)?.[0] ?? 'A');
  const cellPattern = /<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>)/g;

  let match: RegExpExecArray | null;
  while ((match = cellPattern.exec(rowInner)) !== null) {
    const columnLetters = match[1];
    if (columnLetters && columnToIndex(columnLetters) > targetIndex) {
      return rowInner.slice(0, match.index) + cellXml + rowInner.slice(match.index);
    }
  }
  return rowInner + cellXml;
}

/** Insert a row into `<sheetData>`, keeping rows in order. */
function insertRowInOrder(sheetData: string, rowNumber: number, rowXml: string): string {
  const rowPattern = /<row\b[^>]*\br="(\d+)"[^>]*(?:\/>|>)/g;

  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(sheetData)) !== null) {
    if (Number(match[1]) > rowNumber) {
      return sheetData.slice(0, match.index) + rowXml + sheetData.slice(match.index);
    }
  }
  return sheetData + rowXml;
}

/**
 * Apply a set of cell writes to a worksheet's XML.
 *
 * Existing cells keep their style index, so number formats, borders and fills
 * the metric applies to its input cells survive the write.
 */
export function applyCellWrites(sheetXml: string, writes: readonly CellWrite[]): SheetWriteResult {
  if (writes.length === 0) return { xml: sheetXml, overwrittenFormulas: [] };

  const overwrittenFormulas: string[] = [];

  // `<sheetData/>` appears when a sheet has no rows at all.
  let xml = sheetXml.replace(/<sheetData\s*\/>/, '<sheetData></sheetData>');

  const openIndex = xml.indexOf('<sheetData');
  const closeIndex = xml.indexOf('</sheetData>');
  if (openIndex === -1 || closeIndex === -1) {
    throw new Error('Worksheet XML has no <sheetData> element; it may not be a worksheet part.');
  }
  const openEnd = xml.indexOf('>', openIndex) + 1;

  let sheetData = xml.slice(openEnd, closeIndex);

  // Grouped by row so each row's XML is located once however many cells it takes.
  const byRow = new Map<number, CellWrite[]>();
  for (const write of writes) {
    const existing = byRow.get(write.row);
    if (existing) existing.push(write);
    else byRow.set(write.row, [write]);
  }

  for (const [rowNumber, rowWrites] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const rowOpenPattern = new RegExp(`<row\\b[^>]*\\br="${rowNumber}"[^>]*(?:/>|>)`);
    const rowMatch = rowOpenPattern.exec(sheetData);

    let rowStart: number;
    let rowEnd: number;
    let rowOpenTag: string;
    let rowInner: string;

    if (!rowMatch) {
      rowOpenTag = `<row r="${rowNumber}">`;
      rowInner = '';
      rowStart = -1;
      rowEnd = -1;
    } else if (rowMatch[0].endsWith('/>')) {
      rowOpenTag = `${rowMatch[0].slice(0, -2)}>`;
      rowInner = '';
      rowStart = rowMatch.index;
      rowEnd = rowMatch.index + rowMatch[0].length;
    } else {
      rowOpenTag = rowMatch[0];
      const innerStart = rowMatch.index + rowMatch[0].length;
      const innerEnd = sheetData.indexOf('</row>', innerStart);
      if (innerEnd === -1) throw new Error(`Row ${rowNumber} has no closing tag.`);
      rowInner = sheetData.slice(innerStart, innerEnd);
      rowStart = rowMatch.index;
      rowEnd = innerEnd + '</row>'.length;
    }

    for (const write of rowWrites) {
      const reference = `${write.column}${write.row}`;
      const existing = findCell(rowInner, reference);

      if (existing) {
        if (existing.raw.includes('<f')) overwrittenFormulas.push(reference);
        const cellXml = buildCell(reference, styleAttributeOf(existing.raw), write.value);
        rowInner = rowInner.slice(0, existing.start) + cellXml + rowInner.slice(existing.end);
      } else if (write.value.kind !== 'blank') {
        // Clearing a cell that does not exist is already done.
        rowInner = insertCellInOrder(rowInner, reference, buildCell(reference, '', write.value));
      }
    }

    const rowXml = `${rowOpenTag}${rowInner}</row>`;
    sheetData =
      rowStart === -1
        ? insertRowInOrder(sheetData, rowNumber, rowXml)
        : sheetData.slice(0, rowStart) + rowXml + sheetData.slice(rowEnd);
  }

  xml = xml.slice(0, openEnd) + sheetData + xml.slice(closeIndex);
  return { xml, overwrittenFormulas };
}

/**
 * Mark the workbook so Excel recalculates everything when it is next opened.
 *
 * Values are written without evaluating the metric's formulas — nothing here
 * computes biodiversity units. Without this flag a cached result could be
 * shown alongside the new inputs, which is the one outcome worse than not
 * writing at all.
 */
export function forceFullCalcOnLoad(workbookXml: string): string {
  if (/<calcPr\b[^>]*\bfullCalcOnLoad="1"/.test(workbookXml)) return workbookXml;

  if (/<calcPr\b[^>]*\/>/.test(workbookXml)) {
    return workbookXml.replace(/<calcPr\b([^>]*)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
  }
  if (/<calcPr\b[^>]*>/.test(workbookXml)) {
    return workbookXml.replace(/<calcPr\b([^>]*)>/, '<calcPr$1 fullCalcOnLoad="1">');
  }
  // No calcPr at all: add one just before the workbook closes.
  return workbookXml.replace('</workbook>', '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>');
}
