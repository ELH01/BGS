import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, type BankOperator } from '../api';
import { Empty, ErrorBanner, Field } from '../components/common';
import { useSession } from '../session';

export default function Operators(): ReactNode {
  const { me } = useSession();
  const [operators, setOperators] = useState<BankOperator[]>([]);
  const [editing, setEditing] = useState<BankOperator | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  // Bumped after an upload so the browser refetches rather than showing the
  // cached previous logo.
  const [logoVersion, setLogoVersion] = useState(0);

  async function uploadLogo(operatorId: string, file: File): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch(`/api/bank-operators/${operatorId}/logo`, {
        method: 'POST',
        credentials: 'same-origin',
        body,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? 'The logo could not be uploaded.');
      }
      setLogoVersion((version) => version + 1);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function removeLogo(operatorId: string): Promise<void> {
    setError(null);
    try {
      await api.delete(`/api/bank-operators/${operatorId}/logo`);
      setLogoVersion((version) => version + 1);
      await load();
    } catch (caught) {
      setError(caught);
    }
  }

  async function load(): Promise<void> {
    try {
      const { bankOperators } = await api.get<{ bankOperators: BankOperator[] }>('/api/bank-operators');
      setOperators(bankOperators);

      // Keep an open editor in step with what was just saved. Without this the
      // form goes on showing the operator as it was when it was opened, so an
      // uploaded logo appears not to have arrived.
      setEditing((current) =>
        current && current !== 'new'
          ? bankOperators.find((operator) => operator.id === current.id) ?? current
          : current,
      );
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

            {editing !== 'new' && (
              <Field label="Logo" hint="appears at the top of this operator’s quote documents">
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  {editing.branding.logoFileId ? (
                    <img
                      src={`/api/bank-operators/${editing.id}/logo?v=${logoVersion}`}
                      alt={`${editing.name} logo`}
                      style={{
                        maxHeight: 64,
                        maxWidth: 200,
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius)',
                        padding: 4,
                        background: '#fff',
                      }}
                    />
                  ) : (
                    <span className="hint">No logo uploaded — the document will be text only.</span>
                  )}
                  <input
                    ref={logoInput}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/bmp"
                    style={{ width: 'auto' }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadLogo(editing.id, file);
                      event.target.value = '';
                    }}
                  />
                  {editing.branding.logoFileId && (
                    <button type="button" className="link" onClick={() => void removeLogo(editing.id)}>
                      Remove
                    </button>
                  )}
                </div>
              </Field>
            )}

            {editing === 'new' && (
              <p className="hint">Save the operator first, then reopen it to upload a logo.</p>
            )}

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
