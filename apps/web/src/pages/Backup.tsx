import { useEffect, useState, type ReactNode } from 'react';
import { api, downloadFile } from '../api';
import { ErrorBanner } from '../components/common';

interface BackupStatus {
  organisationExport: { available: boolean; description: string };
  databaseBackup: {
    available: boolean;
    allowed: boolean;
    toolsAvailable: boolean;
    description: string;
    problem?: string;
  };
  restore: { viaHttp: false; instructions: string };
}

/**
 * Backup and restore (§4.8).
 *
 * Given its own place in the sidebar rather than tucked inside settings: it is
 * the thing that protects everything else, and it is no use if nobody can find
 * it.
 */
export default function Backup(): ReactNode {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setStatus(await api.get<BackupStatus>('/api/backup/status'));
      } catch (caught) {
        setError(caught);
      }
    })();
  }, []);

  async function download(kind: 'organisation' | 'database', fallback: string): Promise<void> {
    setError(null);
    setBusy(kind);
    try {
      await downloadFile(`/api/backup/${kind}`, fallback);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Backup</h1>
        <p>Take a copy now. Restoring is done from the command line, for the reason below.</p>
      </div>

      <ErrorBanner error={error} />

      {!status ? (
        <p className="hint">Loading…</p>
      ) : (
        <>
          <div className="card">
            <div className="spread">
              <div>
                <h2>Your organisation&rsquo;s data</h2>
                <p className="hint" style={{ marginTop: '-0.4rem' }}>
                  {status.organisationExport.description}
                </p>
              </div>
              <button
                onClick={() => void download('organisation', 'organisation-export.json')}
                disabled={busy !== null}
              >
                {busy === 'organisation' ? 'Preparing…' : 'Export my data'}
              </button>
            </div>
            <p className="hint">
              Figures are written as text rather than as JSON numbers, so unit quantities come back at exactly
              the precision they were stored at.
            </p>
          </div>

          <div className="card">
            <div className="spread">
              <div>
                <h2>Whole instance</h2>
                <p className="hint" style={{ marginTop: '-0.4rem' }}>
                  {status.databaseBackup.description}
                </p>
              </div>
              {status.databaseBackup.allowed && (
                <button
                  onClick={() => void download('database', 'bgs-backup.dump')}
                  disabled={busy !== null || !status.databaseBackup.available}
                >
                  {busy === 'database' ? 'Preparing…' : 'Download backup'}
                </button>
              )}
            </div>

            {status.databaseBackup.problem && (
              <div className="banner warning" style={{ marginBottom: 0 }}>
                <strong>Not available on this instance.</strong>
                {status.databaseBackup.problem}
              </div>
            )}
          </div>

          <div className="card">
            <h2>Restoring</h2>
            <p>{status.restore.instructions}</p>
            <pre
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '0.75rem',
                overflowX: 'auto',
                fontSize: '0.85rem',
              }}
            >
              pnpm db:restore &lt;backup-file&gt;
            </pre>
            <p className="hint">
              Kept off the web interface deliberately: replacing the entire database is not something that
              should be one mis-click away in a browser session.
            </p>
          </div>
        </>
      )}
    </>
  );
}
