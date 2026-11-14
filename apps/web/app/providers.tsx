'use client';
// Client-side context: NearProvider (near-connect-hooks owns one NearConnector; wallets load from
// WALLET_MANIFEST_URL into sandboxed iframes, testnet only), the public config read on the server, and the UI language.
import { NearProvider } from 'near-connect-hooks';
import { useRouter } from 'next/navigation';
import { Suspense, createContext, useContext, useMemo, type ReactNode } from 'react';
import type { TrustSet } from '@ainek/proof';
import { releaseRuleFor, type PublicConfig } from '@/lib/config';
import { WALLET_MANIFEST_URL } from '@/lib/wallet';
import { LANG_COOKIE, dict, type Dict, type Lang } from '@/lib/i18n';
import { useCustomTrust, useOwnReleaseRule } from '@/lib/trust-set';

const ConfigContext = createContext<PublicConfig | null>(null);
/** `releaseRule`: whether the release rule (SPEC §7.5) applies for this viewer, by the site's setting or by their own switch on the chat page. */
const TrustContext = createContext<{ trust: TrustSet; isCustom: boolean; releaseRule: boolean } | null>(null);
const LangContext = createContext<{ lang: Lang; t: Dict; toggle: () => void } | null>(null);

/**
 * The viewer's trust set and their switch for the release rule, read inside the boundary below and not above it. The store has no value on the server and may
 * have one in the browser, so React renders its reader once more, at once, when it hydrates. Above the boundary that
 * second render reached a boundary whose content had not arrived yet, and React threw the server's HTML away and showed
 * nothing until it had: about two seconds of an empty page at 400 kbit/s, for a visitor with a trust set of their own.
 */
function TrustProvider({ config, children }: { config: PublicConfig; children: ReactNode }) {
  // Kept apart from the config, whose identity effects are keyed on: choosing who to trust must not re-run a page's reads.
  const custom = useCustomTrust(config);
  const ownReleaseRule = useOwnReleaseRule(config);
  const trust = useMemo(() => ({ trust: custom ?? config.siteTrust, isCustom: custom !== null, releaseRule: releaseRuleFor(config, ownReleaseRule) }), [custom, ownReleaseRule, config]);
  return <TrustContext.Provider value={trust}>{children}</TrustContext.Provider>;
}

export function Providers({ config, lang, children }: { config: PublicConfig; lang: Lang; children: ReactNode }) {
  const router = useRouter();
  // A refresh re-serializes the props; the config keeps its identity unless its values change, so effects keyed on it do not re-run.
  const configJson = JSON.stringify(config);
  const stableConfig = useMemo(() => JSON.parse(configJson) as PublicConfig, [configJson]);
  // The cookie is the only source of truth: the toggle writes it and re-renders the server tree (client state survives a refresh).
  const toggle = () => {
    document.cookie = `${LANG_COOKIE}=${lang === 'en' ? 'ru' : 'en'}; path=/; max-age=31536000; SameSite=Lax`;
    router.refresh();
  };
  return (
    <ConfigContext.Provider value={stableConfig}>
      <LangContext.Provider value={{ lang, t: dict[lang], toggle }}>
        {/* The boundary lets the wallet provider be committed once. near-connect-hooks builds its connector inside a
            render, and the connector fetches the wallet list as it is built. With nothing to stop at below the
            provider, React rendered it again and again while the page was still arriving, a connector and a request
            each time (docs/DEV-NOTES.md, Nov 13). No fallback, on purpose: the server's HTML stays up until the content
            hydrates. Nothing above the boundary may change right after hydration, which is why the trust set is read
            below it. */}
        <NearProvider config={{ network: stableConfig.network, manifest: WALLET_MANIFEST_URL }}>
          <Suspense>
            <TrustProvider config={stableConfig}>{children}</TrustProvider>
          </Suspense>
        </NearProvider>
      </LangContext.Provider>
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
