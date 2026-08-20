import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  MODULE_LABEL,
  QUOTE_STATUS_LABEL,
  api,
  formatMoney,
  type AllocationSolution,
  type AuditRecord,
  type Developer,
  type MetricModule,
  type DocumentPreview,
  type Quote,
  type SaleRecord,
  downloadFile,
} from '../api';
import { AllocationTable, type AllocationRowState } from '../components/AllocationTable';
import { ErrorBanner, Field } from '../components/common';

type RowsByModule = Partial<Record<MetricModule, Record<string, AllocationRowState>>>;

export default function QuoteDetail(): ReactNode {
  const { id = '' } = useParams();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [sale, setSale] = useState<SaleRecord | null>(null);
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [developer, setDeveloper] = useState<Developer | null>(null);
  const [solutions, setSolutions] = useState<Partial<Record<MetricModule, AllocationSolution>>>({});
  const [rows, setRows] = useState<RowsByModule>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.get<{ quote: Quote; sale: SaleRecord | null; audit: AuditRecord[] }>(
        `/api/quotes/${id}`,
      );
      setQuote(response.quote);
      setSale(response.sale);
      setAudit(response.audit);

      const { developer: purchaser } = await api.get<{ developer: Developer }>(
        `/api/developers/${response.quote.developerId}`,
      );
      setDeveloper(purchaser);

      // Seed the table from whatever is already saved against the quote.
      const seeded: RowsByModule = {};
      for (const line of response.quote.lines) {
        seeded[line.module] = {
          ...(seeded[line.module] ?? {}),
          [line.stockParcelId]: { rawQuantity: line.rawQuantity, unitPrice: line.unitPrice },
        };
      }
      setRows(seeded);

      // Ask the solver for the eligible options per module. The habitat lost
      // is sent when the quote records it; when it does not, the solver returns
      // everything and the table says the rules were not applied.
      const solved: Partial<Record<MetricModule, AllocationSolution>> = {};
      for (const target of response.quote.targets) {
        solved[target.module] = await api.post<AllocationSolution>('/api/allocation-options', {
          module: target.module,
          requiredUnits: target.requiredUnits,
          developerId: response.quote.developerId,
          shortfall:
            target.shortfallBroadHabitat && target.shortfallHabitatType && target.shortfallDistinctiveness
              ? {
                  broadHabitat: target.shortfallBroadHabitat,
                  habitatType: target.shortfallHabitatType,
                  distinctiveness: target.shortfallDistinctiveness,
                }
              : null,
        });
      }
      setSolutions(solved);

      // What the exported document would say, so its warnings appear before
      // someone sends the file rather than after.
      try {
        setPreview(await api.get<DocumentPreview>(`/api/quotes/${id}/document-preview`));
      } catch {
        setPreview(null);
      }
    } catch (caught) {
      setError(caught);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!quote) {
    return (
      <>
        <ErrorBanner error={error} />
        {!error && <p className="hint">Loading…</p>}
      </>
    );
  }

  const editable = quote.status === 'draft' || quote.status === 'quoted' || quote.status === 'reserved';

  function currentLines() {
    const lines: Array<{
      stockParcelId: string;
      module: MetricModule;
      rawQuantity: string;
      spatialBand: string;
      unitPrice: string;
      tradingRuleJustification: string | null;
    }> = [];

    for (const [module, byParcel] of Object.entries(rows) as Array<
      [MetricModule, Record<string, AllocationRowState>]
    >) {
      const solution = solutions[module];
      if (!solution) continue;

      for (const [parcelId, state] of Object.entries(byParcel)) {
        const quantity = state.rawQuantity.trim();
        if (quantity === '' || Number(quantity) <= 0) continue;

        const option = solution.options.find((o) => o.stockParcelId === parcelId);
        if (!option) continue;

        lines.push({
          stockParcelId: parcelId,
          module,
          rawQuantity: quantity,
          spatialBand: option.spatialBand,
          unitPrice: state.unitPrice.trim() || option.listPricePerUnit || '0',
          tradingRuleJustification: option.tradingRuleJustification,
        });
      }
    }
    return lines;
  }

  async function saveAllocation(): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await api.put(`/api/quotes/${quote!.id}/allocation`, { lines: currentLines() });
      setNotice('Allocation saved.');
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function transition(status: string, extra: Record<string, unknown> = {}): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await api.post(`/api/quotes/${quote!.id}/status`, { status, ...extra });
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function issue(): Promise<void> {
    // Save first, so what is judged against the target is what is on screen.
    setBusy(true);
    try {
      await api.put(`/api/quotes/${quote!.id}/allocation`, { lines: currentLines() });
    } catch (caught) {
      setError(caught);
      setBusy(false);
      return;
    }
    setBusy(false);
    await transition('quoted');
  }

  async function downloadDocument(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await downloadFile(`/api/quotes/${quote!.id}/document`, `Quote-${quote!.reference}.docx`);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    const reason = window.prompt('Why is this quote being cancelled?');
    if (!reason) return;
    await transition('cancelled', { reason });
  }

  async function sell(): Promise<void> {
    const planningApplicationReference = window.prompt('Planning application reference (optional):') ?? '';
    const soldDate = window.prompt('Date of sale (YYYY-MM-DD):', new Date().toISOString().slice(0, 10));
    if (!soldDate) return;
    await transition('sold', { soldDate, planningApplicationReference });
  }

  async function reverse(): Promise<void> {
    const reason = window.prompt('Why is this sale being reversed? (required)');
    if (!reason) return;
    const moveTo = window.confirm('OK to move back to Reserved, Cancel to cancel the quote.')
      ? 'reserved'
      : 'cancelled';

    setBusy(true);
    try {
      await api.post(`/api/quotes/${quote!.id}/reverse-sale`, { reason, moveTo });
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-header spread">
        <div>
          <h1>
            {quote.reference} <span className="badge">{QUOTE_STATUS_LABEL[quote.status]}</span>
            {quote.isStale && <span className="badge over"> stale</span>}
          </h1>
          <p>
            {developer?.purchasingEntityName ?? '—'} · {formatMoney(quote.totalPrice)} ·{' '}
            <Link to="/quotes">back to quotes</Link>
          </p>
        </div>
      </div>

      <ErrorBanner error={error} />
      {notice && <div className="banner" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)', color: 'var(--accent)' }}>{notice}</div>}

      {quote.status === 'cancelled' && (
        <div className="banner warning">
          <strong>This quote was cancelled.</strong>
          {quote.cancellationReason} Cancelled quotes are kept rather than deleted, so the conversion
          history stays intact.
        </div>
      )}

      {quote.status === 'sold' && sale && (
        <div className="banner" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)', color: 'var(--accent)' }}>
          <strong>Sold on {new Date(sale.soldDate).toLocaleDateString('en-GB')}.</strong>
          {sale.planningApplicationReference
            ? `Planning reference ${sale.planningApplicationReference}.`
            : 'No planning reference recorded.'}{' '}
          {sale.bgsRegisterSubmissionDate
            ? `Registered ${new Date(sale.bgsRegisterSubmissionDate).toLocaleDateString('en-GB')}.`
            : 'Register submission date not yet recorded.'}
        </div>
      )}

      {quote.targets.map((target) => {
        const solution = solutions[target.module];
        if (!solution) {
          return (
            <div className="card" key={target.module}>
              <h2>{MODULE_LABEL[target.module]}</h2>
              <p className="hint">Loading eligible stock…</p>
            </div>
          );
        }
        return (
          <AllocationTable
            key={target.module}
            solution={solution}
            rows={rows[target.module] ?? {}}
            disabled={!editable || busy}
            onChange={(next) => setRows((current) => ({ ...current, [target.module]: next }))}
          />
        );
      })}

      <div className="card">
        <h2>Actions</h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {editable && (
            <button onClick={() => void saveAllocation()} disabled={busy} className="secondary">
              Save allocation
            </button>
          )}
          {quote.status === 'draft' && (
            <button onClick={() => void issue()} disabled={busy}>
              Issue quote
            </button>
          )}
          {quote.status === 'quoted' && (
            <button onClick={() => void transition('reserved')} disabled={busy}>
              Reserve
            </button>
          )}
          {quote.status === 'reserved' && (
            <button onClick={() => void sell()} disabled={busy}>
              Mark as sold
            </button>
          )}
          {quote.status === 'sold' && (
            <button onClick={() => void reverse()} disabled={busy} className="secondary">
              Reverse sale
            </button>
          )}
          {(quote.status === 'draft' || quote.status === 'quoted' || quote.status === 'reserved') && (
            <button onClick={() => void cancel()} disabled={busy} className="secondary">
              Cancel quote
            </button>
          )}
          {quote.lines.length > 0 && (
            <button onClick={() => void downloadDocument()} disabled={busy} className="secondary">
              Download quote document
            </button>
          )}
        </div>

        {preview && preview.warnings.length > 0 && (
          <div className="banner warning" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
            <strong>Before sending the quote document</strong>
            <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        {preview?.brandingOperator && preview.warnings.length === 0 && (
          <p className="hint" style={{ marginTop: '0.75rem' }}>
            The document will be branded as {preview.brandingOperator.name}.
          </p>
        )}
        {quote.status === 'draft' && (
          <p className="hint" style={{ marginTop: '0.75rem' }}>
            An allocation can be saved below target and picked up later. Issuing the quote is what requires
            every module to clear its figure.
          </p>
        )}
      </div>

      {quote.status === 'sold' && (
        <div className="card">
          <h2>Register submission</h2>
          <Field label="Biodiversity Gain Site Register submission date" hint="filled in once known">
            <input
              type="date"
              defaultValue={sale?.bgsRegisterSubmissionDate?.slice(0, 10) ?? ''}
              onBlur={async (event) => {
                if (!event.target.value) return;
                await api.patch(`/api/quotes/${quote.id}`, {
                  bgsRegisterSubmissionDate: event.target.value,
                });
                await load();
              }}
            />
          </Field>
        </div>
      )}

      <div className="card">
        <h2>History</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.createdAt).toLocaleString('en-GB')}</td>
                  <td>
                    {entry.action.replace(/-/g, ' ')}
                    {entry.fromStatus && entry.toStatus && (
                      <div className="hint">
                        {entry.fromStatus} → {entry.toStatus}
                      </div>
                    )}
                  </td>
                  <td>{entry.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
