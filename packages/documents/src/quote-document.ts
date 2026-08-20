import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { DISTINCTIVENESS_LABEL, MODULE_LABEL, Money, type MetricModule, type DistinctivenessBand, type UnitQuantity } from '@bgs/core';
import { DEFAULT_VAT_CONFIG, quoteTotals, type VatConfig } from './vat.js';

/**
 * The quote document (§4.7).
 *
 * Composed programmatically from stored data rather than filled into a
 * user-supplied template. That keeps it reliably buildable: a template with
 * merge fields is a second thing that can be wrong, and the failure mode — a
 * field silently not substituting — produces a document that looks finished
 * and is not.
 *
 * Everything about how it looks comes from the bank operator's branding rather
 * than being hardcoded, so a quote drawn from a third party's stock carries
 * their identity and not Cosdon's.
 */

export interface QuoteBranding {
  companyName: string;
  address: string | null;
  contact: string | null;
  /** Hex, e.g. "#2F5D3A". Falls back to a neutral dark tone when absent. */
  accentColour: string | null;
  /** Raw image bytes and their type, when the operator has uploaded a logo. */
  logo?: { data: Uint8Array; type: 'png' | 'jpg' | 'gif' | 'bmp' } | undefined;
}

export interface QuotePurchaser {
  /** Who appears on the quote as the purchaser. */
  entityName: string;
  /** Where the invoice goes. Never the development site unless they are the same. */
  billingAddress: string | null;
  contactName?: string | null | undefined;
  contactEmail?: string | null | undefined;
}

export interface QuoteLineItem {
  module: MetricModule;
  broadHabitat: string;
  habitatType: string;
  distinctiveness: DistinctivenessBand;
  /** Units purchased, at the module's own precision. */
  quantity: UnitQuantity;
  unitPrice: Money;
  lineTotal: Money;
}

export interface QuoteDocumentInput {
  reference: string;
  date: Date;
  branding: QuoteBranding;
  purchaser: QuotePurchaser;
  lines: readonly QuoteLineItem[];
  /**
   * The shortfall per module, shown so the purchaser can see the lines meet
   * their stated need. Omitted when the quote records no requirement.
   */
  unitsRequired?: ReadonlyArray<{ module: MetricModule; requiredUnits: UnitQuantity }> | undefined;
  vat?: VatConfig | undefined;
  notes?: string | null | undefined;
  /**
   * Caveats to print on the document — an unconfirmed multiplier scheme, an
   * unconfirmed VAT position. Printed rather than suppressed: a quote that
   * rests on provisional figures should say so on its face.
   */
  caveats?: readonly string[] | undefined;
}

const DEFAULT_ACCENT = '1C231D';

function hexColour(value: string | null): string {
  if (!value) return DEFAULT_ACCENT;
  const cleaned = value.replace('#', '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(cleaned) ? cleaned : DEFAULT_ACCENT;
}

/** Split a stored multi-line address into paragraphs. */
function addressParagraphs(address: string | null, options: { bold?: boolean } = {}): Paragraph[] {
  if (!address) return [];
  return address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map(
      (line) =>
        new Paragraph({
          spacing: { after: 20 },
          children: [new TextRun({ text: line, size: 20, bold: options.bold ?? false })],
        }),
    );
}

function headerCell(text: string, accent: string, alignment: (typeof AlignmentType)[keyof typeof AlignmentType]): TableCell {
  return new TableCell({
    shading: { fill: accent },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({
        alignment,
        children: [new TextRun({ text, bold: true, size: 18, color: 'FFFFFF' })],
      }),
    ],
  });
}

function bodyCell(
  text: string,
  alignment: (typeof AlignmentType)[keyof typeof AlignmentType],
  options: { bold?: boolean; hint?: string } = {},
): TableCell {
  const children = [
    new Paragraph({
      alignment,
      children: [new TextRun({ text, size: 20, bold: options.bold ?? false })],
    }),
  ];
  if (options.hint) {
    children.push(
      new Paragraph({
        alignment,
        children: [new TextRun({ text: options.hint, size: 16, color: '5F6B60' })],
      }),
    );
  }
  return new TableCell({ margins: { top: 80, bottom: 80, left: 120, right: 120 }, children });
}

function totalsRow(label: string, value: string, accent: string, emphasise = false): TableRow {
  return new TableRow({
    children: [
      new TableCell({
        columnSpan: 3,
        borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE } },
        margins: { top: 60, bottom: 60, left: 120, right: 120 },
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: label, size: 20, bold: emphasise })],
          }),
        ],
      }),
      new TableCell({
        margins: { top: 60, bottom: 60, left: 120, right: 120 },
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({ text: value, size: 20, bold: emphasise, ...(emphasise ? { color: accent } : {}) }),
            ],
          }),
        ],
      }),
    ],
  });
}

