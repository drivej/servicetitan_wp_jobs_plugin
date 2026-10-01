import { apiFetch } from './api';
import { createContext, createElement, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

export interface WordPressPluginStatus {
  state: 'current' | 'update_required' | 'unknown';
  requiredVersion: string;
  installedVersion?: string;
  message?: string;
  seoGeneratorVersion: number;
}

interface WordPressPluginStatusContextValue {
  status: WordPressPluginStatus | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
  ready: boolean;
}

const WordPressPluginStatusContext = createContext<WordPressPluginStatusContextValue | undefined>(undefined);

export function WordPressPluginStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WordPressPluginStatus>();
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch('/api/wordpress/plugin', { headers: { Accept: 'application/json' } });
      const text = await response.text();
      if (!text.trim()) throw new Error(`The app server returned an empty response (HTTP ${response.status}).`);
      const body = JSON.parse(text) as WordPressPluginStatus | { error?: string };
      if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Unable to check the WordPress plugin.');
      setStatus(body as WordPressPluginStatus);
    } catch (error) {
      setStatus({
        state: 'unknown',
        requiredVersion: '1.18.0',
        seoGeneratorVersion: 6,
        message: error instanceof Error ? error.message : 'Unable to check the WordPress plugin.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return createElement(
    WordPressPluginStatusContext.Provider,
    { value: { status, loading, refresh, ready: status?.state === 'current' } },
    children,
  );
}

export function useWordPressPluginStatus() {
  const context = useContext(WordPressPluginStatusContext);
  if (!context) throw new Error('useWordPressPluginStatus must be used inside WordPressPluginStatusProvider.');
  return context;
}
