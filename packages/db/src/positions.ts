import type { Queryable } from './client.js';
import type { MetricModule } from '@bgs/core';
import type { QuoteStatus } from './quotes.js';

/**
 * The commercial position, flattened for export.
 *
 * Read as three plain queries rather than assembled from the richer domain
 * types: an export wants strings and dates in rows, and routing it through the
 * value objects only to turn them straight back into strings would be work for
 * its own sake. The numeric columns still arrive as exact decimal strings,
 * because that is how Postgres numeric is read throughout this codebase.
 */

export interface PositionFilters {
  bankOperatorId?: string | undefined;
  /** Defaults to everything except cancelled, which is rarely what is wanted. */
  statuses?: readonly QuoteStatus[] | undefined;
}

const DEFAULT_STATUSES: QuoteStatus[] = ['draft', 'quoted', 'reserved', 'sold'];

export interface AllocationPositionRow {
  quoteReference: string;
  quoteStatus: QuoteStatus;
  priority: string;
  purchaser: string;
  developmentSite: string | null;
  bankOperator: string;
  site: string;
  parcelReference: string;
  module: MetricModule;
  broadHabitat: string;
  habitatType: string;
  distinctiveness: string;
  rawQuantity: string;
  spatialBand: string;
  spatialFactor: string;
  effectiveUnits: string;
  unitPrice: string;
  lineTotal: string;
  createdAt: Date;
  lastActivityAt: Date;
  reservationExpiresAt: Date | null;
  soldAt: Date | null;
}

function statusClause(filters: PositionFilters, params: unknown[], alias = 'q'): string {
  const statuses = filters.statuses && filters.statuses.length > 0 ? filters.statuses : DEFAULT_STATUSES;
  params.push(statuses);
  let clause = `${alias}.status = ANY($${params.length}::quote_status[])`;

  if (filters.bankOperatorId) {
    params.push(filters.bankOperatorId);
    clause += ` AND ${alias}.bank_operator_id = $${params.length}`;
  }
  return clause;
}

export async function getAllocationPositions(
  db: Queryable,
  filters: PositionFilters = {},
): Promise<AllocationPositionRow[]> {
  const params: unknown[] = [];
  const where = statusClause(filters, params);

  const { rows } = await db.query<Record<string, never>>(
    `SELECT q.reference AS quote_reference, q.status AS quote_status, q.priority,
            d.purchasing_entity_name AS purchaser, d.development_site_address AS development_site,
            o.name AS bank_operator, s.name AS site, p.parcel_reference,
            l.module, p.broad_habitat, p.habitat_type, p.distinctiveness,
            l.raw_quantity, l.spatial_band, l.spatial_factor, l.effective_units,
            l.unit_price, l.line_total,
            q.created_at, q.last_activity_at, q.reservation_expires_at, q.sold_at
       FROM allocation_line l
       JOIN quote q ON q.id = l.quote_id
       JOIN developer d ON d.id = q.developer_id
       JOIN stock_parcel p ON p.id = l.stock_parcel_id
       JOIN habitat_bank_site s ON s.id = p.site_id
       JOIN bank_operator o ON o.id = s.bank_operator_id
      WHERE ${where}
      ORDER BY o.name, q.reference, l.module, p.parcel_reference`,
    params as never,
  );

  return rows.map((row) => {
    const r = row as unknown as Record<string, string | Date | null>;
    return {
      quoteReference: r['quote_reference'] as string,
      quoteStatus: r['quote_status'] as QuoteStatus,
      priority: r['priority'] as string,
      purchaser: r['purchaser'] as string,
      developmentSite: (r['development_site'] as string | null) ?? null,
      bankOperator: r['bank_operator'] as string,
      site: r['site'] as string,
      parcelReference: r['parcel_reference'] as string,
      module: r['module'] as MetricModule,
      broadHabitat: r['broad_habitat'] as string,
      habitatType: r['habitat_type'] as string,
      distinctiveness: r['distinctiveness'] as string,
      rawQuantity: r['raw_quantity'] as string,
      spatialBand: r['spatial_band'] as string,
      spatialFactor: r['spatial_factor'] as string,
      effectiveUnits: r['effective_units'] as string,
      unitPrice: r['unit_price'] as string,
      lineTotal: r['line_total'] as string,
      createdAt: r['created_at'] as Date,
      lastActivityAt: r['last_activity_at'] as Date,
      reservationExpiresAt: (r['reservation_expires_at'] as Date | null) ?? null,
      soldAt: (r['sold_at'] as Date | null) ?? null,
    };
  });
}

