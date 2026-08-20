import type { ReactNode } from 'react';
import type { ApiError } from '../api';

export function ErrorBanner({ error }: { error: unknown }): ReactNode {
  if (!error) return null;
  const apiError = error as ApiError;

  return (
    <div className="banner error" role="alert">
      <strong>{apiError.message ?? 'Something went wrong.'}</strong>
      {apiError.issues && (
        <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
          {apiError.issues.map((issue) => (
            <li key={`${issue.field}-${issue.message}`}>
              {issue.field ? `${issue.field}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Marks figures derived from reference data that has not yet been confirmed
 * against an authoritative source (§5.3–§5.5).
 *
 * Shown wherever those figures appear rather than once at setup: someone
 * reading a spatial multiplier six months from now needs to know it is a
 * placeholder at the moment they read it.
 */
export function UnconfirmedNotice({
  title,
  detail,
}: {
  title: string;
  detail?: string | undefined;
}): ReactNode {
  return (
    <div className="banner warning">
      <strong>{title}</strong>
      {detail ?? 'These are placeholder values, included so the platform can be built and tested. Confirm them against a current authoritative source before producing a real quote.'}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="empty">{children}</div>;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="field">
      <label>
        {label} {hint && <span className="hint">{hint}</span>}
      </label>
      {children}
    </div>
  );
}
