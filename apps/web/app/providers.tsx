'use client';
// Client-side context: NearProvider (near-connect-hooks owns one NearConnector; wallets load from a commit-pinned
// manifest, WALLET_MANIFEST_URL, into sandboxed iframes, testnet only), the public config read on the server, and the UI language.
import { NearProvider } from 'near-connect-hooks';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { TrustSet } from '@ainek/proof';
import type { PublicConfig } from '@/lib/config';
import { WALLET_MANIFEST_URL } from '@/lib/wallet';
import { LANG_COOKIE, dict, type Dict, type Lang } from '@/lib/i18n';
import { useCustomTrust } from '@/lib/trust-set';

const ConfigContext = createContext<PublicConfig | null>(null);
const TrustContext = createContext<{ trust: TrustSet; isCustom: boolean } | null>(null);
const LangContext = createContext<{ lang: Lang; t: Dict; toggle: () => void } | null>(null);

export function Providers({ config, lang, children }: { config: PublicConfig; lang: Lang; children: ReactNode }) {
  const router = useRouter();
  // A refresh re-serializes the props; the config keeps its identity unless its values change, so effects keyed on it do not re-run.
  const configJson = JSON.stringify(config);
  const stableConfig = useMemo(() => JSON.parse(configJson) as PublicConfig, [configJson]);
  // Kept apart from the config, whose identity effects are keyed on: choosing who to trust must not re-run a page's reads.
  const custom = useCustomTrust(stableConfig);
  const trust = useMemo(() => ({ trust: custom ?? stableConfig.siteTrust, isCustom: custom !== null }), [custom, stableConfig]);
  // The cookie is the only source of truth: the toggle writes it and re-renders the server tree (client state survives a refresh).
  const toggle = () => {
    document.cookie = `${LANG_COOKIE}=${lang === 'en' ? 'ru' : 'en'}; path=/; max-age=31536000; SameSite=Lax`;
    router.refresh();
  };
  return (
    <ConfigContext.Provider value={stableConfig}>
      <TrustContext.Provider value={trust}>
        <LangContext.Provider value={{ lang, t: dict[lang], toggle }}>
          <NearProvider config={{ network: stableConfig.network, manifest: WALLET_MANIFEST_URL }}>{children}</NearProvider>
        </LangContext.Provider>
      </TrustContext.Provider>
    </ConfigContext.Provider>
  );
}

export function useConfig(): PublicConfig {
  const cfg = useContext(ConfigContext);
  if (!cfg) throw new Error('useConfig outside <Providers>');
  return cfg;
}

export function useTrust() {
  const v = useContext(TrustContext);
  if (!v) throw new Error('useTrust outside <Providers>');
  return v;
}

export function useT(): { lang: Lang; t: Dict; toggle: () => void } {
  const v = useContext(LangContext);
  if (!v) throw new Error('useT outside <Providers>');
  return v;
}
