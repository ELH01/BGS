import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { Money, UnitQuantity } from '@bgs/core';
import { quoteDocumentFilename, renderQuoteDocument, type QuoteDocumentInput } from './quote-document.js';
import { DEFAULT_VAT_CONFIG, quoteTotals, type VatConfig } from './vat.js';

/** The document's visible text, read back out of the .docx itself. */
async function documentText(input: QuoteDocumentInput): Promise<string> {
  const buffer = await renderQuoteDocument(input);
  const files = unzipSync(new Uint8Array(buffer));
  const xml = new TextDecoder().decode(files['word/document.xml']!);
  // Paragraph and cell breaks become spaces so adjacent runs stay separable.
  return xml
    .replace(/<\/w:(p|tc)>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const line = (over: Partial<QuoteDocumentInput['lines'][number]> = {}) => ({
  module: 'area' as const,
  broadHabitat: 'Grassland',
  habitatType: 'Other neutral grassland',
  distinctiveness: 'medium' as const,
  quantity: UnitQuantity.of('area', '2.3457'),
  unitPrice: Money.of('20000'),
  lineTotal: Money.lineTotal(Money.of('20000'), UnitQuantity.of('area', '2.3457')),
  ...over,
});

const input = (over: Partial<QuoteDocumentInput> = {}): QuoteDocumentInput => ({
  reference: 'CC-0001',
  date: new Date('2026-08-20T00:00:00Z'),
  branding: {
    companyName: 'Cosdon Consulting Ltd',
    address: 'Unit 4, Example Business Park\nDevon\nEX1 1AA',
    contact: 'hello@cosdon.example · 01392 000000',
    accentColour: '#2F5D3A',
  },
  purchaser: {
    entityName: 'Barratt Homes plc',
    billingAddress: 'Registered Office\n1 Example Street\nLondon\nEC1A 1AA',
    contactName: 'A Buyer',
    contactEmail: 'buyer@example.test',
  },
  lines: [line()],
  ...over,
});

describe('branding comes from the bank operator, not the platform (§3.1, §4.7)', () => {
  it('prints the operator’s own name, address and contact details', async () => {
    const text = await documentText(input());
    expect(text).toContain('Cosdon Consulting Ltd');
    expect(text).toContain('Unit 4, Example Business Park');
    expect(text).toContain('EX1 1AA');
    expect(text).toContain('hello@cosdon.example');
  });

  it('carries a different operator’s branding without a code change', async () => {
    const text = await documentText(
      input({
        branding: {
          companyName: 'Rival Habitat Banks Ltd',
          address: 'The Old Barn\nSomerset',
          contact: null,
          accentColour: '#8B1A1A',
        },
      }),
    );
    expect(text).toContain('Rival Habitat Banks Ltd');
    expect(text).not.toContain('Cosdon');
  });

  it('uses the accent colour it was given', async () => {
    const buffer = await renderQuoteDocument(input());
    const xml = new TextDecoder().decode(unzipSync(new Uint8Array(buffer))['word/document.xml']!);
    expect(xml).toContain('2F5D3A');
  });

  it('falls back to a neutral tone rather than failing on a bad colour', async () => {
    const buffer = await renderQuoteDocument(
      input({ branding: { ...input().branding, accentColour: 'forest green' } }),
    );
    const xml = new TextDecoder().decode(unzipSync(new Uint8Array(buffer))['word/document.xml']!);
    expect(xml).toContain('1C231D');
  });

  it('embeds a logo when the operator has one', async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const buffer = await renderQuoteDocument(
      input({ branding: { ...input().branding, logo: { data: png, type: 'png' } } }),
    );
    const files = unzipSync(new Uint8Array(buffer));
    expect(Object.keys(files).some((name) => name.startsWith('word/media/'))).toBe(true);
  });
});

describe('purchaser details (§3.5, §4.7)', () => {
  it('addresses the quote to the purchasing entity at its billing address', async () => {
    const text = await documentText(input());
    expect(text).toContain('Barratt Homes plc');
    expect(text).toContain('Registered Office');
    expect(text).toContain('EC1A 1AA');
  });

  it('never prints the development site address', async () => {
    // The development site drives the multiplier, not the invoice. It is not
    // passed to the document at all, so it cannot leak onto one.
    const text = await documentText(input());
    expect(text).not.toContain('Land north of');
  });
});

describe('line items (§4.7)', () => {
  it('renders units at the module’s own precision, trailing zeros kept', async () => {
    const text = await documentText(
      input({ lines: [line({ quantity: UnitQuantity.of('area', '2.5') })] }),
    );
    // 2.5000, not 2.5 — matching the metric's own conventions.
    expect(text).toContain('2.5000');
  });

  it('renders hedgerow at three places and area at four in the same document', async () => {
    const text = await documentText(
      input({
        lines: [
          line({ quantity: UnitQuantity.of('area', '1.5') }),
          line({
            module: 'hedgerow',
            broadHabitat: 'Hedgerow',
            habitatType: 'Native hedgerow',
            quantity: UnitQuantity.of('hedgerow', '2.5'),
            lineTotal: Money.lineTotal(Money.of('20000'), UnitQuantity.of('hedgerow', '2.5')),
          }),
        ],
      }),
    );
    expect(text).toContain('1.5000');
    expect(text).toContain('2.500');
  });

  it('describes each line by broad habitat, type, distinctiveness and module', async () => {
    const text = await documentText(input());
    expect(text).toContain('Other neutral grassland');
    expect(text).toContain('Grassland');
    expect(text).toContain('Medium distinctiveness');
    expect(text).toContain('Area habitat');
  });

  it('formats money for reading, not as a bare decimal', async () => {
    const text = await documentText(input());
    expect(text).toContain('£20,000.00');
    expect(text).toContain('£46,914.00');
  });

  it('shows the quote reference and date', async () => {
    const text = await documentText(input());
    expect(text).toContain('CC-0001');
    expect(text).toContain('20 August 2026');
  });
});

describe('units required (§4.7, optional section)', () => {
  it('shows the requirement per module when the quote records one', async () => {
    const text = await documentText(
      input({
        unitsRequired: [
          { module: 'area', requiredUnits: UnitQuantity.of('area', '5.0') },
          { module: 'hedgerow', requiredUnits: UnitQuantity.of('hedgerow', '2.0') },
        ],
      }),
    );
    expect(text).toContain('Units required');
    expect(text).toContain('Area habitat: 5.0000 units');
    expect(text).toContain('Hedgerow: 2.000 units');
  });

  it('leaves the section out when there is no requirement to show', async () => {
    const text = await documentText(input());
    expect(text).not.toContain('Units required');
  });
});

describe('VAT: totals with and without', () => {
  it('shows all three figures by default', async () => {
    const text = await documentText(input());
    expect(text).toContain('Total excluding VAT');
    expect(text).toContain('VAT at 20%');
    expect(text).toContain('Total including VAT');
  });

  it('gets the three figures right', async () => {
    const text = await documentText(input());
    // 46,914.00 net, 9,382.80 VAT, 56,296.80 gross.
    expect(text).toContain('£46,914.00');
    expect(text).toContain('£9,382.80');
    expect(text).toContain('£56,296.80');
  });

  it('honours a different rate', async () => {
    const vat: VatConfig = { treatment: 'standard-rate', ratePercent: '5', status: 'confirmed' };
    const text = await documentText(input({ vat }));
    expect(text).toContain('VAT at 5%');
    expect(text).toContain('£2,345.70');
    expect(text).toContain('£49,259.70');
  });

  it('still shows all three lines when no VAT is charged, so it reads as considered', async () => {
    const vat: VatConfig = { treatment: 'none', ratePercent: '20', status: 'confirmed' };
    const text = await documentText(input({ vat }));

    expect(text).toContain('Total excluding VAT');
    expect(text).toContain('VAT (not charged)');
    expect(text).toContain('Total including VAT');
    expect(text).toContain('No VAT is charged on this quotation');
  });

  it('prints the registration number when there is one', async () => {
    const text = await documentText(
      input({
        vat: {
          treatment: 'standard-rate',
          ratePercent: '20',
          registrationNumber: 'GB123456789',
          status: 'confirmed',
        },
      }),
    );
    expect(text).toContain('GB123456789');
  });

  it('computes VAT on the net total, rounded once', () => {
    const totals = quoteTotals([Money.of('33.33'), Money.of('33.33'), Money.of('33.34')], {
      treatment: 'standard-rate',
      ratePercent: '20',
      status: 'confirmed',
    });
    expect(totals.net.toString()).toBe('100.00');
    expect(totals.vat.toString()).toBe('20.00');
    expect(totals.gross.toString()).toBe('120.00');
  });

  it('reports zero VAT rather than nothing when none is charged', () => {
    const totals = quoteTotals([Money.of('100')], {
      treatment: 'none',
      ratePercent: '20',
      status: 'confirmed',
    });
    expect(totals.vat.toString()).toBe('0.00');
    expect(totals.vatCharged).toBe(false);
    expect(totals.gross.equals(totals.net)).toBe(true);
  });

  it('defaults to charging VAT at the standard rate', () => {
    expect(DEFAULT_VAT_CONFIG.treatment).toBe('standard-rate');
    expect(quoteTotals([Money.of('100')], DEFAULT_VAT_CONFIG).vat.toString()).toBe('20.00');
  });

  it('refuses a nonsensical rate', () => {
    expect(() =>
      quoteTotals([Money.of('100')], { treatment: 'standard-rate', ratePercent: '150', status: 'confirmed' }),
    ).toThrow(/between 0 and 100/);
  });
});

describe('caveats', () => {
  it('prints provisional-figure warnings on the document itself', async () => {
    const text = await documentText(
      input({ caveats: ['Spatial risk multipliers are provisional pending confirmation.'] })
    );
    expect(text).toContain('Important');
    expect(text).toContain('Spatial risk multipliers are provisional');
  });
});

describe('filename', () => {
  it('is derived from the reference and safe on any platform', () => {
    expect(quoteDocumentFilename('CC-0001')).toBe('Quote-CC-0001.docx');
    expect(quoteDocumentFilename('CC/0001 draft')).toBe('Quote-CC-0001-draft.docx');
  });
});

describe('the document is a real .docx', () => {
  it('has the parts Word expects', async () => {
    const buffer = await renderQuoteDocument(input());
    const files = unzipSync(new Uint8Array(buffer));
    expect(files['[Content_Types].xml']).toBeDefined();
    expect(files['word/document.xml']).toBeDefined();
    expect(files['_rels/.rels']).toBeDefined();
  });
});
