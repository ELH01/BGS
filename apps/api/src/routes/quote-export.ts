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
  renderQuoteDocument,
  type QuoteDocumentInput,
  type VatConfig,
} from '@bgs/documents';
import { getQuoteDocumentSource, withTenant } from '@bgs/db';
import { loadApiConfig } from '../env.js';

/**
 * VAT configuration, read from the environment.
 *
 * §5.7 is an open question — whether unit sales are standard-rated and whether
 * the operator is registered — so the treatment is configured rather than
 * assumed, and defaults to a flat total with no VAT line. Setting
 * VAT_TREATMENT=standard-rate turns on the subtotal/VAT/total breakdown.
 */
function vatConfig(): VatConfig {
  const treatment = process.env['VAT_TREATMENT'] === 'standard-rate' ? 'standard-rate' : 'none';
  const registrationNumber = process.env['VAT_REGISTRATION_NUMBER'];

  return {
    treatment,
    ratePercent: process.env['VAT_RATE_PERCENT'] ?? '20',
    ...(registrationNumber ? { registrationNumber } : {}),
    // Confirmed only once someone has deliberately configured it.
    status: process.env['VAT_TREATMENT'] ? 'confirmed' : 'unconfirmed',
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

      // Branding belongs to the operator whose stock is being sold. Where a
      // quote draws on more than one, the one supplying the most units brands
      // it and the caller is told, since a document carrying one operator's
      // identity while selling another's stock would mislead the purchaser.
      const operator = source.operators[0];
      if (!operator) {
        return reply.code(409).send({ error: 'Could not determine which bank operator this quote draws on.' });
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
      const vat = vatConfig();
      if (vat.status === 'unconfirmed') {
        caveats.push('Prices are exclusive of VAT. VAT treatment is to be confirmed.');
      }

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

      const vat = vatConfig();
      const net = Money.sum(source.quote.lines.map((line) => line.lineTotal));
      const warnings: string[] = [];

      if (source.quote.lines.length === 0) {
        warnings.push('This quote has no allocation lines yet.');
      }
      if (source.operators.length > 1) {
        warnings.push(
          `This quote draws on ${source.operators.length} bank operators. It will be branded as ` +
            `${source.operators[0]?.name}, which supplies the most units. Consider splitting it if the ` +
            'purchaser should see each operator separately.',
        );
      }
      const operator = source.operators[0];
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
        net: net.toString(),
        vat: { treatment: vat.treatment, ratePercent: vat.ratePercent, status: vat.status },
        filename: quoteDocumentFilename(source.quote.reference),
        warnings,
      };
    },
  );
}

export { DEFAULT_VAT_CONFIG, UnitQuantity };
