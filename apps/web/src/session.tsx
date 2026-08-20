import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type AppConfig, type Me } from './api';

interface SessionValue {
  me: Me | null;
  config: AppConfig | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const identity = await api.get<Me>('/api/auth/me');
      setMe(identity);
      setConfig(await api.get<AppConfig>('/api/config'));
    } catch {
      // A 401 here simply means nobody is signed in yet.
      setMe(null);
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.post('/api/auth/logout');
    setMe(null);
    setConfig(null);
  }, []);

  const value = useMemo(
    () => ({ me, config, loading, refresh, signOut }),
    [me, config, loading, refresh, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider.');
  return value;
}
