import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CONDITION_LABEL,
  DISTINCTIVENESS_LABEL,
  MODULE_LABEL,
  api,
  formatMoney,
  type ConditionBand,
  type DistinctivenessBand,
  type MetricModule,
  type Site,
  type StockParcel,
} from '../api';
import { Empty, ErrorBanner, Field } from '../components/common';
import { useSession } from '../session';

const MODULES: MetricModule[] = ['area', 'hedgerow', 'watercourse'];
const DISTINCTIVENESS: DistinctivenessBand[] = ['very-low', 'low', 'medium', 'high', 'very-high'];
const CONDITIONS: ConditionBand[] = ['n/a', 'poor', 'fairly-poor', 'moderate', 'fairly-good', 'good'];

export default function Stock(): ReactNode {
  const { config } = useSession();
  const [params, setParams] = useSearchParams();
  const siteId = params.get('siteId') ?? '';

  const [sites, setSites] = useState<Site[]>([]);
  const [parcels, setParcels] = useState<StockParcel[]>([]);
  const [adding, setAdding] = useState(false);
  const [module, setModule] = useState<MetricModule>('area');
  const [pricing, setPricing] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [siteResponse, parcelResponse] = await Promise.all([
        api.get<{ sites: Site[] }>('/api/sites'),
        api.get<{ stockParcels: StockParcel[] }>(
          siteId ? `/api/stock-parcels?siteId=${encodeURIComponent(siteId)}` : '/api/stock-parcels',
        ),
      ]);
      setSites(siteResponse.sites);
      setParcels(parcelResponse.stockParcels);
    } catch (caught) {
      setError(caught);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  const decimals = config?.modules.find((m) => m.id === module)?.decimalPlaces ?? 4;

  async function addParcel(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();

    try {
      await api.post('/api/stock-parcels', {
        siteId: text('siteId'),
        parcelReference: text('parcelReference'),
        module,
        broadHabitat: text('broadHabitat'),
        habitatType: text('habitatType'),
        distinctiveness: text('distinctiveness'),
        condition: text('condition'),
        // Sent as a string: a JSON number would already have been through a
        // double before the server could see it.
        totalUnits: text('totalUnits'),
        listPricePerUnit: text('listPricePerUnit') || null,
        notes: text('notes') || null,
      });
      setAdding(false);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function saveListPrice(parcelId: string, value: string): Promise<void> {
    setError(null);
    try {
      await api.put(`/api/stock-parcels/${parcelId}/list-price`, {
        listPricePerUnit: value.trim() === '' ? null : value.trim(),
      });
      setPricing(null);
      await load();
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <>
      <div className="page-header spread">
        <div>
          <h1>Stock parcels</h1>
          <p>
            Units are held at each module&rsquo;s own precision — area to four decimal places, hedgerow and
            watercourse to three.
          </p>
        </div>
        {!adding && sites.length > 0 && <button onClick={() => setAdding(true)}>Add parcel</button>}
      </div>

      <ErrorBanner error={error} />

      {sites.length === 0 && (
        <div className="banner warning">
          <strong>No sites yet.</strong>
          Stock parcels belong to a site, so create one first.
        </div>
      )}

      {sites.length > 0 && (
        <div className="card" style={{ paddingTop: '0.9rem', paddingBottom: '0.9rem' }}>
          <Field label="Showing stock for">
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

      {adding && (
        <div className="card">
          <h2>Add a stock parcel</h2>
          <p className="hint" style={{ marginTop: '-0.5rem' }}>
            Entered by hand. Importing a completed bank metric workbook will fill this in automatically once
            the parser is built against a real sample file.
          </p>

          <form onSubmit={addParcel}>
            <div className="field-row">
              <Field label="Site">
                <select name="siteId" required defaultValue={siteId || sites[0]?.id}>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Parcel reference" hint="as in the metric">
                <input name="parcelReference" required maxLength={100} />
              </Field>
              <Field label="Module">
                <select
                  name="module"
                  value={module}
                  onChange={(event) => setModule(event.target.value as MetricModule)}
                >
                  {MODULES.map((id) => (
                    <option key={id} value={id}>
                      {MODULE_LABEL[id]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="field-row">
              <Field label="Broad habitat">
                <input name="broadHabitat" required maxLength={200} />
              </Field>
              <Field label="Habitat type">
                <input name="habitatType" required maxLength={200} />
              </Field>
            </div>

            <div className="field-row">
              <Field label="Distinctiveness">
                <select name="distinctiveness" required defaultValue="medium">
                  {DISTINCTIVENESS.map((band) => (
                    <option key={band} value={band}>
                      {DISTINCTIVENESS_LABEL[band]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Condition">
                <select name="condition" defaultValue="n/a">
                  {CONDITIONS.map((band) => (
                    <option key={band} value={band}>
                      {CONDITION_LABEL[band]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Units generated" hint={`${decimals} decimal places`}>
                <input
                  name="totalUnits"
                  required
                  inputMode="decimal"
                  pattern="\d+(\.\d+)?"
                  placeholder={`0.${'0'.repeat(decimals)}`}
                />
              </Field>
              <Field label="List price per unit" hint="£, optional">
                <input name="listPricePerUnit" inputMode="decimal" pattern="\d+(\.\d{1,2})?" placeholder="25000.00" />
              </Field>
            </div>

            <Field label="Notes">
              <textarea name="notes" rows={2} />
            </Field>

            <div className="row">
              <button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Add parcel'}
              </button>
              <button type="button" className="secondary" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {parcels.length === 0 ? (
          <Empty>No stock parcels{siteId ? ' for this site' : ''} yet.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Module</th>
                  <th>Habitat</th>
                  <th>Distinctiveness</th>
                  <th>Condition</th>
                  <th className="numeric">Total units</th>
                  <th className="numeric">Retired</th>
                  <th className="numeric">List price</th>
                </tr>
              </thead>
              <tbody>
                {parcels.map((parcel) => (
                  <tr key={parcel.id}>
                    <td>
                      <strong>{parcel.parcelReference}</strong>
                    </td>
                    <td>{MODULE_LABEL[parcel.module]}</td>
                    <td>
                      {parcel.habitatType}
                      <div className="hint">{parcel.broadHabitat}</div>
                    </td>
                    <td>{DISTINCTIVENESS_LABEL[parcel.distinctiveness]}</td>
                    <td>{CONDITION_LABEL[parcel.condition]}</td>
                    <td className="numeric">{parcel.totalUnits}</td>
                    <td className="numeric">{parcel.retiredUnits}</td>
                    <td className="numeric">
                      {pricing === parcel.id ? (
                        <input
                          autoFocus
                          defaultValue={parcel.listPricePerUnit ?? ''}
                          inputMode="decimal"
                          style={{ width: '7rem', textAlign: 'right' }}
                          onBlur={(event) => void saveListPrice(parcel.id, event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') event.currentTarget.blur();
                            if (event.key === 'Escape') setPricing(null);
                          }}
                        />
                      ) : (
                        <button className="link" onClick={() => setPricing(parcel.id)}>
                          {formatMoney(parcel.listPricePerUnit)}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
