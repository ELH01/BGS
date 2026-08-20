import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, type Developer } from '../api';
import { Empty, ErrorBanner, Field } from '../components/common';

export default function Developers(): ReactNode {
  const [developers, setDevelopers] = useState<Developer[]>([]);
  const [editing, setEditing] = useState<Developer | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    try {
      const { developers: list } = await api.get<{ developers: Developer[] }>('/api/developers');
      setDevelopers(list);
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
      purchasingEntityName: String(form.get('purchasingEntityName') ?? '').trim(),
      billingAddress: text('billingAddress'),
      developmentSiteName: text('developmentSiteName'),
      developmentSiteAddress: text('developmentSiteAddress'),
      developmentLpaCode: text('developmentLpaCode'),
      developmentLpaName: text('developmentLpaName'),
      developmentNcaCode: text('developmentNcaCode'),
      developmentNcaName: text('developmentNcaName'),
      contactName: text('contactName'),
      contactEmail: text('contactEmail'),
      contactPhone: text('contactPhone'),
      notes: text('notes'),
    };

    try {
      if (editing === 'new') await api.post('/api/developers', payload);
      else if (editing) await api.put(`/api/developers/${editing.id}`, payload);
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const value = (developer: Developer | 'new', key: keyof Developer): string =>
    developer === 'new' ? '' : ((developer[key] as string | null) ?? '');

  return (
    <>
      <div className="page-header spread">
        <div>
          <h1>Developers</h1>
          <p>
            The purchasing entity and the development site are kept apart: quotes are addressed to the
            billing address, while the spatial multiplier is worked out from where the development is.
          </p>
        </div>
        {!editing && <button onClick={() => setEditing('new')}>Add developer</button>}
      </div>

      <ErrorBanner error={error} />

      {editing && (
        <div className="card">
          <h2>{editing === 'new' ? 'New developer' : `Edit ${editing.purchasingEntityName}`}</h2>
          <form onSubmit={save}>
            <Field label="Purchasing entity" hint="appears on the quote as the purchaser">
              <input
                name="purchasingEntityName"
                required
                maxLength={200}
                defaultValue={value(editing, 'purchasingEntityName')}
              />
            </Field>

            <Field label="Billing address" hint="may differ from the development site">
              <textarea name="billingAddress" rows={3} defaultValue={value(editing, 'billingAddress')} />
            </Field>

            <h3 style={{ marginTop: '1.25rem' }}>Development site</h3>
            <p className="hint" style={{ marginTop: '-0.35rem', marginBottom: '0.75rem' }}>
              Where the development actually is. Used for the spatial risk multiplier, not for the quote
              address.
            </p>

            <div className="field-row">
              <Field label="Site name">
                <input name="developmentSiteName" defaultValue={value(editing, 'developmentSiteName')} />
              </Field>
              <Field label="LPA code">
                <input name="developmentLpaCode" defaultValue={value(editing, 'developmentLpaCode')} />
              </Field>
              <Field label="LPA name">
                <input name="developmentLpaName" defaultValue={value(editing, 'developmentLpaName')} />
              </Field>
              <Field label="NCA code">
                <input name="developmentNcaCode" defaultValue={value(editing, 'developmentNcaCode')} />
              </Field>
            </div>

            <Field label="Site address">
              <textarea
                name="developmentSiteAddress"
                rows={2}
                defaultValue={value(editing, 'developmentSiteAddress')}
              />
            </Field>

            <div className="field-row">
              <Field label="Contact name">
                <input name="contactName" defaultValue={value(editing, 'contactName')} />
              </Field>
              <Field label="Contact email">
                <input name="contactEmail" type="email" defaultValue={value(editing, 'contactEmail')} />
              </Field>
              <Field label="Contact phone">
                <input name="contactPhone" defaultValue={value(editing, 'contactPhone')} />
              </Field>
            </div>

            <Field label="Notes">
              <textarea name="notes" rows={2} defaultValue={value(editing, 'notes')} />
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
        {developers.length === 0 ? (
          <Empty>No developers yet. Add one before creating a quote.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Purchasing entity</th>
                  <th>Development site</th>
                  <th>LPA / NCA</th>
                  <th>Contact</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {developers.map((developer) => (
                  <tr key={developer.id}>
                    <td>
                      <strong>{developer.purchasingEntityName}</strong>
                    </td>
                    <td>
                      {developer.developmentSiteName ?? '—'}
                      {developer.developmentSiteAddress && (
                        <div className="hint">{developer.developmentSiteAddress}</div>
                      )}
                    </td>
                    <td>
                      {developer.developmentLpaName ?? developer.developmentLpaCode ?? (
                        <span className="badge over">not set</span>
                      )}
                      <div className="hint">{developer.developmentNcaName ?? developer.developmentNcaCode ?? ''}</div>
                    </td>
                    <td>
                      {developer.contactName ?? '—'}
                      {developer.contactEmail && <div className="hint">{developer.contactEmail}</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="link" onClick={() => setEditing(developer)}>
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
