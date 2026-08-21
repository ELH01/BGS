import type { FastifyInstance } from 'fastify';
import {
  Money,
  PLACEHOLDER_LPA_NCA_SCHEME,
  UnitQuantity,
  type DistinctivenessBand,
} from '@bgs/core';
import {
  DEFAULT_VAT_CONFIG,
  quoteDocumentFilename,
  quoteTotals,
  renderQuoteDocument,
  type QuoteDocumentInput,
  type VatConfig,
} from '@bgs/documents';
import { getQuoteDocumentSource, getStoredFile, withTenant } from '@bgs/db';
import { loadApiConfig } from '../env.js';
import { isImageType, readStoredBytes, sniffType } from '../storage.js';

/**
 * The VAT position of the operator this quote supplies.
 *
 * A quotation goes out under that operator, so it is their registration that
 * governs it — Cosdon may not be registered while a client bank is. Read from
 * the operator record rather than from a platform-wide setting, because the
 * same platform has to produce a correct document for both.
 */
function vatConfigFor(operator: {
  vatRegistered: boolean;
  vatRegistrationNumber: string | null;
  vatRatePercent: string;
}): VatConfig {
  if (!operator.vatRegistered) {
    return { treatment: 'none', ratePercent: '0', status: 'confirmed' };
  }

  return {
    treatment: 'standard-rate',
    ratePercent: operator.vatRatePercent,
    ...(operator.vatRegistrationNumber ? { registrationNumber: operator.vatRegistrationNumber } : {}),
    status: 'confirmed',
  };
}


