import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DISTINCTIVENESS_LABEL,
  MODULE_LABEL,
  api,
  formatMoney,
  type BankOperator,
  type BankRollUp,
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

  const bankOperatorId = params.get('bankOperatorId') ?? '';
  const [sites, setSites] = useState<Site[]>([]);
  const [operators, setOperators] = useState<BankOperator[]>([]);
  const [pool, setPool] = useState<PoolEntry[]>([]);
  const [banks, setBanks] = useState<BankRollUp[]>([]);
  const [error, setError] = useState<unknown>(null);
  // Empty means the default: everything except cancelled.
  const [exportStatuses, setExportStatuses] = useState('');

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (siteId) query.set('siteId', siteId);
      if (bankOperatorId) query.set('bankOperatorId', bankOperatorId);
      const suffix = query.toString() ? `?${query.toString()}` : '';

      const [siteResponse, operatorResponse, poolResponse] = await Promise.all([
        api.get<{ sites: Site[] }>('/api/sites'),
        api.get<{ bankOperators: BankOperator[] }>('/api/bank-operators'),
        api.get<{ pool: PoolEntry[]; banks: BankRollUp[] }>(`/api/stock-pool${suffix}`),
      ]);
      setSites(siteResponse.sites);
      setOperators(operatorResponse.bankOperators);
      setPool(poolResponse.pool);
      setBanks(poolResponse.banks);
    } catch (caught) {
      setError(caught);
    }
  }, [siteId, bankOperatorId]);

  useEffect(() => {
    void load();
  }, [load]);

  const overExposed = pool.filter((entry) => entry.isOverExposed);

  return (
    <>
      <div className="page-header spread">
        <div>
          <h1>Stock exposure</h1>
          <p>
            A quote is soft: it marks units as exposed but does not reduce what is available. A reservation
            is firm, and does.
          </p>
        </div>
        <div className="row">
          <select
            value={exportStatuses}
            onChange={(event) => setExportStatuses(event.target.value)}
            style={{ width: 'auto' }}
            aria-label="Statuses to export"
          >
            <option value="">Live positions</option>
            <option value="quoted,reserved">Quoted and reserved only</option>
            <option value="reserved">Reserved only</option>
            <option value="sold">Sold only</option>
            <option value="draft,quoted,reserved,sold,cancelled">Everything, including cancelled</option>
          </select>
          <a
            className="button-link"
            href={`/api/positions/export?${new URLSearchParams({
              ...(bankOperatorId ? { bankOperatorId } : {}),
              ...(exportStatuses ? { statuses: exportStatuses } : {}),
            }).toString()}`}
          >
            Export positions
          </a>
        </div>
      </div>

      <ErrorBanner error={error} />

      {config?.spatialRisk.status === 'unconfirmed' && (
        <UnconfirmedNotice
          title="Spatial risk multiplier data has not been confirmed."
          detail={config.spatialRisk.source}
        />
      )}

      {banks.length > 1 && !bankOperatorId && !siteId && (
        <div className="card">
          <h2>Across your banks</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Bank</th>
                  <th className="numeric">Parcels</th>
                  <th>Standing</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {banks.map((bank) => (
                  <tr key={bank.bankOperatorId}>
                    <td>
                      <strong>{bank.bankOperatorName}</strong>
                    </td>
                    <td className="numeric">{bank.parcels}</td>
                    <td>
                      {bank.overExposed > 0 ? (
                        <span className="badge over">{bank.overExposed} over-quoted</span>
                      ) : (
                        <span className="badge">within stock</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="link"
                        onClick={() => setParams({ bankOperatorId: bank.bankOperatorId })}
                      >
                        View only this bank
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(sites.length > 0 || operators.length > 0) && (
        <div className="card" style={{ paddingTop: '0.9rem', paddingBottom: '0.9rem' }}>
          <div className="field-row">
            <Field label="Bank">
              <select
                value={bankOperatorId}
                onChange={(event) => {
                  const next = event.target.value;
                  setParams(next ? { bankOperatorId: next } : {});
                }}
              >
                <option value="">All banks</option>
                {operators.map((operator) => (
                  <option key={operator.id} value={operator.id}>
                    {operator.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Site">
              <select
                value={siteId}
                onChange={(event) => {
                  const next = event.target.value;
                  setParams(next ? { siteId: next } : {});
                }}
              >
                <option value="">All sites</option>
                {sites
                  .filter((site) => !bankOperatorId || site.bankOperatorId === bankOperatorId)
                  .map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
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
                          {banks.length > 1 && (
                            <div className="hint">
                              {entry.bankOperatorName} · {entry.siteName}
                            </div>
                          )}
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
