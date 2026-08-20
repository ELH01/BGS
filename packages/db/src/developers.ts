import type { Queryable } from './client.js';

/**
 * Developers (§3.5).
 *
 * The purchasing entity and the development site are held apart deliberately.
 * The quote is addressed to the purchaser's billing address — a housebuilder's
 * registered office, say — while the spatial risk lookup uses where the
 * development actually is. Collapsing the two would put the wrong address on
 * quotes and the wrong multiplier on allocations.
 */

export interface Developer {
  id: string;
  organisationId: string;
  purchasingEntityName: string;
  billingAddress: string | null;
  developmentSiteName: string | null;
  developmentSiteAddress: string | null;
  developmentLpaCode: string | null;
  developmentLpaName: string | null;
  developmentNcaCode: string | null;
  developmentNcaName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DeveloperRow {
  id: string;
  organisation_id: string;
  purchasing_entity_name: string;
  billing_address: string | null;
  development_site_name: string | null;
  development_site_address: string | null;
  development_lpa_code: string | null;
  development_lpa_name: string | null;
  development_nca_code: string | null;
  development_nca_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

function toDeveloper(row: DeveloperRow): Developer {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    purchasingEntityName: row.purchasing_entity_name,
    billingAddress: row.billing_address,
    developmentSiteName: row.development_site_name,
    developmentSiteAddress: row.development_site_address,
    developmentLpaCode: row.development_lpa_code,
    developmentLpaName: row.development_lpa_name,
    developmentNcaCode: row.development_nca_code,
    developmentNcaName: row.development_nca_name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DeveloperInput {
  organisationId: string;
  purchasingEntityName: string;
  billingAddress?: string | null | undefined;
  developmentSiteName?: string | null | undefined;
  developmentSiteAddress?: string | null | undefined;
  developmentLpaCode?: string | null | undefined;
  developmentLpaName?: string | null | undefined;
  developmentNcaCode?: string | null | undefined;
  developmentNcaName?: string | null | undefined;
  contactName?: string | null | undefined;
  contactEmail?: string | null | undefined;
  contactPhone?: string | null | undefined;
  notes?: string | null | undefined;
}

const COLUMNS = `organisation_id, purchasing_entity_name, billing_address, development_site_name,
  development_site_address, development_lpa_code, development_lpa_name, development_nca_code,
  development_nca_name, contact_name, contact_email, contact_phone, notes`;

function params(input: DeveloperInput): (string | null)[] {
  return [
    input.organisationId,
    input.purchasingEntityName,
    input.billingAddress ?? null,
    input.developmentSiteName ?? null,
    input.developmentSiteAddress ?? null,
    input.developmentLpaCode ?? null,
    input.developmentLpaName ?? null,
    input.developmentNcaCode ?? null,
    input.developmentNcaName ?? null,
    input.contactName ?? null,
    input.contactEmail ?? null,
    input.contactPhone ?? null,
    input.notes ?? null,
  ];
}

export async function listDevelopers(db: Queryable): Promise<Developer[]> {
  const { rows } = await db.query<DeveloperRow>('SELECT * FROM developer ORDER BY purchasing_entity_name');
  return rows.map(toDeveloper);
}

export async function getDeveloper(db: Queryable, id: string): Promise<Developer | null> {
  const { rows } = await db.query<DeveloperRow>('SELECT * FROM developer WHERE id = $1', [id]);
  return rows[0] ? toDeveloper(rows[0]) : null;
}

export async function createDeveloper(db: Queryable, input: DeveloperInput): Promise<Developer> {
  const { rows } = await db.query<DeveloperRow>(
    `INSERT INTO developer (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    params(input),
  );
  const row = rows[0];
  if (!row) throw new Error('Insert returned no row.');
  return toDeveloper(row);
}

export async function updateDeveloper(
  db: Queryable,
  id: string,
  input: Omit<DeveloperInput, 'organisationId'>,
): Promise<Developer | null> {
  const { rows } = await db.query<DeveloperRow>(
    `UPDATE developer SET
        purchasing_entity_name = $2, billing_address = $3, development_site_name = $4,
        development_site_address = $5, development_lpa_code = $6, development_lpa_name = $7,
        development_nca_code = $8, development_nca_name = $9, contact_name = $10,
        contact_email = $11, contact_phone = $12, notes = $13
      WHERE id = $1 RETURNING *`,
    [id, ...params({ ...input, organisationId: '' }).slice(1)],
  );
  return rows[0] ? toDeveloper(rows[0]) : null;
}
