import { Money, UnitQuantity, assertMetricModule, type MetricModule } from '@bgs/core';
import type { Queryable } from './client.js';

/**
 * Quote, allocation, sale and audit persistence (§3.7–§3.10, §4.4–§4.6).
 *
 * The database owns the rules that must never be bypassed — the status ladder,
 * the immutability of a sold quote's lines, precision, tenant isolation — so
 * this layer's job is to express intent and let those rules bite.
 */

export type QuoteStatus = 'draft' | 'quoted' | 'reserved' | 'sold' | 'cancelled';
export type QuotePriority = 'high' | 'medium' | 'low';
export type SpatialBand = 'same-lpa' | 'neighbouring-lpa-same-nca' | 'outside';

export interface AllocationLine {
  id: string;
  quoteId: string;
  stockParcelId: string;
  module: MetricModule;
  rawQuantity: UnitQuantity;
  spatialBand: SpatialBand;
  spatialFactor: string;
  effectiveUnits: UnitQuantity;
  unitPrice: Money;
  lineTotal: Money;
  tradingRuleJustification: string | null;
}

export interface QuoteModuleTarget {
  module: MetricModule;
  source: 'metric' | 'manual';
  requiredUnits: UnitQuantity;
  bufferedTargetUnits: UnitQuantity;
  /**
   * The habitat lost, which the trading rules filter against. All three are
   * absent together when the enquiry did not describe it (§4.4 manual path).
   */
  shortfallBroadHabitat: string | null;
  shortfallHabitatType: string | null;
  shortfallDistinctiveness: string | null;
}

export interface Quote {
  id: string;
  organisationId: string;
  reference: string;
  developerId: string;
  developerMetricId: string | null;
  status: QuoteStatus;
  priority: QuotePriority;
  totalPrice: Money;
  spatialSchemeId: string;
  bufferPercent: string;
  notes: string | null;
  lastActivityAt: Date;
  reservedAt: Date | null;
  reservationExpiresAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  soldAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Derived at read time from lastActivityAt and the configured threshold. */
  isStale: boolean;
  targets: QuoteModuleTarget[];
  lines: AllocationLine[];
}

interface QuoteRow {
  id: string;
  organisation_id: string;
  reference: string;
  developer_id: string;
  developer_metric_id: string | null;
  status: QuoteStatus;
  priority: QuotePriority;
  total_price: string;
  spatial_scheme_id: string;
  buffer_percent: string;
  notes: string | null;
  last_activity_at: Date;
  reserved_at: Date | null;
  reservation_expires_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  sold_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface LineRow {
  id: string;
  quote_id: string;
  stock_parcel_id: string;
  module: MetricModule;
  raw_quantity: string;
  spatial_band: SpatialBand;
  spatial_factor: string;
  effective_units: string;
  unit_price: string;
  line_total: string;
  trading_rule_justification: string | null;
}

interface TargetRow {
  module: MetricModule;
  source: 'metric' | 'manual';
  required_units: string;
  buffered_target_units: string;
  shortfall_broad_habitat: string | null;
  shortfall_habitat_type: string | null;
  shortfall_distinctiveness: string | null;
}

function toLine(row: LineRow): AllocationLine {
  const module = assertMetricModule(row.module);
  return {
    id: row.id,
    quoteId: row.quote_id,
    stockParcelId: row.stock_parcel_id,
    module,
    rawQuantity: UnitQuantity.of(module, row.raw_quantity),
    spatialBand: row.spatial_band,
    spatialFactor: row.spatial_factor,
    effectiveUnits: UnitQuantity.of(module, row.effective_units),
    unitPrice: Money.of(row.unit_price),
    lineTotal: Money.of(row.line_total),
    tradingRuleJustification: row.trading_rule_justification,
  };
}

function toTarget(row: TargetRow): QuoteModuleTarget {
  const module = assertMetricModule(row.module);
  return {
    module,
    source: row.source,
    requiredUnits: UnitQuantity.of(module, row.required_units),
    bufferedTargetUnits: UnitQuantity.of(module, row.buffered_target_units),
    shortfallBroadHabitat: row.shortfall_broad_habitat,
    shortfallHabitatType: row.shortfall_habitat_type,
    shortfallDistinctiveness: row.shortfall_distinctiveness,
  };
}

function isStale(row: QuoteRow, staleAfterDays: number): boolean {
  // Only a live quote can go stale; a sold or cancelled one is simply finished.
  if (row.status !== 'quoted' && row.status !== 'reserved') return false;
  const ageMs = Date.now() - row.last_activity_at.getTime();
  return ageMs > staleAfterDays * 24 * 60 * 60 * 1000;
}

function toQuote(
  row: QuoteRow,
  targets: TargetRow[],
  lines: LineRow[],
  staleAfterDays: number,
): Quote {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    reference: row.reference,
    developerId: row.developer_id,
    developerMetricId: row.developer_metric_id,
    status: row.status,
    priority: row.priority,
    totalPrice: Money.of(row.total_price),
    spatialSchemeId: row.spatial_scheme_id,
    bufferPercent: row.buffer_percent,
    notes: row.notes,
    lastActivityAt: row.last_activity_at,
    reservedAt: row.reserved_at,
    reservationExpiresAt: row.reservation_expires_at,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    soldAt: row.sold_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isStale: isStale(row, staleAfterDays),
    targets: targets.map(toTarget),
    lines: lines.map(toLine),
  };
}

