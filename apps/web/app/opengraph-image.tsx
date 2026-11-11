// The picture a link to the site shows in X, Telegram and Slack (1200x630), drawn at build time with next/og.
// Two things the product does, and the footer's "testnet, not audited"; the full claims and limits are in the README.
// The host in the footer and metadataBase in layout.tsx are the same site: change both when it moves.
import { ImageResponse } from 'next/og';

export const alt = 'Ainek: a glass box for private AI agents on NEAR. Key not in the public log: nothing is sent. Every answer comes with a proof you re-check yourself.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Mirrors :root in globals.css: the image renderer cannot read CSS variables.
const C = { bg: '#f5f7fb', fg: '#0f172a', muted: '#64748b', line: '#e2e8f0', accent: '#4f46e5', ok: '#15803d', okBg: '#ecfdf3', bad: '#b91c1c', badBg: '#fef2f2' };

// The bundled font has one weight and no check mark glyph, so the marks are drawn.
const Card = ({ color, bg, ok, title, text }: { color: string; bg: string; ok: boolean; title: string; text: string }) => (
  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, background: bg, border: `2px solid ${C.line}`, borderRadius: 24, padding: '26px 30px' }}>
    <div style={{ display: 'flex', alignItems: 'center', fontSize: 34, color }}>
      <svg width="38" height="38" viewBox="0 0 24 24" style={{ marginRight: 14 }}>
        <circle cx="12" cy="12" r="11" fill={color} />
        <path d={ok ? 'M7 12.5l3.2 3.2L17 9' : 'M12 6.5v7M12 17v.5'} stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
      {title}
    </div>
    <div style={{ display: 'flex', fontSize: 25, color: C.fg, marginTop: 12, lineHeight: 1.3 }}>{text}</div>
  </div>
);

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: C.bg, color: C.fg, padding: '56px 64px' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 96 }}>
            <span style={{ color: C.accent }}>Ainek</span>
          </div>
          <div style={{ display: 'flex', fontSize: 42, marginTop: 6 }}>A glass box for private AI agents on NEAR</div>
        </div>
        <div style={{ display: 'flex', gap: 24 }}>
          <Card color={C.bad} bg={C.badBg} ok={false} title="Message not sent" text="The model key is not in the public log on NEAR: the client refuses before sending." />
          <Card color={C.ok} bg={C.okBg} ok title="Verified in your browser" text="Encrypted to the attested key, signed in the enclave, hashes recomputed by you." />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 26, color: C.muted }}>
          <span>ainek.vercel.app</span>
          <span>NEAR Hackathon 2026 · testnet, not audited</span>
        </div>
      </div>
    ),
    size,
  );
}
