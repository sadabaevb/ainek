import type { ReactNode } from 'react';

export const metadata = { title: 'Ainek', description: 'Glass box for private AI agents on NEAR' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'monospace', maxWidth: 900, margin: '2rem auto', padding: '0 1rem' }}>{children}</body>
    </html>
  );
}
