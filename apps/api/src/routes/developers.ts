import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createDeveloper, getDeveloper, listDevelopers, updateDeveloper, withTenant } from '@bgs/db';
import { parseBody } from '../http.js';

const nullableText = (max: number) =>
  z.string().trim().max(max).nullish().transform((value) => value ?? null);

const developerSchema = z.object({
  organisationId: z.string().uuid().optional(),
  purchasingEntityName: z.string().trim().min(1).max(200),
  billingAddress: nullableText(500),
  developmentSiteName: nullableText(200),
  developmentSiteAddress: nullableText(500),
  developmentLpaCode: nullableText(50),
  developmentLpaName: nullableText(200),
  developmentNcaCode: nullableText(50),
  developmentNcaName: nullableText(200),
  contactName: nullableText(200),
  contactEmail: nullableText(255),
  contactPhone: nullableText(50),
  notes: nullableText(5000),
});

export default async function developerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/developers', { onRequest: [app.requireAuth] }, async (request) => {
    const auth = request.auth!;
    const developers = await withTenant(auth.organisationId, (tx) => listDevelopers(tx));
    return { developers };
  });

  app.get<{ Params: { id: string } }>(
    '/api/developers/:id',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;
      const developer = await withTenant(auth.organisationId, (tx) => getDeveloper(tx, request.params.id));
      if (!developer) return reply.code(404).send({ error: 'Developer not found.' });
      return { developer };
    },
  );

  app.post('/api/developers', { onRequest: [app.requireWriteAccess] }, async (request, reply) => {
    const body = parseBody(developerSchema, request.body, reply);
    if (!body) return;
    const auth = request.auth!;

    const developer = await withTenant(auth.organisationId, (tx) =>
      createDeveloper(tx, { ...body, organisationId: body.organisationId ?? auth.organisationId }),
    );
    return reply.code(201).send({ developer });
  });

  app.put<{ Params: { id: string } }>(
    '/api/developers/:id',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const body = parseBody(developerSchema, request.body, reply);
      if (!body) return;
      const auth = request.auth!;

      const developer = await withTenant(auth.organisationId, (tx) =>
        updateDeveloper(tx, request.params.id, body),
      );
      if (!developer) return reply.code(404).send({ error: 'Developer not found.' });
      return { developer };
    },
  );
}
