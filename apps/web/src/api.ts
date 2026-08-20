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
  notes: string | null;
}

export interface PoolEntry {
  stockParcelId: string;
  siteId: string;
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
