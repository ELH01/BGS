import type { ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import Backup from './pages/Backup';
import Developers from './pages/Developers';
import Exposure from './pages/Exposure';
import QuoteDetail from './pages/QuoteDetail';
import Quotes from './pages/Quotes';
import Operators from './pages/Operators';
import Settings from './pages/Settings';
import SignIn from './pages/SignIn';
import Sites from './pages/Sites';
import Stock from './pages/Stock';
import { useSession } from './session';

export default function App(): ReactNode {
  const { me, config, loading, signOut } = useSession();

  if (loading) {
    return (
      <div className="auth-shell">
        <p className="hint">Loading…</p>
      </div>
    );
  }

  if (!me) return <SignIn />;

  const unconfirmed =
    config &&
    (config.spatialRisk.status === 'unconfirmed' ||
      config.tradingRules.status === 'unconfirmed' ||
      !config.netGain.bufferConfirmed);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <strong>{me.organisation.name}</strong>
          <span>Habitat bank operations</span>
        </div>

        <nav>
          <NavLink to="/exposure">Exposure</NavLink>
          <NavLink to="/quotes">Quotes</NavLink>
          <NavLink to="/developers">Developers</NavLink>
          <NavLink to="/stock">Stock parcels</NavLink>
          <NavLink to="/sites">Sites</NavLink>
          <NavLink to="/operators">Bank operators</NavLink>
          <NavLink to="/backup">Backup</NavLink>
          <NavLink to="/settings">
            Configuration {unconfirmed && <span className="badge over">!</span>}
          </NavLink>
        </nav>

        <div className="footer">
          <div>{me.user.displayName}</div>
          <button className="link" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/exposure" replace />} />
          <Route path="/exposure" element={<Exposure />} />
          <Route path="/quotes" element={<Quotes />} />
          <Route path="/quotes/:id" element={<QuoteDetail />} />
          <Route path="/developers" element={<Developers />} />
          <Route path="/stock" element={<Stock />} />
          <Route path="/sites" element={<Sites />} />
          <Route path="/operators" element={<Operators />} />
          <Route path="/backup" element={<Backup />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/exposure" replace />} />
        </Routes>
      </main>
    </div>
  );
}
