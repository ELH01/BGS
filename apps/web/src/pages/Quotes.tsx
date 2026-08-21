import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  DISTINCTIVENESS_LABEL,
  MODULE_LABEL,
  QUOTE_STATUS_LABEL,
  api,
  formatMoney,
  type BankOperator,
  type Developer,
  type DistinctivenessBand,
  type MetricModule,
  type Quote,
  type QuoteSummary,
} from '../api';
import { Empty, ErrorBanner, Field } from '../components/common';

const MODULES: MetricModule[] = ['area', 'hedgerow', 'watercourse'];
const DISTINCTIVENESS: DistinctivenessBand[] = ['very-low', 'low', 'medium', 'high', 'very-high'];

function statusBadge(quote: QuoteSummary): ReactNode {
  const className =
    quote.status === 'cancelled' ? 'badge muted' : quote.status === 'sold' ? 'badge' : 'badge';
  return <span className={className}>{QUOTE_STATUS_LABEL[quote.status]}</span>;
}

export default function Quotes(): ReactNode {
  const navigate = useNavigate();
  const [quotes, setQuotes] = useState<QuoteSummary[]>([]);
  const [developers, setDevelopers] = useState<Developer[]>([]);
  const [operators, setOperators] = useState<BankOperator[]>([]);
  const [staleAfterDays, setStaleAfterDays] = useState(60);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    try {
      const [quoteResponse, developerResponse, operatorResponse] = await Promise.all([
        api.get<{ quotes: QuoteSummary[]; staleAfterDays: number }>('/api/quotes'),
        api.get<{ developers: Developer[] }>('/api/developers'),
        api.get<{ bankOperators: BankOperator[] }>('/api/bank-operators'),
      ]);
      setQuotes(quoteResponse.quotes);
      setStaleAfterDays(quoteResponse.staleAfterDays);
      setDevelopers(developerResponse.developers);
      setOperators(operatorResponse.bankOperators);
    } catch (caught) {
      setError(caught);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /**
   * The manual entry path (§4.4): units required per module, typed directly,
   * with no metric import behind them. Trading-rule filtering and multipliers
   * still run, so the table only ever offers genuinely eligible stock.
   */
  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    const targets = MODULES.map((module) => {
      const broadHabitat = String(form.get(`broad-${module}`) ?? '').trim();
      const habitatType = String(form.get(`type-${module}`) ?? '').trim();
      const distinctiveness = String(form.get(`dist-${module}`) ?? '').trim();

      return {
        module,
        source: 'manual' as const,
        requiredUnits: String(form.get(`required-${module}`) ?? '').trim(),
        // Sent only when described fully. A partial description would filter
        // on incomplete information while looking authoritative.
        shortfall:
          broadHabitat && habitatType && distinctiveness
            ? { broadHabitat, habitatType, distinctiveness }
            : null,
      };
    }).filter((target) => target.requiredUnits !== '' && Number(target.requiredUnits) > 0);

    if (targets.length === 0) {
      setError(new Error('Enter the units required for at least one module.'));
      setBusy(false);
      return;
    }

    try {
      const { quote } = await api.post<{ quote: Quote }>('/api/quotes', {
        developerId: String(form.get('developerId')),
        bankOperatorId: String(form.get('bankOperatorId')),
        priority: String(form.get('priority') || 'medium'),
        targets,
      });
      navigate(`/quotes/${quote.id}`);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-header spread">
        <div>
          <h1>Quotes</h1>
          <p>A quote is soft until reserved. Nothing leaves draft until every module clears its target.</p>
        </div>
        {!creating && developers.length > 0 && operators.length > 0 && (
          <button onClick={() => setCreating(true)}>New quote</button>
        )}
      </div>

      <ErrorBanner error={error} />

      {developers.length === 0 && (
        <div className="banner warning">
          <strong>No developers yet.</strong>
          A quote is addressed to a purchaser, so <Link to="/developers">add a developer</Link> first.
        </div>
      )}

      {operators.length === 0 && (
        <div className="banner warning">
          <strong>No bank operators yet.</strong>
          A quote supplies one operator&rsquo;s stock and carries their branding, so{' '}
          <Link to="/operators">add an operator</Link> first.
        </div>
      )}

      {creating && (
        <div className="card">
          <h2>New quote</h2>
          <p className="hint" style={{ marginTop: '-0.5rem' }}>
            A quote supplies one bank&rsquo;s stock — across as many of its sites as you like — and goes out
            under that operator&rsquo;s branding. Enter the units required per module; leave a module blank if
            the development has no shortfall there, since the three are separate problems and never combine.
          </p>

          <form onSubmit={create}>
            <div className="field-row">
              <Field
                label="Supplying bank"
                hint="whose stock, and whose branding on the document"
              >
                <select name="bankOperatorId" required defaultValue={operators[0]?.id}>
                  {operators.map((operator) => (
                    <option key={operator.id} value={operator.id}>
                      {operator.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Purchaser">
                <select name="developerId" required defaultValue={developers[0]?.id}>
                  {developers.map((developer) => (
                    <option key={developer.id} value={developer.id}>
                      {developer.purchasingEntityName}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Priority">
                <select name="priority" defaultValue="medium">
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </Field>
            </div>

            {MODULES.map((module) => (
              <div key={module} style={{ marginBottom: '0.5rem' }}>
                <div className="field-row">
                  <Field label={`${MODULE_LABEL[module]} units required`} hint="leave blank if none">
                    <input
                      name={`required-${module}`}
                      inputMode="decimal"
                      pattern="\d+(\.\d+)?"
                      placeholder="0"
                    />
                  </Field>
                  <Field label="Habitat lost — broad" hint="optional">
                    <input name={`broad-${module}`} placeholder="Grassland" />
                  </Field>
                  <Field label="Habitat lost — type" hint="optional">
                    <input name={`type-${module}`} placeholder="Other neutral grassland" />
                  </Field>
                  <Field label="Distinctiveness" hint="optional">
                    <select name={`dist-${module}`} defaultValue="">
                      <option value="">Not known</option>
                      {DISTINCTIVENESS.map((band) => (
                        <option key={band} value={band}>
                          {DISTINCTIVENESS_LABEL[band]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </div>
            ))}

            <p className="hint" style={{ marginTop: '-0.35rem' }}>
              Describing the habitat lost lets the trading rules filter the stock on offer. Leave it blank
              and every parcel in the module is shown instead, marked as unfiltered.
            </p>

            <div className="row">
              <button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create and build allocation'}
              </button>
              <button type="button" className="secondary" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {quotes.length === 0 ? (
          <Empty>No quotes yet.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Purchaser</th>
                  <th>Supplying bank</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th className="numeric">Lines</th>
                  <th className="numeric">Total</th>
                  <th>Last updated</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((quote) => (
                  <tr key={quote.id}>
                    <td>
                      <Link to={`/quotes/${quote.id}`}>
                        <strong>{quote.reference}</strong>
                      </Link>
                    </td>
                    <td>{quote.developerName}</td>
                    <td>{quote.bankOperatorName ?? <span className="hint">not set</span>}</td>
                    <td>{statusBadge(quote)}</td>
                    <td>{quote.priority}</td>
                    <td className="numeric">{quote.lineCount}</td>
                    <td className="numeric">{formatMoney(quote.totalPrice)}</td>
                    <td>
                      {new Date(quote.lastActivityAt).toLocaleDateString('en-GB')}
                      {quote.isStale && (
                        <>
                          {' '}
                          <span className="badge over" title={`No update in over ${staleAfterDays} days`}>
                            stale
                          </span>
                        </>
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