// ---------------------------------------------------------------------------
// Audit (§3.10)
// ---------------------------------------------------------------------------

export interface AuditEntry {
  organisationId: string;
  entityType: string;
  entityId: string;
  action: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  note?: string | null;
  detail?: unknown;
  actorUserId?: string | null;
}

export async function writeAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (organisation_id, entity_type, entity_id, action,
                            from_status, to_status, note, detail, actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      entry.organisationId,
      entry.entityType,
      entry.entityId,
      entry.action,
      entry.fromStatus ?? null,
      entry.toStatus ?? null,
      entry.note ?? null,
      JSON.stringify(entry.detail ?? {}),
      entry.actorUserId ?? null,
    ],
  );
}

export interface AuditRecord {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  detail: unknown;
  actorUserId: string | null;
  createdAt: Date;
}

export async function listAudit(
  db: Queryable,
  entityType: string,
  entityId: string,
): Promise<AuditRecord[]> {
  const { rows } = await db.query<{
    id: string;
    entity_type: string;
    entity_id: string;
    action: string;
    from_status: string | null;
    to_status: string | null;
    note: string | null;
    detail: unknown;
    actor_user_id: string | null;
    created_at: Date;
  }>(
    `SELECT * FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC, id DESC`,
    [entityType, entityId],
  );

  return rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    detail: row.detail,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getQuote(
  db: Queryable,
  quoteId: string,
  staleAfterDays = 60,
): Promise<Quote | null> {
  const { rows } = await db.query<QuoteRow>('SELECT * FROM quote WHERE id = $1', [quoteId]);
  const row = rows[0];
  if (!row) return null;

  const [targets, lines] = await Promise.all([
    db.query<TargetRow>('SELECT * FROM quote_module_target WHERE quote_id = $1 ORDER BY module', [quoteId]),
    db.query<LineRow>('SELECT * FROM allocation_line WHERE quote_id = $1 ORDER BY module, created_at', [
      quoteId,
    ]),
  ]);

  return toQuote(row, targets.rows, lines.rows, staleAfterDays);
}

export interface QuoteSummary {
  id: string;
  reference: string;
  developerId: string;
  developerName: string;
  status: QuoteStatus;
  priority: QuotePriority;
  totalPrice: Money;
  lastActivityAt: Date;
  reservationExpiresAt: Date | null;
  isStale: boolean;
  lineCount: number;
}

export async function listQuotes(
  db: Queryable,
  options: { status?: QuoteStatus; developerId?: string; staleAfterDays?: number } = {},
): Promise<QuoteSummary[]> {
  const staleAfterDays = options.staleAfterDays ?? 60;
  const conditions: string[] = [];
  const params: string[] = [];

  if (options.status) {
    params.push(options.status);
    conditions.push(`q.status = $${params.length}`);
  }
  if (options.developerId) {
    params.push(options.developerId);
    conditions.push(`q.developer_id = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await db.query<
    QuoteRow & { developer_name: string; line_count: string }
  >(
    `SELECT q.*, d.purchasing_entity_name AS developer_name,
            (SELECT count(*) FROM allocation_line l WHERE l.quote_id = q.id) AS line_count
       FROM quote q
       JOIN developer d ON d.id = q.developer_id
       ${where}
      ORDER BY q.created_at DESC`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    developerId: row.developer_id,
    developerName: row.developer_name,
    status: row.status,
    priority: row.priority,
    totalPrice: Money.of(row.total_price),
    lastActivityAt: row.last_activity_at,
    reservationExpiresAt: row.reservation_expires_at,
    isStale: isStale(row, staleAfterDays),
    lineCount: Number(row.line_count),
  }));
}

// ---------------------------------------------------------------------------
// Creating and editing
// ---------------------------------------------------------------------------

export interface CreateQuoteInput {
  organisationId: string;
  developerId: string;
  developerMetricId?: string | null | undefined;
  priority?: QuotePriority | undefined;
  notes?: string | null | undefined;
  spatialSchemeId: string;
  bufferPercent: string;
  targets: readonly QuoteModuleTarget[];
  createdBy?: string | null | undefined;
}

/** Create a quote in `draft`, which is where the allocation table lives. */
export async function createDraftQuote(db: Queryable, input: CreateQuoteInput): Promise<string> {
  const { rows: refRows } = await db.query<{ reference: string }>(
    'SELECT app.next_quote_reference($1) AS reference',
    [input.organisationId],
  );
  const reference = refRows[0]?.reference;
  if (!reference) throw new Error('Failed to allocate a quote reference.');

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO quote (organisation_id, reference, developer_id, developer_metric_id,
                        status, priority, spatial_scheme_id, buffer_percent, notes, created_by)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      input.organisationId,
      reference,
      input.developerId,
      input.developerMetricId ?? null,
      input.priority ?? 'medium',
      input.spatialSchemeId,
      input.bufferPercent,
      input.notes ?? null,
      input.createdBy ?? null,
    ],
  );
  const quoteId = rows[0]?.id;
  if (!quoteId) throw new Error('Failed to create quote.');

  for (const target of input.targets) {
    await db.query(
      `INSERT INTO quote_module_target (organisation_id, quote_id, module, source,
                                        required_units, buffered_target_units,
                                        shortfall_broad_habitat, shortfall_habitat_type,
                                        shortfall_distinctiveness)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.organisationId,
        quoteId,
        target.module,
        target.source,
        target.requiredUnits.toString(),
        target.bufferedTargetUnits.toString(),
        target.shortfallBroadHabitat,
        target.shortfallHabitatType,
        target.shortfallDistinctiveness,
      ],
    );
  }

  await writeAudit(db, {
    organisationId: input.organisationId,
    entityType: 'quote',
    entityId: quoteId,
    action: 'created',
    toStatus: 'draft',
    actorUserId: input.createdBy ?? null,
    detail: { reference },
  });

  return quoteId;
}

