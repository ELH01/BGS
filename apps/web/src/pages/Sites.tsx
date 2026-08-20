import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type BankOperator, type Site } from '../api';
import { Empty, ErrorBanner, Field } from '../components/common';
import { useSession } from '../session';

export default function Sites(): ReactNode {
  const { me } = useSession();
  const [sites, setSites] = useState<Site[]>([]);
  const [operators, setOperators] = useState<BankOperator[]>([]);
  const [editing, setEditing] = useState<Site | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    try {
      const [siteResponse, operatorResponse] = await Promise.all([
        api.get<{ sites: Site[] }>('/api/sites'),
        api.get<{ bankOperators: BankOperator[] }>('/api/bank-operators'),
      ]);
      setSites(siteResponse.sites);
      setOperators(operatorResponse.bankOperators);
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

    const bankOperatorId = String(form.get('bankOperatorId') ?? '');
    const owner = operators.find((o) => o.id === bankOperatorId);

    const payload = {
      // A site belongs to whichever organisation owns its operator, so the two
      // can never end up filed under different tenants.
      organisationId: owner?.organisationId,
      bankOperatorId,
      name: String(form.get('name') ?? '').trim(),
      location: text('location'),
      lpaCode: text('lpaCode'),
      lpaName: text('lpaName'),
      ncaCode: text('ncaCode'),
      ncaName: text('ncaName'),
      lnrsAreaCode: text('lnrsAreaCode'),
      lnrsAreaName: text('lnrsAreaName'),
      bgsRegisterReference: text('bgsRegisterReference'),
      notes: text('notes'),
    };

    try {
      if (editing === 'new') {
        await api.post('/api/sites', payload);
      } else if (editing) {
        await api.put(`/api/sites/${editing.id}`, payload);
      }
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const value = (site: Site | 'new', key: keyof Site): string =>
    site === 'new' ? '' : (site[key] as string | null) ?? '';

  return (
    <>
      <div className="page-header spread">
        <div>
          <h1>Habitat bank sites</h1>
          <p>An operator can hold several sites; stock parcels belong to a site.</p>
        </div>
        {!editing && operators.length > 0 && <button onClick={() => setEditing('new')}>Add site</button>}
      </div>

      <ErrorBanner error={error} />

      {operators.length === 0 && (
        <div className="banner warning">
          <strong>No bank operators yet.</strong>
          A site belongs to an operator, so <Link to="/operators">add an operator</Link> first.
        </div>
      )}

      {editing && (
        <div className="card">
          <h2>{editing === 'new' ? 'New site' : `Edit ${editing.name}`}</h2>
          <form onSubmit={save}>
            <div className="field-row">
              <Field label="Bank operator">
                <select
                  name="bankOperatorId"
                  required
                  defaultValue={editing === 'new' ? operators[0]?.id : editing.bankOperatorId}
                >
                  {operators.map((operator) => (
                    <option key={operator.id} value={operator.id}>
                      {operator.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Site name">
                <input name="name" required maxLength={200} defaultValue={value(editing, 'name')} />
              </Field>
            </div>

            <Field label="Location">
              <input name="location" defaultValue={value(editing, 'location')} />
            </Field>

            <div className="field-row">
              <Field label="LPA code" hint="used for spatial risk">
                <input name="lpaCode" defaultValue={value(editing, 'lpaCode')} />
              </Field>
              <Field label="LPA name">
                <input name="lpaName" defaultValue={value(editing, 'lpaName')} />
              </Field>
              <Field label="NCA code">
                <input name="ncaCode" defaultValue={value(editing, 'ncaCode')} />
              </Field>
              <Field label="NCA name">
                <input name="ncaName" defaultValue={value(editing, 'ncaName')} />
              </Field>
            </div>

            <div className="field-row">
              <Field label="LNRS area code" hint="held ready; not yet in use">
                <input name="lnrsAreaCode" defaultValue={value(editing, 'lnrsAreaCode')} />
              </Field>
              <Field label="LNRS area name">
                <input name="lnrsAreaName" defaultValue={value(editing, 'lnrsAreaName')} />
              </Field>
              <Field label="BGS register reference">
                <input name="bgsRegisterReference" defaultValue={value(editing, 'bgsRegisterReference')} />
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
        {sites.length === 0 ? (
          <Empty>No sites yet.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Site</th>
                  <th>Operator</th>
                  <th>LPA / NCA</th>
                  <th>BGS reference</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <tr key={site.id}>
                    <td>
                      <Link to={`/stock?siteId=${site.id}`}>
                        <strong>{site.name}</strong>
                      </Link>
                      {site.location && <div className="hint">{site.location}</div>}
                      {site.organisationId !== me?.organisation.id && (
                        <span className="badge muted">managed</span>
                      )}
                    </td>
                    <td>{operators.find((o) => o.id === site.bankOperatorId)?.name ?? '—'}</td>
                    <td>
                      {site.lpaName ?? site.lpaCode ?? '—'}
                      <div className="hint">{site.ncaName ?? site.ncaCode ?? ''}</div>
                    </td>
                    <td>{site.bgsRegisterReference ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="link" onClick={() => setEditing(site)}>
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
