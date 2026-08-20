import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { ErrorBanner, Field } from '../components/common';
import { useSession } from '../session';

export default function SignIn(): ReactNode {
  const { refresh } = useSession();
  const [mode, setMode] = useState<'sign-in' | 'create'>('sign-in');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    const read = (name: string) => String(form.get(name) ?? '').trim();

    try {
      if (mode === 'sign-in') {
        await api.post('/api/auth/login', { email: read('email'), password: String(form.get('password')) });
      } else {
        await api.post('/api/auth/signup', {
          organisationName: read('organisationName'),
          slug: read('slug'),
          quoteReferencePrefix: read('quoteReferencePrefix') || 'Q',
          email: read('email'),
          password: String(form.get('password')),
          displayName: read('displayName'),
        });
      }
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="page-header">
          <h1>Habitat Bank Operations</h1>
          <p>{mode === 'sign-in' ? 'Sign in to your organisation.' : 'Set up a new organisation.'}</p>
        </div>

        <div className="card">
          <ErrorBanner error={error} />
          <form onSubmit={submit}>
            {mode === 'create' && (
              <>
                <Field label="Organisation name">
                  <input name="organisationName" required maxLength={200} autoComplete="organization" />
                </Field>
                <div className="field-row">
                  <Field label="Short name" hint="lower-case, used in URLs">
                    <input name="slug" required pattern="[a-z0-9][a-z0-9\-]{1,62}" placeholder="cosdon" />
                  </Field>
                  <Field label="Quote prefix" hint="e.g. CC gives CC-0001">
                    <input name="quoteReferencePrefix" defaultValue="Q" pattern="[A-Za-z][A-Za-z0-9\-]{0,11}" />
                  </Field>
                </div>
                <Field label="Your name">
                  <input name="displayName" required maxLength={200} autoComplete="name" />
                </Field>
              </>
            )}

            <Field label="Email">
              <input name="email" type="email" required autoComplete="email" />
            </Field>

            <Field label="Password" hint={mode === 'create' ? 'at least 12 characters' : undefined}>
              <input
                name="password"
                type="password"
                required
                minLength={mode === 'create' ? 12 : 1}
                autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
              />
            </Field>

            <button type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Create organisation'}
            </button>
          </form>
        </div>

        <div style={{ textAlign: 'center' }}>
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(mode === 'sign-in' ? 'create' : 'sign-in');
              setError(null);
            }}
          >
            {mode === 'sign-in' ? 'Set up a new organisation' : 'Sign in to an existing organisation'}
          </button>
        </div>
      </div>
    </div>
  );
}
