import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DISTINCTIVENESS_LABEL,
  MODULE_LABEL,
  api,
  formatMoney,
  type MetricModule,
  type PoolEntry,
  type Site,
} from '../api';
import { Empty, ErrorBanner, Field, UnconfirmedNotice } from '../components/common';
import { useSession } from '../session';

const MODULES: MetricModule[] = ['area', 'hedgerow', 'watercourse'];

/**
 * The exposure dashboard (§4.4).
 *
 * Rolled up per module and shown per parcel, because exposure is tracked at
 * parcel level — that is how the solver picks stock and how retirement works,
 * so anything coarser would need reconciling back to a parcel at the point of
 * sale anyway.
 */
export default function Exposure(): ReactNode {
  const { config } = useSession();
  const [params, setParams] = useSearchParams();
  const siteId = params.get('siteId') ?? '';

  const [sites, setSites] = useState<Site[]>([]);
  const [pool, setPool] = useState<PoolEntry[]>([]);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const [siteResponse, poolResponse] = await Promise.all([
        api.get<{ sites: Site[] }>('/api/sites'),
        api.get<{ pool: PoolEntry[] }>(
          siteId ? `/api/stock-pool?siteId=${encodeURIComponent(siteId)}` : '/api/stock-pool',
        ),
      ]);
      setSites(siteResponse.sites);
      setPool(poolResponse.pool);
    } catch (caught) {
      setError(caught);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  const overExposed = pool.filter((entry) => entry.isOverExposed);

  return (
    <>
      <div className="page-header">
        <h1>Stock exposure</h1>
        <p>
          A quote is soft: it marks units as exposed but does not reduce what is available. A reservation
          is firm, and does.
        </p>
      </div>

      <ErrorBanner error={error} />

      {config?.spatialRisk.status === 'unconfirmed' && (
        <UnconfirmedNotice
          title="Spatial risk multiplier data has not been confirmed."
          detail={config.spatialRisk.source}
        />
      )}

      {sites.length > 0 && (
        <div className="card" style={{ paddingTop: '0.9rem', paddingBottom: '0.9rem' }}>
          <Field label="Showing exposure for">
            <select
              value={siteId}
              onChange={(event) => {
                const next = event.target.value;
                setParams(next ? { siteId: next } : {});
              }}
            >
              <option value="">All sites</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {overExposed.length > 0 && (
        <div className="banner warning">
          <strong>
            {overExposed.length} {overExposed.length === 1 ? 'parcel is' : 'parcels are'} quoted beyond what
            they hold.
          </strong>
          This is allowed — not every quote converts — but it is shown here rather than hidden.
        </div>
      )}

      {pool.length === 0 ? (
        <div className="card">
          <Empty>No stock recorded{siteId ? ' for this site' : ''} yet.</Empty>
        </div>
      ) : (
        MODULES.map((module) => {
          const entries = pool.filter((entry) => entry.module === module);
          if (entries.length === 0) return null;

          return (
            <div className="card" key={module}>
              <h2>{MODULE_LABEL[module]}</h2>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Parcel</th>
                      <th>Habitat</th>
                      <th className="numeric">Total</th>
                      <th className="numeric">Quoted</th>
                      <th className="numeric">Reserved</th>
                      <th className="numeric">Sold</th>
                      <th className="numeric">Available</th>
                      <th className="numeric">List price</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.stockParcelId}>
                        <td>
                          <strong>{entry.parcelReference}</strong>
                        </td>
                        <td>
                          {entry.habitatType}
                          <div className="hint">{DISTINCTIVENESS_LABEL[entry.distinctiveness]}</div>
                        </td>
                        <td className="numeric">{entry.totalUnits}</td>
                        <td className="numeric">{entry.quotedUnits}</td>
                        <td className="numeric">{entry.reservedUnits}</td>
                        <td className="numeric">{entry.soldUnits}</td>
                        <td className="numeric">
                          <strong>{entry.availableUnits}</strong>
                        </td>
                        <td className="numeric">{formatMoney(entry.listPricePerUnit)}</td>
                        <td>
                          {entry.isOverExposed && <span className="badge over">over-quoted</span>}
                          {!entry.isOverExposed && entry.draftUnits !== `0.${'0'.repeat(entry.totalUnits.split('.')[1]?.length ?? 4)}` && (
                            <span className="badge muted">draft {entry.draftUnits}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })
      )}
    </>
  );
}
