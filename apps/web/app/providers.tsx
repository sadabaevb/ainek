'use client';
// Client-side context: NearProvider (near-connect-hooks owns one NearConnector; wallets load from a public
// manifest into sandboxed iframes, testnet only), the public config read on the server, and the UI language.
import { NearProvider } from 'near-connect-hooks';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { TrustSet } from '@ainek/proof';
import type { PublicConfig } from '@/lib/config';
import { LANG_COOKIE, dict, type Dict, type Lang } from '@/lib/i18n';
import { saveCustomTrust, useCustomTrust } from '@/lib/trust-set';

const ConfigContext = createContext<PublicConfig | null>(null);
const TrustContext = createContext<{ custom: TrustSet | null; siteDefault: TrustSet; choose: (next: TrustSet | null) => void } | null>(null);
const LangContext = createContext<{ lang: Lang; t: Dict; toggle: () => void } | null>(null);

export function Providers({ config, lang, children }: { config: PublicConfig; lang: Lang; children: ReactNode }) {
  const router = useRouter();
  // A refresh re-serializes the props; the config keeps its identity unless its values change, so effects keyed on it do not re-run.
  const configJson = JSON.stringify(config);
  const stableConfig = useMemo(() => JSON.parse(configJson) as PublicConfig, [configJson]);
  // The viewer's own trust set replaces the site's in the config every page reads, so the chat's check, the log page and the refusal cards cannot disagree.
  const custom = useCustomTrust(stableConfig);
  const effectiveConfig = useMemo(() => (custom ? { ...stableConfig, trustedVerifiers: custom.verifiers, quorum: custom.quorum } : stableConfig), [stableConfig, custom]);
  const trust = useMemo(() => ({ custom, siteDefault: { verifiers: stableConfig.trustedVerifiers, quorum: stableConfig.quorum }, choose: (next: TrustSet | null) => saveCustomTrust(stableConfig, next) }), [custom, stableConfig]);
  // The cookie is the only source of truth: the toggle writes it and re-renders the server tree (client state survives a refresh).
  const toggle = () => {
    document.cookie = `${LANG_COOKIE}=${lang === 'en' ? 'ru' : 'en'}; path=/; max-age=31536000; SameSite=Lax`;
    router.refresh();
  };
  return (
    <ConfigContext.Provider value={effectiveConfig}>
      <TrustContext.Provider value={trust}>
        <LangContext.Provider value={{ lang, t: dict[lang], toggle }}>
          <NearProvider config={{ network: stableConfig.network }}>{children}</NearProvider>
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
