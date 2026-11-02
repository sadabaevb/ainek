import Link from 'next/link';
import type { ReactNode } from 'react';
import { Providers } from './providers';

export const metadata = { title: 'Ainek', description: 'Glass box for private AI agents on NEAR' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'monospace', maxWidth: 900, margin: '2rem auto', padding: '0 1rem' }}>
        <nav style={{ marginBottom: '1.5rem' }}>
          <Link href="/">relay spike</Link> · <Link href="/log">/log (wallet spike)</Link>
        </nav>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