export interface QuotePositionRow {
  reference: string;
  status: QuoteStatus;
  priority: string;
  purchaser: string;
  bankOperator: string | null;
  lineCount: number;
  totalExcludingVat: string;
  createdAt: Date;
  lastActivityAt: Date;
  reservationExpiresAt: Date | null;
  soldAt: Date | null;
  planningApplicationReference: string | null;
}

export async function getQuotePositions(
  db: Queryable,
  filters: PositionFilters = {},
): Promise<QuotePositionRow[]> {
  const params: unknown[] = [];
  const where = statusClause(filters, params);

  const { rows } = await db.query<Record<string, never>>(
    `SELECT q.reference, q.status, q.priority, q.total_price,
            d.purchasing_entity_name AS purchaser, o.name AS bank_operator,
            (SELECT count(*) FROM allocation_line l WHERE l.quote_id = q.id) AS line_count,
            q.created_at, q.last_activity_at, q.reservation_expires_at, q.sold_at,
            sr.planning_application_reference
       FROM quote q
       JOIN developer d ON d.id = q.developer_id
       LEFT JOIN bank_operator o ON o.id = q.bank_operator_id
       LEFT JOIN sale_record sr ON sr.quote_id = q.id AND sr.reversed_at IS NULL
      WHERE ${where}
      ORDER BY q.created_at DESC`,
    params as never,
  );

  return rows.map((row) => {
    const r = row as unknown as Record<string, string | Date | null>;
    return {
      reference: r['reference'] as string,
      status: r['status'] as QuoteStatus,
      priority: r['priority'] as string,
      purchaser: r['purchaser'] as string,
      bankOperator: (r['bank_operator'] as string | null) ?? null,
      lineCount: Number(r['line_count']),
      totalExcludingVat: r['total_price'] as string,
      createdAt: r['created_at'] as Date,
      lastActivityAt: r['last_activity_at'] as Date,
      reservationExpiresAt: (r['reservation_expires_at'] as Date | null) ?? null,
      soldAt: (r['sold_at'] as Date | null) ?? null,
      planningApplicationReference: (r['planning_application_reference'] as string | null) ?? null,
    };
  });
}

export interface ParcelPositionRow {
  bankOperator: string;
  site: string;
  parcelReference: string;
  module: MetricModule;
  broadHabitat: string;
  habitatType: string;
  distinctiveness: string;
  condition: string;
  totalUnits: string;
  quotedUnits: string;
  reservedUnits: string;
  soldUnits: string;
  availableUnits: string;
  isOverExposed: boolean;
  listPricePerUnit: string | null;
}

export async function getParcelPositions(
  db: Queryable,
  filters: PositionFilters = {},
): Promise<ParcelPositionRow[]> {
  const params: unknown[] = [];
  // The stock position is a property of the parcel, not of any quote, so the
  // status filter does not apply here — only the bank filter does.
  let where = '1 = 1';
  if (filters.bankOperatorId) {
    params.push(filters.bankOperatorId);
    where = `s.bank_operator_id = $${params.length}`;
  }

  const { rows } = await db.query<Record<string, never>>(
    `SELECT o.name AS bank_operator, s.name AS site, pool.parcel_reference, pool.module,
            pool.broad_habitat, pool.habitat_type, pool.distinctiveness, pool.condition,
            pool.total_units, pool.quoted_units, pool.reserved_units, pool.sold_units,
            pool.available_units, pool.is_over_exposed, pool.list_price_per_unit
       FROM stock_unit_pool pool
       JOIN habitat_bank_site s ON s.id = pool.site_id
       JOIN bank_operator o ON o.id = s.bank_operator_id
      WHERE ${where}
      ORDER BY o.name, s.name, pool.module, pool.parcel_reference`,
    params as never,
  );

  return rows.map((row) => {
    const r = row as unknown as Record<string, string | boolean | null>;
    return {
      bankOperator: r['bank_operator'] as string,
      site: r['site'] as string,
      parcelReference: r['parcel_reference'] as string,
      module: r['module'] as MetricModule,
      broadHabitat: r['broad_habitat'] as string,
      habitatType: r['habitat_type'] as string,
      distinctiveness: r['distinctiveness'] as string,
      condition: r['condition'] as string,
      totalUnits: r['total_units'] as string,
      quotedUnits: r['quoted_units'] as string,
      reservedUnits: r['reserved_units'] as string,
      soldUnits: r['sold_units'] as string,
      availableUnits: r['available_units'] as string,
      isOverExposed: Boolean(r['is_over_exposed']),
      listPricePerUnit: (r['list_price_per_unit'] as string | null) ?? null,
    };
  });
}
