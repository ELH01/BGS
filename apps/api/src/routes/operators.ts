import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createBankOperator,
  createSite,
  getBankOperator,
  getSite,
  listBankOperators,
  listSites,
  updateBankOperator,
  updateSite,
  withTenant,
} from '@bgs/db';
import { parseBody } from '../http.js';

const nullableText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v ?? null);

const brandingSchema = z.object({
  companyName: nullableText(200),
  address: nullableText(500),
  contact: nullableText(500),
  logoFileId: z.string().uuid().nullish().transform((v) => v ?? null),
  accentColour: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Use a hex colour such as #2F5D3A.')
    .nullish()
    .transform((v) => v ?? null),
});

const operatorSchema = z.object({
  // Which organisation owns this operator. Defaults to the caller's own; may
  // name a managed client's organisation when a grant allows it.
  organisationId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  contactName: nullableText(200),
  contactEmail: nullableText(255),
  contactPhone: nullableText(50),
  notes: nullableText(5000),
  branding: brandingSchema.optional(),
  /** Where payment is sent, when it differs from the letterhead address. */
  invoicingAddress: nullableText(500),
  /**
   * This operator's VAT position. Governs any quote drawn on its stock,
   * because the quote goes out under this operator rather than the platform.
   */
  vat: z
    .object({
      registered: z.boolean().default(false),
      registrationNumber: nullableText(30),
      ratePercent: z
        .string()
        .trim()
        .regex(/^\d{1,3}(\.\d{1,3})?$/, 'Enter a percentage, e.g. 20.')
        .optional(),
    })
    .optional(),
});

const siteSchema = z.object({
  organisationId: z.string().uuid().optional(),
  bankOperatorId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  location: nullableText(500),
  lpaCode: nullableText(50),
  lpaName: nullableText(200),
  ncaCode: nullableText(50),
  ncaName: nullableText(200),
  lnrsAreaCode: nullableText(50),
  lnrsAreaName: nullableText(200),
  bgsRegisterReference: nullableText(100),
  notes: nullableText(5000),
});

export default async function operatorRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/bank-operators', { onRequest: [app.requireAuth] }, async (request) => {
    const auth = request.auth!;
    const operators = await withTenant(auth.organisationId, (tx) => listBankOperators(tx));
    return { bankOperators: operators };
  });

  app.get<{ Params: { id: string } }>(
    '/api/bank-operators/:id',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;
      const operator = await withTenant(auth.organisationId, (tx) => getBankOperator(tx, request.params.id));
      // A row belonging to another tenant is invisible rather than forbidden,
      // so this reveals nothing about what exists elsewhere.
      if (!operator) return reply.code(404).send({ error: 'Bank operator not found.' });
      return { bankOperator: operator };
    },
  );

  app.post('/api/bank-operators', { onRequest: [app.requireWriteAccess] }, async (request, reply) => {
    const body = parseBody(operatorSchema, request.body, reply);
    if (!body) return;
    const auth = request.auth!;

    const operator = await withTenant(auth.organisationId, (tx) =>
      createBankOperator(tx, {
        organisationId: body.organisationId ?? auth.organisationId,
        name: body.name,
        contactName: body.contactName,
        contactEmail: body.contactEmail,
        contactPhone: body.contactPhone,
        notes: body.notes,
        brandingCompanyName: body.branding?.companyName ?? null,
        brandingAddress: body.branding?.address ?? null,
        brandingContact: body.branding?.contact ?? null,
        brandingLogoFileId: body.branding?.logoFileId ?? null,
        brandingAccentColour: body.branding?.accentColour ?? null,
        invoicingAddress: body.invoicingAddress,
        vatRegistered: body.vat?.registered ?? false,
        vatRegistrationNumber: body.vat?.registrationNumber ?? null,
        vatRatePercent: body.vat?.ratePercent ?? '20',
      }),
    );
    return reply.code(201).send({ bankOperator: operator });
  });

  app.put<{ Params: { id: string } }>(
    '/api/bank-operators/:id',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const body = parseBody(operatorSchema, request.body, reply);
      if (!body) return;
      const auth = request.auth!;

      const operator = await withTenant(auth.organisationId, (tx) =>
        updateBankOperator(tx, request.params.id, {
          name: body.name,
          contactName: body.contactName,
          contactEmail: body.contactEmail,
          contactPhone: body.contactPhone,
          notes: body.notes,
          brandingCompanyName: body.branding?.companyName ?? null,
          brandingAddress: body.branding?.address ?? null,
          brandingContact: body.branding?.contact ?? null,
          brandingLogoFileId: body.branding?.logoFileId ?? null,
          brandingAccentColour: body.branding?.accentColour ?? null,
          invoicingAddress: body.invoicingAddress,
          vatRegistered: body.vat?.registered ?? false,
          vatRegistrationNumber: body.vat?.registrationNumber ?? null,
          vatRatePercent: body.vat?.ratePercent ?? '20',
        }),
      );
      if (!operator) return reply.code(404).send({ error: 'Bank operator not found.' });
      return { bankOperator: operator };
    },
  );

  app.get<{ Querystring: { bankOperatorId?: string } }>(
    '/api/sites',
    { onRequest: [app.requireAuth] },
    async (request) => {
      const auth = request.auth!;
      const sites = await withTenant(auth.organisationId, (tx) =>
        listSites(tx, request.query.bankOperatorId ? { bankOperatorId: request.query.bankOperatorId } : {}),
      );
      return { sites };
    },
  );

  app.get<{ Params: { id: string } }>('/api/sites/:id', { onRequest: [app.requireAuth] }, async (request, reply) => {
    const auth = request.auth!;
    const site = await withTenant(auth.organisationId, (tx) => getSite(tx, request.params.id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    return { site };
  });

  app.post('/api/sites', { onRequest: [app.requireWriteAccess] }, async (request, reply) => {
    const body = parseBody(siteSchema, request.body, reply);
    if (!body) return;
    const auth = request.auth!;

    const site = await withTenant(auth.organisationId, (tx) =>
      createSite(tx, { ...body, organisationId: body.organisationId ?? auth.organisationId }),
    );
    return reply.code(201).send({ site });
  });

  app.put<{ Params: { id: string } }>(
    '/api/sites/:id',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const body = parseBody(siteSchema, request.body, reply);
      if (!body) return;
      const auth = request.auth!;

      const site = await withTenant(auth.organisationId, (tx) => updateSite(tx, request.params.id, body));
      if (!site) return reply.code(404).send({ error: 'Site not found.' });
      return { site };
    },
  );
}
