import { cookies } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { LangToggle } from '@/components/lang-toggle';
import { Logo } from '@/components/logo';
import { NavLinks } from '@/components/nav-links';
import { WalletButton } from '@/components/wallet-button';
import { readPublicConfig } from '@/lib/config.server';
import { LANG_COOKIE, type Lang } from '@/lib/i18n';
import { Providers } from './providers';

const DESCRIPTION = 'A glass box for private AI agents on NEAR: the model key is checked against a public log before anything is sent, and every answer comes with a proof you re-check yourself.';
// The link preview (Open Graph, X): the image is app/opengraph-image.tsx. SITE_URL only makes its address absolute; set it when the site moves.
export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL || 'https://ainek.vercel.app'),
  title: 'Ainek',
  description: DESCRIPTION,
  openGraph: { title: 'Ainek: a glass box for private AI agents on NEAR', description: DESCRIPTION, type: 'website', siteName: 'Ainek' },
  twitter: { card: 'summary_large_image', title: 'Ainek: a glass box for private AI agents on NEAR', description: DESCRIPTION },
};
// Config comes from the root .env at request time (loaded by instrumentation.ts), so the layout cannot be prerendered.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const config = readPublicConfig();
  // The language lives in a cookie so the server renders the right one: no flash of English, no client-only nav.
  const lang: Lang = (await cookies()).get(LANG_COOKIE)?.value === 'ru' ? 'ru' : 'en';
  return (
    <html lang={lang}>
      <head>
        {/* The self-hosted font subsets, preloaded so the first paint does not reflow when they land. */}
        <link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        {lang === 'ru' && <link rel="preload" href="/fonts/inter-cyrillic.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />}
      </head>
      <body>
        <Providers config={config} lang={lang}>
          <nav className="nav">
            <div className="nav-inner">
              <Link href="/" className="brand"><Logo /> Ainek</Link>
              <NavLinks />
              <span className="right">
                <WalletButton />
                <LangToggle />
              </span>
            </div>
          </nav>
          {children}
        </Providers>
      </body>
    </html>
  );
}