export function buildQuoteDocument(input: QuoteDocumentInput): Document {
  const accent = hexColour(input.branding.accentColour);
  const vat = input.vat ?? DEFAULT_VAT_CONFIG;
  const totals = quoteTotals(
    input.lines.map((line) => line.lineTotal),
    vat,
  );

  const children: Array<Paragraph | Table> = [];

  // --- Letterhead -----------------------------------------------------------
  if (input.branding.logo) {
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new ImageRun({
            data: input.branding.logo.data,
            type: input.branding.logo.type,
            transformation: { width: 160, height: 60 },
          }),
        ],
      }),
    );
  }

  children.push(
    new Paragraph({
      spacing: { after: 40 },
      children: [new TextRun({ text: input.branding.companyName, bold: true, size: 28, color: accent })],
    }),
    ...addressParagraphs(input.branding.address),
    ...addressParagraphs(input.branding.contact),
  );

  // --- Title and reference --------------------------------------------------
  children.push(
    new Paragraph({
      spacing: { before: 320, after: 80 },
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: 'Biodiversity unit quotation', bold: true, size: 32, color: accent })],
    }),
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({ text: `Quote reference ${input.reference}`, size: 20, bold: true }),
        new TextRun({
          text: `  ·  ${input.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
          size: 20,
        }),
      ],
    }),
  );

  // --- Purchaser ------------------------------------------------------------
  children.push(
    new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: 'Prepared for', bold: true, size: 18, color: '5F6B60' })],
    }),
    new Paragraph({
      spacing: { after: 20 },
      children: [new TextRun({ text: input.purchaser.entityName, bold: true, size: 22 })],
    }),
    ...addressParagraphs(input.purchaser.billingAddress),
  );

  if (input.purchaser.contactName || input.purchaser.contactEmail) {
    children.push(
      new Paragraph({
        spacing: { after: 20 },
        children: [
          new TextRun({
            text: [input.purchaser.contactName, input.purchaser.contactEmail].filter(Boolean).join(' · '),
            size: 20,
          }),
        ],
      }),
    );
  }

  // --- Units required (optional) -------------------------------------------
  if (input.unitsRequired && input.unitsRequired.length > 0) {
    children.push(
      new Paragraph({
        spacing: { before: 320, after: 100 },
        children: [new TextRun({ text: 'Units required', bold: true, size: 24, color: accent })],
      }),
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({
            text: 'The off-site requirement this quotation is prepared against. Each module is reported separately.',
            size: 18,
            color: '5F6B60',
          }),
        ],
      }),
    );

    for (const requirement of input.unitsRequired) {
      children.push(
        new Paragraph({
          spacing: { after: 40 },
          children: [
            new TextRun({ text: `${MODULE_LABEL[requirement.module]}: `, size: 20 }),
            new TextRun({ text: `${requirement.requiredUnits.toString()} units`, size: 20, bold: true }),
          ],
        }),
      );
    }
  }

  // --- Line items -----------------------------------------------------------
  children.push(
    new Paragraph({
      spacing: { before: 320, after: 120 },
      children: [new TextRun({ text: 'Biodiversity units offered', bold: true, size: 24, color: accent })],
    }),
  );

  const rows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: [
        headerCell('Habitat', accent, AlignmentType.LEFT),
        headerCell('Units', accent, AlignmentType.RIGHT),
        headerCell('Price per unit', accent, AlignmentType.RIGHT),
        headerCell('Line total', accent, AlignmentType.RIGHT),
      ],
    }),
  ];

  for (const line of input.lines) {
    rows.push(
      new TableRow({
        children: [
          bodyCell(line.habitatType, AlignmentType.LEFT, {
            bold: true,
            hint: `${line.broadHabitat} · ${DISTINCTIVENESS_LABEL[line.distinctiveness]} distinctiveness · ${MODULE_LABEL[line.module]}`,
          }),
          // Rendered at exactly the module's decimal places, matching the
          // metric's own conventions rather than trimming trailing zeros.
          bodyCell(line.quantity.toString(), AlignmentType.RIGHT),
          bodyCell(line.unitPrice.format(), AlignmentType.RIGHT),
          bodyCell(line.lineTotal.format(), AlignmentType.RIGHT),
        ],
      }),
    );
  }

  // All three figures, always: the total the purchaser's finance team will
  // book, the VAT, and the amount actually payable.
  rows.push(totalsRow('Total excluding VAT', totals.net.format(), accent));
  rows.push(
    totalsRow(
      totals.vatCharged ? `VAT at ${totals.ratePercent}%` : 'VAT (not charged)',
      totals.vat.format(),
      accent,
    ),
  );
  rows.push(totalsRow('Total including VAT', totals.gross.format(), accent, true));

  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [4500, 1600, 1800, 1800],
      rows,
    }),
  );

  if (vat.registrationNumber) {
    children.push(
      new Paragraph({
        spacing: { before: 120 },
        children: [new TextRun({ text: `VAT registration ${vat.registrationNumber}`, size: 18, color: '5F6B60' })],
      }),
    );
  } else if (!totals.vatCharged) {
    children.push(
      new Paragraph({
        spacing: { before: 120 },
        children: [
          new TextRun({ text: 'No VAT is charged on this quotation.', size: 18, color: '5F6B60' }),
        ],
      }),
    );
  }

  // --- Notes and caveats ----------------------------------------------------
  if (input.notes) {
    children.push(
      new Paragraph({
        spacing: { before: 320, after: 80 },
        children: [new TextRun({ text: 'Notes', bold: true, size: 22, color: accent })],
      }),
      ...input.notes
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: line, size: 20 })] })),
    );
  }

  if (input.caveats && input.caveats.length > 0) {
    children.push(
      new Paragraph({
        spacing: { before: 320, after: 60 },
        children: [new TextRun({ text: 'Important', bold: true, size: 20, color: '6B5518' })],
      }),
      ...input.caveats.map(
        (caveat) =>
          new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({ text: caveat, size: 18, color: '6B5518' })],
          }),
      ),
    );
  }

  return new Document({
    creator: input.branding.companyName,
    title: `Quote ${input.reference}`,
    description: `Biodiversity unit quotation for ${input.purchaser.entityName}`,
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 900, right: 900 } } }, children }],
  });
}

/** Render the document to .docx bytes. */
export async function renderQuoteDocument(input: QuoteDocumentInput): Promise<Buffer> {
  return Packer.toBuffer(buildQuoteDocument(input));
}

/** A filename safe on every platform, e.g. "Quote-CC-0001.docx". */
export function quoteDocumentFilename(reference: string): string {
  return `Quote-${reference.replace(/[^A-Za-z0-9-]/g, '-')}.docx`;
}
