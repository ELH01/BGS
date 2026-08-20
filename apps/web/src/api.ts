/**
 * Typed access to the API.
 *
 * Unit quantities and prices are `string` throughout, deliberately. They
 * arrive from the server already at the correct precision for their module,
 * and turning them into JavaScript numbers here would undo that — so they are
 * carried and displayed as the strings they are. Anywhere the client needs to
 * compare or total them, it does so through the shared core package rather
 * than with arithmetic on doubles.
 */

export type MetricModule = 'area' | 'hedgerow' | 'watercourse';
export type DistinctivenessBand = 'very-low' | 'low' | 'medium' | 'high' | 'very-high';
export type ConditionBand = 'n/a' | 'poor' | 'fairly-poor' | 'moderate' | 'fairly-good' | 'good';

export interface ApiError extends Error {
  status: number;
  issues?: Array<{ field: string; message: string }>;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const payload = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(payload?.error ?? `Request failed (${response.status}).`) as ApiError;
    error.status = response.status;
    if (payload?.issues) error.issues = payload.issues;
    throw error;
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
};

export interface Me {
  user: { id: string; email: string; displayName: string; role: 'owner' | 'admin' | 'member' | 'viewer' };
  organisation: { id: string; name: string; slug: string; isPlatformOperator: boolean };
  accessibleOrganisations: Array<{
    organisationId: string;
    name: string;
    slug: string;
    access: 'own' | 'manage' | 'read';
  }>;
}

export interface Branding {
  companyName: string | null;
  address: string | null;
  contact: string | null;
  logoFileId: string | null;
  accentColour: string | null;
}

export interface BankOperator {
  id: string;
  organisationId: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  branding: Branding;
}

export interface Site {
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
}

export type StrategicSignificanceBand =
  | 'formally-identified'
  | 'ecologically-desirable'
  | 'not-in-strategy';

export const STRATEGIC_SIGNIFICANCE_LABEL: Record<StrategicSignificanceBand, string> = {
  'formally-identified': 'Formally identified in local strategy',
  'ecologically-desirable': 'Ecologically desirable, not in strategy',
  'not-in-strategy': 'Not in local strategy',
};

/** What a parcel still needs before it can be written into a developer's metric. */
export interface ExportReadiness {
  ready: boolean;
  missing: string[];
}

export interface StockParcel {
  id: string;
  siteId: string;
  parcelReference: string;
  module: MetricModule;
  broadHabitat: string;
  habitatType: string;
  distinctiveness: DistinctivenessBand;
  condition: ConditionBand;
  totalUnits: string;
  retiredUnits: string;
  listPricePerUnit: string | null;
  /**
   * Inputs the metric uses to compute this parcel's units. The workbook does
   * the calculation, so all of these have to reach it for a developer's metric
   * to arrive at the figure the parcel was quoted on.
   */
  extent: string | null;
  strategicSignificance: StrategicSignificanceBand | null;
  habitatCreatedInAdvanceYears: string | null;
  delayYears: string | null;
  notes: string | null;
  exportReadiness?: ExportReadiness;
}

export interface BankRollUp {
  bankOperatorId: string;
  bankOperatorName: string;
  parcels: number;
  overExposed: number;
}

export interface PoolEntry {
  stockParcelId: string;
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
  listPricePerUnit: string | null;
  totalUnits: string;
  soldUnits: string;
  draftUnits: string;
  quotedUnits: string;
  reservedUnits: string;
  exposedUnits: string;
  availableUnits: string;
  isOverExposed: boolean;
}

export interface AppConfig {
  modules: Array<{ id: MetricModule; label: string; decimalPlaces: number }>;
  spatialRisk: {
    schemeId: string;
    label: string;
    status: 'unconfirmed' | 'confirmed';
    source: string;
    bands: Array<{ id: string; label: string; deliveryFactor: string }>;
  };
  tradingRules: { status: 'unconfirmed' | 'confirmed'; source: string };
  netGain: { statutoryPercent: string; bufferPercent: string; bufferConfirmed: boolean };
  quotes: { staleAfterDays: number; staleThresholdConfirmed: boolean };
}

export const DISTINCTIVENESS_LABEL: Record<DistinctivenessBand, string> = {
  'very-low': 'Very Low',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  'very-high': 'Very High',
};

export const CONDITION_LABEL: Record<ConditionBand, string> = {
  'n/a': 'N/A',
  poor: 'Poor',
  'fairly-poor': 'Fairly Poor',
  moderate: 'Moderate',
  'fairly-good': 'Fairly Good',
  good: 'Good',
};

export const MODULE_LABEL: Record<MetricModule, string> = {
  area: 'Area habitat',
  hedgerow: 'Hedgerow',
  watercourse: 'Watercourse',
};

