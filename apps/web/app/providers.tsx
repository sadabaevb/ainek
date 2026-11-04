'use client';
// Client-side context: NearProvider (near-connect-hooks owns one NearConnector; wallets load from a public
// manifest into sandboxed iframes, testnet only), the public config read on the server, and the UI language.
import { NearProvider } from 'near-connect-hooks';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { PublicConfig } from '@/lib/config';
import { dict, type Dict, type Lang } from '@/lib/i18n';

const ConfigContext = createContext<PublicConfig | null>(null);
const LangContext = createContext<{ lang: Lang; t: Dict; toggle: () => void } | null>(null);

export function Providers({ config, children }: { config: PublicConfig; children: ReactNode }) {
  const [lang, setLang] = useState<Lang>('en');
  useEffect(() => {
    document.documentElement.lang = lang; // screen readers and hyphenation follow the toggle
  }, [lang]);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('ainek.lang');
      if (saved === 'ru' || saved === 'en') setLang(saved);
    } catch {
      /* private window */
    }
  }, []);
  const toggle = () => {
    const next: Lang = lang === 'en' ? 'ru' : 'en';
    setLang(next);
    try {
      window.localStorage.setItem('ainek.lang', next);
    } catch {
      /* ignore */
    }
  };
  return (
    <ConfigContext.Provider value={config}>
      <LangContext.Provider value={{ lang, t: dict[lang], toggle }}>
        <NearProvider config={{ network: config.network }}>{children}</NearProvider>
      </LangContext.Provider>
    </ConfigContext.Provider>
  );
}

export function useConfig(): PublicConfig {
  const cfg = useContext(ConfigContext);
  if (!cfg) throw new Error('useConfig outside <Providers>');
  return cfg;
}

export function useT(): { lang: Lang; t: Dict; toggle: () => void } {
  const v = useContext(LangContext);
  if (!v) throw new Error('useT outside <Providers>');
  return v;
}
