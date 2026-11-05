import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';
import { LangToggle } from '@/components/lang-toggle';
import { Logo } from '@/components/logo';
import { NavLinks } from '@/components/nav-links';
import { WalletButton } from '@/components/wallet-button';
import { readPublicConfig } from '@/lib/config.server';
import { LANG_COOKIE, dict, type Lang } from '@/lib/i18n';
import { Providers } from './providers';

export const metadata = { title: 'Ainek', description: 'Glass box for private AI agents on NEAR' };
// Config comes from the root .env at request time (loaded by instrumentation.ts), so the layout cannot be prerendered.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const config = readPublicConfig();
  // The language lives in a cookie so the server renders the right one: no flash of English, no client-only nav.
  const lang: Lang = (await cookies()).get(LANG_COOKIE)?.value === 'ru' ? 'ru' : 'en';
  const nav = dict[lang].nav;
  return (
    <html lang={lang}>
      <head>
        {/* Inter when the network allows; the font stack falls back to the system font otherwise, nothing blocks on it. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
      </head>
      <body>
        <Providers config={config} lang={lang}>
          <header className="nav">
            <div className="nav-inner">
              <Link href="/" className="brand"><Logo /> Ainek</Link>
              <NavLinks items={[{ href: '/log', label: nav.log }, { href: '/verify', label: nav.verify }, { href: '/auditor', label: nav.auditor }, { href: '/trust', label: nav.trust }]} />
              <span className="right">
                <WalletButton />
                <LangToggle />
              </span>
            </div>
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}