export interface AllocationLineInput {
  stockParcelId: string;
  module: MetricModule;
  rawQuantity: UnitQuantity;
  spatialBand: SpatialBand;
  spatialFactor: string;
  effectiveUnits: UnitQuantity;
  unitPrice: Money;
  tradingRuleJustification?: string | null;
}

/**
 * Replace a quote's allocation lines wholesale — what confirming the
 * allocation table does.
 *
 * Wholesale replacement rather than a diff because the table is edited as a
 * whole: rows are added, removed and rebalanced together, and reconstructing
 * that as a set of individual edits would record noise rather than intent.
 */
export async function replaceAllocationLines(
  db: Queryable,
  quoteId: string,
  organisationId: string,
  lines: readonly AllocationLineInput[],
): Promise<Money> {
  await db.query('DELETE FROM allocation_line WHERE quote_id = $1', [quoteId]);

  const totals: Money[] = [];
  for (const line of lines) {
    if (line.rawQuantity.module !== line.module || line.effectiveUnits.module !== line.module) {
      throw new TypeError(`Allocation line quantities must be ${line.module} quantities.`);
    }
    const lineTotal = Money.lineTotal(line.unitPrice, line.rawQuantity);
    totals.push(lineTotal);

    await db.query(
      `INSERT INTO allocation_line (organisation_id, quote_id, stock_parcel_id, module,
                                    raw_quantity, spatial_band, spatial_factor, effective_units,
                                    unit_price, line_total, trading_rule_justification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        organisationId,
        quoteId,
        line.stockParcelId,
        line.module,
        line.rawQuantity.toString(),
        line.spatialBand,
        line.spatialFactor,
        line.effectiveUnits.toString(),
        line.unitPrice.toString(),
        lineTotal.toString(),
        line.tradingRuleJustification ?? null,
      ],
    );
  }

  const total = Money.sum(totals);
  await db.query('UPDATE quote SET total_price = $2, last_activity_at = now() WHERE id = $1', [
    quoteId,
    total.toString(),
  ]);
  return total;
}

export async function updateQuoteStatus(
  db: Queryable,
  quoteId: string,
  status: QuoteStatus,
  extra: {
    reservedAt?: Date | null;
    reservationExpiresAt?: Date | null;
    cancelledAt?: Date | null;
    cancellationReason?: string | null;
    soldAt?: Date | null;
  } = {},
): Promise<void> {
  await db.query(
    `UPDATE quote SET
        status = $2,
        reserved_at = COALESCE($3, reserved_at),
        reservation_expires_at = $4,
        cancelled_at = $5,
        cancellation_reason = $6,
        sold_at = $7,
        last_activity_at = now()
      WHERE id = $1`,
    [
      quoteId,
      status,
      extra.reservedAt ?? null,
      extra.reservationExpiresAt ?? null,
      extra.cancelledAt ?? null,
      extra.cancellationReason ?? null,
      extra.soldAt ?? null,
    ],
  );
}

export async function updateQuoteDetails(
  db: Queryable,
  quoteId: string,
  input: { priority?: QuotePriority; notes?: string | null },
): Promise<void> {
  await db.query(
    `UPDATE quote SET
        priority = COALESCE($2, priority),
        notes = COALESCE($3, notes),
        last_activity_at = now()
      WHERE id = $1`,
    [quoteId, input.priority ?? null, input.notes ?? null],
  );
}

// ---------------------------------------------------------------------------
// Sale and retirement (§4.6)
// ---------------------------------------------------------------------------

export interface SaleInput {
  organisationId: string;
  quoteId: string;
  planningApplicationReference?: string | null;
  bgsRegisterSubmissionDate?: string | null;
  soldDate: string;
}

/**
 * Retire the quote's allocated units from their parcels, and snapshot exactly
 * what was taken from each.
 *
 * The snapshot is what makes a reversal exact (§4.6.6): restoring from the
 * allocation lines instead would restore whatever they say *now*, which is not
 * necessarily what was retired then.
 */
export async function recordSale(db: Queryable, input: SaleInput): Promise<string> {
  const { rows: saleRows } = await db.query<{ id: string }>(
    `INSERT INTO sale_record (organisation_id, quote_id, planning_application_reference,
                              bgs_register_submission_date, sold_date)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [
      input.organisationId,
      input.quoteId,
      input.planningApplicationReference ?? null,
      input.bgsRegisterSubmissionDate ?? null,
      input.soldDate,
    ],
  );
  const saleId = saleRows[0]?.id;
  if (!saleId) throw new Error('Failed to create sale record.');

  const { rows: lines } = await db.query<LineRow>(
    'SELECT * FROM allocation_line WHERE quote_id = $1',
    [input.quoteId],
  );

  for (const line of lines) {
    await db.query(
      `INSERT INTO sale_retirement (organisation_id, sale_record_id, stock_parcel_id, module, quantity)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.organisationId, saleId, line.stock_parcel_id, line.module, line.raw_quantity],
    );

    // Partial retirement: the parcel keeps whatever was not sold, at full
    // precision. The database refuses to retire more than the parcel holds.
    await db.query('UPDATE stock_parcel SET retired_units = retired_units + $2 WHERE id = $1', [
      line.stock_parcel_id,
      line.raw_quantity,
    ]);
  }

  return saleId;
}

/** Restore the exact quantities a sale retired (§4.6.6). */
export async function reverseSale(
  db: Queryable,
  quoteId: string,
  reason: string,
): Promise<{ saleId: string; restored: Array<{ stockParcelId: string; quantity: string }> }> {
  const { rows: saleRows } = await db.query<{ id: string }>(
    'SELECT id FROM sale_record WHERE quote_id = $1 AND reversed_at IS NULL',
    [quoteId],
  );
  const saleId = saleRows[0]?.id;
  if (!saleId) throw new Error('No sale to reverse for this quote.');

  const { rows: retirements } = await db.query<{
    id: string;
    stock_parcel_id: string;
    quantity: string;
  }>('SELECT id, stock_parcel_id, quantity FROM sale_retirement WHERE sale_record_id = $1 AND restored_at IS NULL', [
    saleId,
  ]);

  const restored: Array<{ stockParcelId: string; quantity: string }> = [];
  for (const retirement of retirements) {
    await db.query('UPDATE stock_parcel SET retired_units = retired_units - $2 WHERE id = $1', [
      retirement.stock_parcel_id,
      retirement.quantity,
    ]);
    await db.query('UPDATE sale_retirement SET restored_at = now() WHERE id = $1', [retirement.id]);
    restored.push({ stockParcelId: retirement.stock_parcel_id, quantity: retirement.quantity });
  }

  await db.query('UPDATE sale_record SET reversed_at = now(), reversal_reason = $2 WHERE id = $1', [
    saleId,
    reason,
  ]);

  return { saleId, restored };
}

export interface SaleRecord {
  id: string;
  quoteId: string;
  planningApplicationReference: string | null;
  bgsRegisterSubmissionDate: string | null;
  soldDate: string;
  reversedAt: Date | null;
  reversalReason: string | null;
}

export async function getSaleForQuote(db: Queryable, quoteId: string): Promise<SaleRecord | null> {
  const { rows } = await db.query<{
    id: string;
    quote_id: string;
    planning_application_reference: string | null;
    bgs_register_submission_date: string | null;
    sold_date: string;
    reversed_at: Date | null;
    reversal_reason: string | null;
  }>('SELECT * FROM sale_record WHERE quote_id = $1', [quoteId]);

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    quoteId: row.quote_id,
    planningApplicationReference: row.planning_application_reference,
    bgsRegisterSubmissionDate: row.bgs_register_submission_date,
    soldDate: row.sold_date,
    reversedAt: row.reversed_at,
    reversalReason: row.reversal_reason,
  };
}

export async function updateSaleRegisterDate(
  db: Queryable,
  quoteId: string,
  date: string | null,
): Promise<void> {
  await db.query('UPDATE sale_record SET bgs_register_submission_date = $2 WHERE quote_id = $1', [
    quoteId,
    date,
  ]);
}
