import {
  Money,
  UnitQuantity,
  assertMetricModule,
  type ConditionBand,
  type DistinctivenessBand,
  type MetricModule,
} from '@bgs/core';

/**
 * Strategic significance, as the metric uses it to weight a parcel's units.
 * Stored as a stable slug; the workbook's own wording lives with the metric
 * version mapping in @bgs/metric.
 */
export type StrategicSignificanceBand =
  | 'formally-identified'
  | 'ecologically-desirable'
  | 'not-in-strategy';
import type { Queryable } from './client.js';

/**
 * Row mapping note.
 *
 * Every `numeric` column arrives as a string (see client.ts) and is converted
 * here into a `UnitQuantity` or a `Money`. Nothing in this layer hands a bare
 * number for a quantity or a price back to a caller, so there is no path by
 * which a stored decimal becomes a float.
 */

export interface BankOperator {
  id: string;
  organisationId: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  branding: {
    companyName: string | null;
    address: string | null;
    contact: string | null;
    logoFileId: string | null;
    accentColour: string | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

interface BankOperatorRow {
  id: string;
  organisation_id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  branding_company_name: string | null;
  branding_address: string | null;
  branding_contact: string | null;
  branding_logo_file_id: string | null;
  branding_accent_colour: string | null;
  created_at: Date;
  updated_at: Date;
}

function toBankOperator(row: BankOperatorRow): BankOperator {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    name: row.name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    notes: row.notes,
    branding: {
      companyName: row.branding_company_name,
      address: row.branding_address,
      contact: row.branding_contact,
      logoFileId: row.branding_logo_file_id,
      accentColour: row.branding_accent_colour,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listBankOperators(db: Queryable): Promise<BankOperator[]> {
  const { rows } = await db.query<BankOperatorRow>(
    'SELECT * FROM bank_operator ORDER BY name',
  );
  return rows.map(toBankOperator);
}

export async function getBankOperator(db: Queryable, id: string): Promise<BankOperator | null> {
  const { rows } = await db.query<BankOperatorRow>('SELECT * FROM bank_operator WHERE id = $1', [id]);
  return rows[0] ? toBankOperator(rows[0]) : null;
}

export interface BankOperatorInput {
  /** Owning organisation. May differ from the acting one under a grant. */
  organisationId: string;
  name: string;
  contactName?: string | null | undefined;
  contactEmail?: string | null | undefined;
  contactPhone?: string | null | undefined;
  notes?: string | null | undefined;
  brandingCompanyName?: string | null | undefined;
  brandingAddress?: string | null | undefined;
  brandingContact?: string | null | undefined;
  brandingLogoFileId?: string | null | undefined;
  brandingAccentColour?: string | null | undefined;
}

export async function createBankOperator(db: Queryable, input: BankOperatorInput): Promise<BankOperator> {
  const { rows } = await db.query<BankOperatorRow>(
    `INSERT INTO bank_operator (
        organisation_id, name, contact_name, contact_email, contact_phone, notes,
        branding_company_name, branding_address, branding_contact,
        branding_logo_file_id, branding_accent_colour
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      input.organisationId,
      input.name,
      input.contactName ?? null,
      input.contactEmail ?? null,
      input.contactPhone ?? null,
      input.notes ?? null,
      input.brandingCompanyName ?? null,
      input.brandingAddress ?? null,
      input.brandingContact ?? null,
      input.brandingLogoFileId ?? null,
      input.brandingAccentColour ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('Insert returned no row.');
  return toBankOperator(row);
}

export async function updateBankOperator(
  db: Queryable,
  id: string,
  input: Omit<BankOperatorInput, 'organisationId'>,
): Promise<BankOperator | null> {
  const { rows } = await db.query<BankOperatorRow>(
    `UPDATE bank_operator SET
        name = $2, contact_name = $3, contact_email = $4, contact_phone = $5, notes = $6,
        branding_company_name = $7, branding_address = $8, branding_contact = $9,
        branding_logo_file_id = $10, branding_accent_colour = $11
      WHERE id = $1
      RETURNING *`,
    [
      id,
      input.name,
      input.contactName ?? null,
      input.contactEmail ?? null,
      input.contactPhone ?? null,
      input.notes ?? null,
      input.brandingCompanyName ?? null,
      input.brandingAddress ?? null,
      input.brandingContact ?? null,
      input.brandingLogoFileId ?? null,
      input.brandingAccentColour ?? null,
    ],
  );
  return rows[0] ? toBankOperator(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Habitat bank sites
// ---------------------------------------------------------------------------

export interface HabitatBankSite {
  id: string;
  organisationId: string;
  bankOperatorId: string;
  name: string;
  location: string | null;
  lpaCode: string | null;
  lpaName: string | null;
  ncaCode: string | null;
  ncaName: string | null;
  lnrsAreaCode: string | null;
  lnrsAreaName: string | null;
  bgsRegisterReference: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SiteRow {
  id: string;
  organisation_id: string;
  bank_operator_id: string;
  name: string;
  location: string | null;
  lpa_code: string | null;
  lpa_name: string | null;
  nca_code: string | null;
  nca_name: string | null;
  lnrs_area_code: string | null;
  lnrs_area_name: string | null;
  bgs_register_reference: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

function toSite(row: SiteRow): HabitatBankSite {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    bankOperatorId: row.bank_operator_id,
    name: row.name,
    location: row.location,
    lpaCode: row.lpa_code,
    lpaName: row.lpa_name,
    ncaCode: row.nca_code,
    ncaName: row.nca_name,
    lnrsAreaCode: row.lnrs_area_code,
    lnrsAreaName: row.lnrs_area_name,
    bgsRegisterReference: row.bgs_register_reference,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSites(db: Queryable, options: { bankOperatorId?: string } = {}): Promise<HabitatBankSite[]> {
  const { rows } = options.bankOperatorId
    ? await db.query<SiteRow>('SELECT * FROM habitat_bank_site WHERE bank_operator_id = $1 ORDER BY name', [
        options.bankOperatorId,
      ])
    : await db.query<SiteRow>('SELECT * FROM habitat_bank_site ORDER BY name');
  return rows.map(toSite);
}

export async function getSite(db: Queryable, id: string): Promise<HabitatBankSite | null> {
  const { rows } = await db.query<SiteRow>('SELECT * FROM habitat_bank_site WHERE id = $1', [id]);
  return rows[0] ? toSite(rows[0]) : null;
}

export interface SiteInput {
  organisationId: string;
  bankOperatorId: string;
  name: string;
  location?: string | null | undefined;
  lpaCode?: string | null | undefined;
  lpaName?: string | null | undefined;
  ncaCode?: string | null | undefined;
  ncaName?: string | null | undefined;
  lnrsAreaCode?: string | null | undefined;
  lnrsAreaName?: string | null | undefined;
  bgsRegisterReference?: string | null | undefined;
  notes?: string | null | undefined;
}

const SITE_COLUMNS = `organisation_id, bank_operator_id, name, location, lpa_code, lpa_name,
  nca_code, nca_name, lnrs_area_code, lnrs_area_name, bgs_register_reference, notes`;

function siteParams(input: SiteInput): readonly (string | null)[] {
  return [
    input.organisationId,
    input.bankOperatorId,
    input.name,
    input.location ?? null,
    input.lpaCode ?? null,
    input.lpaName ?? null,
    input.ncaCode ?? null,
    input.ncaName ?? null,
    input.lnrsAreaCode ?? null,
    input.lnrsAreaName ?? null,
    input.bgsRegisterReference ?? null,
    input.notes ?? null,
  ];
}

export async function createSite(db: Queryable, input: SiteInput): Promise<HabitatBankSite> {
  const { rows } = await db.query<SiteRow>(
    `INSERT INTO habitat_bank_site (${SITE_COLUMNS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    siteParams(input),
  );
  const row = rows[0];
  if (!row) throw new Error('Insert returned no row.');
  return toSite(row);
}

export async function updateSite(
  db: Queryable,
  id: string,
  input: Omit<SiteInput, 'organisationId'>,
): Promise<HabitatBankSite | null> {
  const { rows } = await db.query<SiteRow>(
    `UPDATE habitat_bank_site SET
        bank_operator_id = $2, name = $3, location = $4, lpa_code = $5, lpa_name = $6,
        nca_code = $7, nca_name = $8, lnrs_area_code = $9, lnrs_area_name = $10,
        bgs_register_reference = $11, notes = $12
      WHERE id = $1 RETURNING *`,
    [
      id,
      input.bankOperatorId,
      input.name,
      input.location ?? null,
      input.lpaCode ?? null,
      input.lpaName ?? null,
      input.ncaCode ?? null,
      input.ncaName ?? null,
      input.lnrsAreaCode ?? null,
      input.lnrsAreaName ?? null,
      input.bgsRegisterReference ?? null,
      input.notes ?? null,
    ],
  );
  return rows[0] ? toSite(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Stock parcels and the derived unit pool (§3.3, §3.4)
// ---------------------------------------------------------------------------

export interface StockParcel {
  id: string;
  organisationId: string;
  siteId: string;
  metricImportId: string | null;
  parcelReference: string;
  module: MetricModule;
  broadHabitat: string;
  habitatType: string;
  distinctiveness: DistinctivenessBand;
  condition: ConditionBand;
  totalUnits: UnitQuantity;
  retiredUnits: UnitQuantity;
  listPricePerUnit: Money | null;
  /**
   * Inputs the metric uses to compute this parcel's units. Held so that
   * writing an allocation into a developer's workbook reproduces the same
   * calculation the bank's own metric made — the workbook recomputes from
   * scratch, so a missing input means a different answer.
   */
  extent: string | null;
  strategicSignificance: StrategicSignificanceBand | null;
  habitatCreatedInAdvanceYears: string | null;
  delayYears: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ParcelRow {
  id: string;
  organisation_id: string;
  site_id: string;
  metric_import_id: string | null;
  parcel_reference: string;
  module: MetricModule;
  broad_habitat: string;
  habitat_type: string;
  distinctiveness: DistinctivenessBand;
  condition: ConditionBand;
  total_units: string;
  retired_units: string;
  list_price_per_unit: string | null;
  extent: string | null;
  strategic_significance: StrategicSignificanceBand | null;
  habitat_created_in_advance_years: string | null;
  delay_years: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

function toParcel(row: ParcelRow): StockParcel {
  const module = assertMetricModule(row.module);
  return {
    id: row.id,
    organisationId: row.organisation_id,
    siteId: row.site_id,
    metricImportId: row.metric_import_id,
    parcelReference: row.parcel_reference,
    module,
    broadHabitat: row.broad_habitat,
    habitatType: row.habitat_type,
    distinctiveness: row.distinctiveness,
    condition: row.condition,
    totalUnits: UnitQuantity.of(module, row.total_units),
    retiredUnits: UnitQuantity.of(module, row.retired_units),
    listPricePerUnit: row.list_price_per_unit === null ? null : Money.of(row.list_price_per_unit),
    extent: row.extent,
    strategicSignificance: row.strategic_significance,
    habitatCreatedInAdvanceYears: row.habitat_created_in_advance_years,
    delayYears: row.delay_years,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface StockParcelInput {
  organisationId: string;
  siteId: string;
  metricImportId?: string | null | undefined;
  parcelReference: string;
  module: MetricModule;
  broadHabitat: string;
  habitatType: string;
  distinctiveness: DistinctivenessBand;
  condition?: ConditionBand | undefined;
  totalUnits: UnitQuantity;
  listPricePerUnit?: Money | null | undefined;
  extent?: string | null | undefined;
  strategicSignificance?: StrategicSignificanceBand | null | undefined;
  habitatCreatedInAdvanceYears?: string | null | undefined;
  delayYears?: string | null | undefined;
  notes?: string | null | undefined;
}

export async function createStockParcel(db: Queryable, input: StockParcelInput): Promise<StockParcel> {
  if (input.totalUnits.module !== input.module) {
    throw new TypeError(
      `Parcel is declared as ${input.module} but its total units are a ${input.totalUnits.module} quantity.`,
    );
  }

  const { rows } = await db.query<ParcelRow>(
    `INSERT INTO stock_parcel (
        organisation_id, site_id, metric_import_id, parcel_reference, module,
        broad_habitat, habitat_type, distinctiveness, condition,
        total_units, list_price_per_unit, notes,
        extent, strategic_significance, habitat_created_in_advance_years, delay_years
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [
      input.organisationId,
      input.siteId,
      input.metricImportId ?? null,
      input.parcelReference,
      input.module,
      input.broadHabitat,
      input.habitatType,
      input.distinctiveness,
      input.condition ?? 'n/a',
      // Canonical string form, so the value crosses the wire at exactly the
      // module's precision rather than through a float.
      input.totalUnits.toString(),
      input.listPricePerUnit?.toString() ?? null,
      input.notes ?? null,
      input.extent ?? null,
      input.strategicSignificance ?? null,
      input.habitatCreatedInAdvanceYears ?? null,
      input.delayYears ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('Insert returned no row.');
  return toParcel(row);
}

/**
 * Update the metric inputs on a parcel.
 *
 * Separate from creation because these often arrive later: a parcel gets
 * recorded from a bank metric, and the strategic significance or the years in
 * advance are filled in once someone has checked the source workbook.
 */
export async function updateStockParcelMetricInputs(
  db: Queryable,
  id: string,
  input: {
    extent?: string | null;
    strategicSignificance?: StrategicSignificanceBand | null;
    habitatCreatedInAdvanceYears?: string | null;
    delayYears?: string | null;
  },
): Promise<StockParcel | null> {
  const { rows } = await db.query<ParcelRow>(
    `UPDATE stock_parcel SET
        extent = COALESCE($2, extent),
        strategic_significance = COALESCE($3, strategic_significance),
        habitat_created_in_advance_years = COALESCE($4, habitat_created_in_advance_years),
        delay_years = COALESCE($5, delay_years)
      WHERE id = $1 RETURNING *`,
    [
      id,
      input.extent ?? null,
      input.strategicSignificance ?? null,
      input.habitatCreatedInAdvanceYears ?? null,
      input.delayYears ?? null,
    ],
  );
  return rows[0] ? toParcel(rows[0]) : null;
}

export async function listStockParcels(
  db: Queryable,
  options: { siteId?: string; module?: MetricModule; bankOperatorId?: string } = {},
): Promise<StockParcel[]> {
  const conditions: string[] = [];
  const params: (string | null)[] = [];

  if (options.siteId) {
    params.push(options.siteId);
    conditions.push(`p.site_id = $${params.length}`);
  }
  if (options.module) {
    params.push(options.module);
    conditions.push(`p.module = $${params.length}`);
  }
  if (options.bankOperatorId) {
    params.push(options.bankOperatorId);
    conditions.push(`s.bank_operator_id = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.query<ParcelRow>(
    `SELECT p.* FROM stock_parcel p
       JOIN habitat_bank_site s ON s.id = p.site_id
       ${where}
      ORDER BY p.module, p.parcel_reference`,
    params,
  );
  return rows.map(toParcel);
}

export async function getStockParcel(db: Queryable, id: string): Promise<StockParcel | null> {
  const { rows } = await db.query<ParcelRow>('SELECT * FROM stock_parcel WHERE id = $1', [id]);
  return rows[0] ? toParcel(rows[0]) : null;
}

/**
 * Set a parcel's list price (§3.3 — set by the user after import, never parsed
 * from the metric).
 */
export async function setStockParcelListPrice(
  db: Queryable,
  id: string,
  price: Money | null,
): Promise<StockParcel | null> {
  const { rows } = await db.query<ParcelRow>(
    'UPDATE stock_parcel SET list_price_per_unit = $2 WHERE id = $1 RETURNING *',
    [id, price?.toString() ?? null],
  );
  return rows[0] ? toParcel(rows[0]) : null;
}

/** §3.4 Stock Unit Pool, derived from parcels, allocations and retirements. */
export interface StockUnitPoolEntry {
  stockParcelId: string;
  organisationId: string;
  siteId: string;
  siteName: string;
  bankOperatorId: string;
  bankOperatorName: string;
  module: MetricModule;
  broadHabitat: string;
  habitatType: string;
  distinctiveness: DistinctivenessBand;
  condition: ConditionBand;
  parcelReference: string;
  listPricePerUnit: Money | null;
  totalUnits: UnitQuantity;
  soldUnits: UnitQuantity;
  draftUnits: UnitQuantity;
  quotedUnits: UnitQuantity;
  reservedUnits: UnitQuantity;
  /** Quoted plus reserved: everything live against this parcel. */
  exposedUnits: UnitQuantity;
  /** Total less sold less reserved. Quoted deliberately does not reduce this. */
  availableUnits: UnitQuantity;
  isOverExposed: boolean;
}

interface PoolRow {
  stock_parcel_id: string;
  organisation_id: string;
  site_id: string;
  site_name: string;
  bank_operator_id: string;
  bank_operator_name: string;
  module: MetricModule;
  broad_habitat: string;
  habitat_type: string;
  distinctiveness: DistinctivenessBand;
  condition: ConditionBand;
  parcel_reference: string;
  list_price_per_unit: string | null;
  total_units: string;
  sold_units: string;
  draft_units: string;
  quoted_units: string;
  reserved_units: string;
  exposed_units: string;
  available_units: string;
  is_over_exposed: boolean;
}

export async function getStockUnitPool(
  db: Queryable,
  options: { siteId?: string; module?: MetricModule; bankOperatorId?: string } = {},
): Promise<StockUnitPoolEntry[]> {
  const conditions: string[] = [];
  const params: string[] = [];

  if (options.siteId) {
    params.push(options.siteId);
    conditions.push(`p.site_id = $${params.length}`);
  }
  if (options.module) {
    params.push(options.module);
    conditions.push(`p.module = $${params.length}`);
  }
  // Filtering by bank rather than by site: an operator running several banks
  // thinks in banks first, and a bank may hold several sites.
  if (options.bankOperatorId) {
    params.push(options.bankOperatorId);
    conditions.push(`s.bank_operator_id = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.query<PoolRow>(
    `SELECT p.*, s.name AS site_name, s.bank_operator_id, o.name AS bank_operator_name
       FROM stock_unit_pool p
       JOIN habitat_bank_site s ON s.id = p.site_id
       JOIN bank_operator o ON o.id = s.bank_operator_id
       ${where}
      ORDER BY o.name, s.name, p.module, p.parcel_reference`,
    params,
  );

  return rows.map((row) => {
    const module = assertMetricModule(row.module);
    return {
      stockParcelId: row.stock_parcel_id,
      organisationId: row.organisation_id,
      siteId: row.site_id,
      siteName: row.site_name,
      bankOperatorId: row.bank_operator_id,
      bankOperatorName: row.bank_operator_name,
      module,
      broadHabitat: row.broad_habitat,
      habitatType: row.habitat_type,
      distinctiveness: row.distinctiveness,
      condition: row.condition,
      parcelReference: row.parcel_reference,
      listPricePerUnit: row.list_price_per_unit === null ? null : Money.of(row.list_price_per_unit),
      totalUnits: UnitQuantity.of(module, row.total_units),
      soldUnits: UnitQuantity.of(module, row.sold_units),
      draftUnits: UnitQuantity.of(module, row.draft_units),
      quotedUnits: UnitQuantity.of(module, row.quoted_units),
      reservedUnits: UnitQuantity.of(module, row.reserved_units),
      exposedUnits: UnitQuantity.of(module, row.exposed_units),
      availableUnits: UnitQuantity.of(module, row.available_units),
      isOverExposed: row.is_over_exposed,
    };
  });
}

/**
 * Stock available to the solver, with each parcel's site location attached.
 *
 * The spatial band is a function of where the bank site sits relative to the
 * development, so the solver needs the site's LPA and NCA alongside the pool
 * figures. Joined here rather than fetched per parcel, which would be a query
 * per option on a page that lists them all.
 */
export interface SolverStockRow {
  stockParcelId: string;
  siteId: string;
  siteName: string;
  siteLpaCode: string | null;
  siteNcaCode: string | null;
  parcelReference: string;
  module: MetricModule;
  broadHabitat: string;
  habitatType: string;
  distinctiveness: DistinctivenessBand;
  condition: ConditionBand;
  availableUnits: UnitQuantity;
  listPricePerUnit: Money | null;
}

export async function getSolverStock(
  db: Queryable,
  options: { module: MetricModule; siteId?: string; bankOperatorId?: string },
): Promise<SolverStockRow[]> {
  const params: string[] = [options.module];
  let where = 'p.module = $1';
  if (options.siteId) {
    params.push(options.siteId);
    where += ` AND p.site_id = $${params.length}`;
  }
  // A quote supplies one operator, so the table only offers that operator's
  // stock — across every site it holds.
  if (options.bankOperatorId) {
    params.push(options.bankOperatorId);
    where += ` AND s.bank_operator_id = $${params.length}`;
  }

  const { rows } = await db.query<{
    stock_parcel_id: string;
    site_id: string;
    site_name: string;
    site_lpa_code: string | null;
    site_nca_code: string | null;
    parcel_reference: string;
    module: MetricModule;
    broad_habitat: string;
    habitat_type: string;
    distinctiveness: DistinctivenessBand;
    condition: ConditionBand;
    available_units: string;
    list_price_per_unit: string | null;
  }>(
    `SELECT p.stock_parcel_id, p.site_id, s.name AS site_name,
            s.lpa_code AS site_lpa_code, s.nca_code AS site_nca_code,
            p.parcel_reference, p.module, p.broad_habitat, p.habitat_type,
            p.distinctiveness, p.condition, p.available_units, p.list_price_per_unit
       FROM stock_unit_pool p
       JOIN habitat_bank_site s ON s.id = p.site_id
      WHERE ${where} AND p.available_units > 0
      ORDER BY p.parcel_reference`,
    params,
  );

  return rows.map((row) => {
    const module = assertMetricModule(row.module);
    return {
      stockParcelId: row.stock_parcel_id,
      siteId: row.site_id,
      siteName: row.site_name,
      siteLpaCode: row.site_lpa_code,
      siteNcaCode: row.site_nca_code,
      parcelReference: row.parcel_reference,
      module,
      broadHabitat: row.broad_habitat,
      habitatType: row.habitat_type,
      distinctiveness: row.distinctiveness,
      condition: row.condition,
      availableUnits: UnitQuantity.of(module, row.available_units),
      listPricePerUnit: row.list_price_per_unit === null ? null : Money.of(row.list_price_per_unit),
    };
  });
}
