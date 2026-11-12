import { cookies } from 'next/headers';
import Link from 'next/link';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { preload } from 'react-dom';
import './globals.css';
import { LangToggle } from '@/components/lang-toggle';
import { Logo } from '@/components/logo';
import { NavLinks } from '@/components/nav-links';
import { WalletButton } from '@/components/wallet-button';
import { readPublicConfig } from '@/lib/config.server';
import { LANG_COOKIE, dict, type Lang } from '@/lib/i18n';
import { Providers } from './providers';

const DESCRIPTION = 'A glass box for private AI agents on NEAR: the model key is checked against a public log before anything is sent, and every answer comes with a proof you re-check yourself.';
const OG_TITLE = 'Ainek: a glass box for private AI agents on NEAR';
// The link preview (Open Graph, X): the image is app/opengraph-image.tsx. metadataBase only makes its address absolute; the X card
// takes its title and description from the Open Graph ones.
export const metadata: Metadata = {
  metadataBase: new URL('https://ainek.vercel.app'),
  title: 'Ainek',
  description: DESCRIPTION,
  openGraph: { title: OG_TITLE, description: DESCRIPTION, type: 'website', siteName: 'Ainek' },
  twitter: { card: 'summary_large_image' },
};
// The browser's own frame (the address bar of a phone) takes the paper of the theme in use: --paper of globals.css, light and dark.
export const viewport: Viewport = { themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f6f4ee' }, { media: '(prefers-color-scheme: dark)', color: '#14130f' }] };
// Config comes from the root .env at request time (loaded by instrumentation.ts), so the layout cannot be prerendered.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const config = readPublicConfig();
  // The language lives in a cookie so the server renders the right one: no flash of English, no client-only nav.
  const lang: Lang = (await cookies()).get(LANG_COOKIE)?.value === 'ru' ? 'ru' : 'en';
  // The self-hosted faces of the first paint (text and headings), announced early so it does not reflow when they land.
  // The Cyrillic subsets only for the Russian page; the monospace and the bold load when a rule first needs them.
  // Through React's preload(), which a production build sends as a Link header ahead of the page; a <link> written in
  // this tree was fetched twice on the dev server (docs/DEV-NOTES.md, Nov 12, the design pass).
  for (const subset of lang === 'ru' ? ['latin', 'cyrillic'] : ['latin']) {
    for (const face of [`sans-${subset}-400`, `serif-${subset}-500`]) preload(`/fonts/ibm-plex-${face}-normal.woff2`, { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
  }
  return (
    <html lang={lang}>
      <body>
        <Providers config={config} lang={lang}>
          {/* The first stop of the Tab key: past the navigation, to the page. */}
          <a className="skip" href="#content">{dict[lang].skip}</a>
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
          <div id="content">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