export default async function quoteExportRoutes(app: FastifyInstance): Promise<void> {
  const config = loadApiConfig();

  /**
   * The quote as a Word document (§4.7).
   *
   * Composed from stored data at export time rather than merged into a
   * template, so there is no field that can silently fail to substitute.
   */
  app.get<{ Params: { id: string } }>(
    '/api/quotes/:id/document',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;

      const source = await withTenant(auth.organisationId, (tx) =>
        getQuoteDocumentSource(tx, request.params.id, config.staleQuoteDays),
      );

      if (!source) return reply.code(404).send({ error: 'Quote not found.' });
      if (source.quote.lines.length === 0) {
        return reply.code(409).send({ error: 'This quote has no allocation lines, so there is nothing to quote for.' });
      }

      // Branding is the operator the quote was raised for. No inference and no
      // tie-break: a quote supplies one operator, chosen when it was created,
      // and the allocation table will not let it draw on anyone else's stock.
      const operator = source.operators.find((candidate) => candidate.id === source.quote.bankOperatorId);
      if (!operator) {
        return reply.code(409).send({
          error:
            'This quote has no supplying bank operator recorded, so the document has no branding to carry. ' +
            'Set one on the quote before exporting.',
        });
      }

      // The operator's uploaded logo, if there is one. A logo that cannot be
      // read is left out rather than failing the export: a quote without its
      // logo is still a usable quote, and the preview warns separately.
      let logo: { data: Uint8Array; type: 'png' | 'jpg' | 'gif' | 'bmp' } | undefined;
      if (operator.brandingLogoFileId) {
        try {
          const file = await withTenant(auth.organisationId, (tx) =>
            getStoredFile(tx, operator.brandingLogoFileId!),
          );
          if (file) {
            const bytes = await readStoredBytes(file.storagePath);
            const sniffed = sniffType(bytes);
            if (sniffed && isImageType(sniffed.kind)) {
              logo = { data: bytes, type: sniffed.kind };
            }
          }
        } catch (error) {
          request.log.warn({ err: error, operatorId: operator.id }, 'Could not read operator logo for quote');
        }
      }

      const detailsByLine = new Map(source.lineDetails.map((detail) => [detail.allocationLineId, detail]));

      const lines: QuoteDocumentInput['lines'] = source.quote.lines.map((line) => {
        const detail = detailsByLine.get(line.id);
        return {
          module: line.module,
          broadHabitat: detail?.broadHabitat ?? '',
          habitatType: detail?.habitatType ?? '',
          distinctiveness: (detail?.distinctiveness ?? 'medium') as DistinctivenessBand,
          quantity: line.rawQuantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        };
      });

      // Figures resting on values nobody has confirmed say so on the document
      // itself, rather than only in the app the purchaser never sees.
      const caveats: string[] = [];
      if (PLACEHOLDER_LPA_NCA_SCHEME.status === 'unconfirmed') {
        caveats.push(
          'The spatial risk multipliers used to calculate these figures are provisional and pending confirmation against a current authoritative source.',
        );
      }
      const vat = vatConfigFor(operator);


      const requirements = source.quote.targets.filter((target) => target.requiredUnits.isPositive());

      const document = await renderQuoteDocument({
        reference: source.quote.reference,
        date: source.quote.createdAt,
        branding: {
          // Falls back to the operator's own name when no separate trading name
          // has been set for documents.
          companyName: operator.brandingCompanyName ?? operator.name,
          address: operator.brandingAddress,
          contact: operator.brandingContact,
          accentColour: operator.brandingAccentColour,
          invoicingAddress: operator.invoicingAddress,
          ...(logo ? { logo } : {}),
        },
        purchaser: {
          entityName: source.purchaser.entityName,
          billingAddress: source.purchaser.billingAddress,
          contactName: source.purchaser.contactName,
          contactEmail: source.purchaser.contactEmail,
        },
        lines,
        ...(requirements.length > 0
          ? {
              unitsRequired: requirements.map((target) => ({
                module: target.module,
                requiredUnits: target.requiredUnits,
              })),
            }
          : {}),
        vat,
        notes: source.quote.notes,
        caveats,
      });

      return reply
        .header(
          'content-type',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        )
        .header('content-disposition', `attachment; filename="${quoteDocumentFilename(source.quote.reference)}"`)
        .header('x-branding-operator', operator.name)
        .header('x-operator-count', String(source.operators.length))
        .send(document);
    },
  );

  /** What the document would say, without generating it. Drives the UI's warnings. */
  app.get<{ Params: { id: string } }>(
    '/api/quotes/:id/document-preview',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;
      const source = await withTenant(auth.organisationId, (tx) =>
        getQuoteDocumentSource(tx, request.params.id, config.staleQuoteDays),
      );
      if (!source) return reply.code(404).send({ error: 'Quote not found.' });

      const operator = source.operators.find((candidate) => candidate.id === source.quote.bankOperatorId);
      // With no operator there is no VAT position to report; the warning below
      // says so, and the totals fall back to no VAT rather than guessing one.
      const vat = operator
        ? vatConfigFor(operator)
        : ({ treatment: 'none', ratePercent: '0', status: 'confirmed' } as VatConfig);
      const totals = quoteTotals(
        source.quote.lines.map((line) => line.lineTotal),
        vat,
      );
      const warnings: string[] = [];

      if (source.quote.lines.length === 0) {
        warnings.push('This quote has no allocation lines yet.');
      }
      if (!source.quote.bankOperatorId) {
        warnings.push(
          'This quote has no supplying bank operator recorded, so there is no branding for the document to carry.',
        );
      }
      if (operator && !operator.brandingLogoFileId) {
        warnings.push(`${operator.name} has no logo uploaded, so the document will be text only.`);
      }
      if (operator && !operator.brandingCompanyName && !operator.brandingAddress) {
        warnings.push(
          `${operator.name} has no quote branding set, so the document will show only its name. Add an address and contact details on the bank operator.`,
        );
      }
      if (!source.purchaser.billingAddress) {
        warnings.push('The purchaser has no billing address, so the quote will be addressed by name only.');
      }

      return {
        reference: source.quote.reference,
        brandingOperator: operator ? { id: operator.id, name: operator.name } : null,
        operatorCount: source.operators.length,
        lineCount: source.quote.lines.length,
        // All three figures, so the screen can show what the document will.
        totals: {
          excludingVat: totals.net.toString(),
          vat: totals.vat.toString(),
          includingVat: totals.gross.toString(),
          vatCharged: totals.vatCharged,
          ratePercent: totals.ratePercent,
        },
        vat: { treatment: vat.treatment, ratePercent: vat.ratePercent, status: vat.status },
        filename: quoteDocumentFilename(source.quote.reference),
        warnings,
      };
    },
  );
}

export { DEFAULT_VAT_CONFIG, UnitQuantity };
