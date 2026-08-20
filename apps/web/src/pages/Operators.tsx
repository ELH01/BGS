import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, type BankOperator } from '../api';
import { Empty, ErrorBanner, Field } from '../components/common';
import { useSession } from '../session';

export default function Operators(): ReactNode {
  const { me } = useSession();
  const [operators, setOperators] = useState<BankOperator[]>([]);
  const [editing, setEditing] = useState<BankOperator | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    try {
      const { bankOperators } = await api.get<{ bankOperators: BankOperator[] }>('/api/bank-operators');
      setOperators(bankOperators);
    } catch (caught) {
      setError(caught);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = String(form.get(name) ?? '').trim();
      return value === '' ? null : value;
    };

    const payload = {
      organisationId: String(form.get('organisationId') ?? '') || undefined,
      name: String(form.get('name') ?? '').trim(),
      contactName: text('contactName'),
      contactEmail: text('contactEmail'),
      contactPhone: text('contactPhone'),
      notes: text('notes'),
      branding: {
        companyName: text('brandingCompanyName'),
        address: text('brandingAddress'),
        contact: text('brandingContact'),
        accentColour: text('brandingAccentColour'),
      },
    };

    try {
      if (editing === 'new') {
        await api.post('/api/bank-operators', payload);
      } else if (editing) {
        await api.put(`/api/bank-operators/${editing.id}`, payload);
      }
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const managed = me?.accessibleOrganisations ?? [];

  return (
    <>
      <div className="page-header spread">
        <div>
          <h1>Bank operators</h1>
          <p>
            Branding is held per operator, so a quote drawn from a client&rsquo;s stock carries their
            branding rather than yours.
          </p>
        </div>
        {!editing && <button onClick={() => setEditing('new')}>Add operator</button>}
      </div>

      <ErrorBanner error={error} />

      {editing && (
        <div className="card">
          <h2>{editing === 'new' ? 'New bank operator' : `Edit ${editing.name}`}</h2>
          <form onSubmit={save}>
            {editing === 'new' && managed.length > 1 && (
              <Field label="Belongs to" hint="you manage more than one organisation">
                <select name="organisationId" defaultValue={me?.organisation.id}>
                  {managed.map((org) => (
                    <option key={org.organisationId} value={org.organisationId}>
                      {org.name}
                      {org.access !== 'own' ? ' (managed)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field label="Operator name">
              <input name="name" required defaultValue={editing === 'new' ? '' : editing.name} maxLength={200} />
            </Field>

            <div className="field-row">
              <Field label="Contact name">
                <input name="contactName" defaultValue={editing === 'new' ? '' : editing.contactName ?? ''} />
              </Field>
              <Field label="Contact email">
                <input name="contactEmail" type="email" defaultValue={editing === 'new' ? '' : editing.contactEmail ?? ''} />
              </Field>
              <Field label="Contact phone">
                <input name="contactPhone" defaultValue={editing === 'new' ? '' : editing.contactPhone ?? ''} />
              </Field>
            </div>

            <h3 style={{ marginTop: '1.25rem' }}>Quote branding</h3>
            <p className="hint" style={{ marginTop: '-0.35rem', marginBottom: '0.75rem' }}>
              Appears on quote documents exported for this operator&rsquo;s stock.
            </p>

            <div className="field-row">
              <Field label="Company name on quotes">
                <input
                  name="brandingCompanyName"
                  defaultValue={editing === 'new' ? '' : editing.branding.companyName ?? ''}
                />
              </Field>
              <Field label="Accent colour" hint="hex, e.g. #2F5D3A">
                <input
                  name="brandingAccentColour"
                  pattern="#[0-9A-Fa-f]{6}"
                  placeholder="#2F5D3A"
                  defaultValue={editing === 'new' ? '' : editing.branding.accentColour ?? ''}
                />
              </Field>
            </div>

            <Field label="Address on quotes">
              <textarea
                name="brandingAddress"
                rows={3}
                defaultValue={editing === 'new' ? '' : editing.branding.address ?? ''}
              />
            </Field>

            <Field label="Contact details on quotes">
              <textarea
                name="brandingContact"
                rows={2}
                defaultValue={editing === 'new' ? '' : editing.branding.contact ?? ''}
              />
            </Field>

            <Field label="Notes">
              <textarea name="notes" rows={2} defaultValue={editing === 'new' ? '' : editing.notes ?? ''} />
            </Field>

            <div className="row">
              <button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {operators.length === 0 ? (
          <Empty>No bank operators yet. Add one to start recording sites and stock.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Contact</th>
                  <th>Quote branding</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {operators.map((operator) => (
                  <tr key={operator.id}>
                    <td>
                      <strong>{operator.name}</strong>
                      {operator.organisationId !== me?.organisation.id && (
                        <>
                          {' '}
                          <span className="badge muted">managed</span>
                        </>
                      )}
                    </td>
                    <td>
                      {operator.contactName ?? '—'}
                      {operator.contactEmail && (
                        <div className="hint">{operator.contactEmail}</div>
                      )}
                    </td>
                    <td>
                      {operator.branding.companyName ? (
                        <span className="row" style={{ gap: '0.4rem' }}>
                          {operator.branding.accentColour && (
                            <span
                              aria-hidden
                              style={{
                                width: 12,
                                height: 12,
                                borderRadius: 3,
                                background: operator.branding.accentColour,
                                display: 'inline-block',
                              }}
                            />
                          )}
                          {operator.branding.companyName}
                        </span>
                      ) : (
                        <span className="hint">not set</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="link" onClick={() => setEditing(operator)}>
                        Edit
                      </button>
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