/** Format a price string for display without going through a float. */
export function formatMoney(value: string | null): string {
  if (value === null) return '—';
  const negative = value.startsWith('-');
  const [whole = '0', fraction = '00'] = value.replace('-', '').split('.');
  return `${negative ? '-' : ''}£${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

// ---------------------------------------------------------------------------
// Quotes, developers and the allocation table
// ---------------------------------------------------------------------------

export type QuoteStatus = 'draft' | 'quoted' | 'reserved' | 'sold' | 'cancelled';
export type QuotePriority = 'high' | 'medium' | 'low';
export type SpatialBand = 'same-lpa' | 'neighbouring-lpa-same-nca' | 'outside';

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: 'Draft',
  quoted: 'Quoted',
  reserved: 'Reserved',
  sold: 'Sold',
  cancelled: 'Cancelled',
};

export const SPATIAL_BAND_LABEL: Record<SpatialBand, string> = {
  'same-lpa': 'Same LPA',
  'neighbouring-lpa-same-nca': 'Neighbouring LPA, same NCA',
  outside: 'Outside',
};

export interface Developer {
  id: string;
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
}

export interface AllocationLine {
  id: string;
  stockParcelId: string;
  module: MetricModule;
  rawQuantity: string;
  spatialBand: SpatialBand;
  spatialFactor: string;
  effectiveUnits: string;
  unitPrice: string;
  lineTotal: string;
  tradingRuleJustification: string | null;
}

export interface QuoteModuleTarget {
  module: MetricModule;
  source: 'metric' | 'manual';
  requiredUnits: string;
  bufferedTargetUnits: string;
  shortfallBroadHabitat: string | null;
  shortfallHabitatType: string | null;
  shortfallDistinctiveness: DistinctivenessBand | null;
}

export interface Quote {
  id: string;
  reference: string;
  developerId: string;
  developerMetricId: string | null;
  status: QuoteStatus;
  priority: QuotePriority;
  totalPrice: string;
  notes: string | null;
  lastActivityAt: string;
  reservationExpiresAt: string | null;
  cancellationReason: string | null;
  soldAt: string | null;
  isStale: boolean;
  targets: QuoteModuleTarget[];
  lines: AllocationLine[];
}

export interface QuoteSummary {
  id: string;
  reference: string;
  developerId: string;
  developerName: string;
  status: QuoteStatus;
  priority: QuotePriority;
  totalPrice: string;
  lastActivityAt: string;
  reservationExpiresAt: string | null;
  isStale: boolean;
  lineCount: number;
}

export interface SaleRecord {
  id: string;
  planningApplicationReference: string | null;
  bgsRegisterSubmissionDate: string | null;
  soldDate: string;
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface AuditRecord {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  createdAt: string;
}

/** One row of the allocation table: a parcel that may lawfully fill the shortfall. */
export interface AllocationOption {
  stockParcelId: string;
  siteId: string;
  siteName: string;
  parcelReference: string;
  broadHabitat: string;
  habitatType: string;
  distinctiveness: DistinctivenessBand;
  condition: ConditionBand;
  availableUnits: string;
  listPricePerUnit: string | null;
  spatialBand: SpatialBand;
  spatialFactor: string;
  rawUnitsPerEffectiveUnit: string;
  maximumEffectiveUnits: string;
  effectiveCostPerUnit: string | null;
  tradingRuleJustification: string;
}

export interface AllocationSolution {
  module: MetricModule;
  requiredUnits: string;
  bufferedTargetUnits: string;
  options: AllocationOption[];
  suggested: Array<{
    stockParcelId: string;
    rawQuantity: string;
    effectiveUnits: string;
    unitPrice: string | null;
    lineTotal: string | null;
  }>;
  suggestedEffectiveUnits: string;
  shortOfTarget: boolean;
  unmetUnits: string;
  rejected: Array<{ stockParcelId: string; parcelReference: string; reason: string }>;
  /** False when the habitat lost was not described, so nothing was filtered. */
  tradingRulesApplied: boolean;
  spatialScheme: { id: string; status: string };
}

export interface TargetStatus {
  module: MetricModule;
  requiredUnits: string;
  bufferedTargetUnits: string;
  deliveredUnits: string;
  shortBy: string;
  meetsTarget: boolean;
}

export interface DocumentPreview {
  reference: string;
  brandingOperator: { id: string; name: string } | null;
  operatorCount: number;
  lineCount: number;
  totals: {
    excludingVat: string;
    vat: string;
    includingVat: string;
    vatCharged: boolean;
    ratePercent: string;
  };
  vat: { treatment: 'none' | 'standard-rate'; ratePercent: string; status: string };
  filename: string;
  warnings: string[];
}

/**
 * Download a generated file.
 *
 * Fetched rather than linked so the session cookie and any error response are
 * handled the same way as every other call; a plain link would show the JSON
 * error body in a new tab if something went wrong.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.error ?? `Download failed (${response.status}).`) as ApiError;
    error.status = response.status;
    throw error;
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const named = /filename="([^"]+)"/.exec(disposition)?.[1];
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = named ?? fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
