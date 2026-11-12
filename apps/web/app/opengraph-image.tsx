// The picture a link to the site shows in X, Telegram and Slack (1200x630), drawn at build time with next/og.
// It is a sheet of the site: the mark, the name, and two numbered lines for the two things the product does, with the
// footer's "testnet, not audited"; the full claims and limits are in the README. The colours are the light ones of
// lib/look.ts: the renderer cannot read the stylesheet's variables.
// The host in the footer and metadataBase in layout.tsx are the same site: change both when it moves.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { Logo } from '@/components/logo';
import { LIGHT as C } from '@/lib/look';

export const alt = 'Ainek: a glass box for private AI agents on NEAR. Key not in the public log: nothing is sent. Every answer comes with a proof you re-check yourself.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// The renderer reads .woff and not the .woff2 the pages serve, so the three faces it needs lie beside those in public/fonts
// (scripts/fonts.mjs copies both). Latin only: the picture is in English.
const face = (file: string) => readFile(join(process.cwd(), 'public/fonts', file));
const [serif, sans, mono] = await Promise.all([face('ibm-plex-serif-latin-500-normal.woff'), face('ibm-plex-sans-latin-400-normal.woff'), face('ibm-plex-mono-latin-500-normal.woff')]);
const SERIF = 'IBM Plex Serif', SANS = 'IBM Plex Sans', MONO = 'IBM Plex Mono';

/** One numbered line of the sheet, as on a proof card: the number, what holds, and a ticked or crossed box (drawn: the faces have no such glyph). */
const Line = ({ n, ok, title, text }: { n: string; ok: boolean; title: string; text: string }) => {
  const tone = ok ? C.ok : C.fail;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', padding: '24px 28px 26px', borderTop: n === '01' ? 'none' : `2px solid ${C.rule}` }}>
      <div style={{ display: 'flex', width: 56, paddingTop: 11, fontFamily: MONO, fontSize: 20, color: C.muted }}>{n}</div>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{ display: 'flex', fontFamily: SERIF, fontSize: 34, lineHeight: 1.25 }}>{title}</div>
        <div style={{ display: 'flex', fontSize: 23, lineHeight: 1.35, color: C.muted, marginTop: 2 }}>{text}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 46, height: 46, marginLeft: 28, marginTop: 4, border: `3px solid ${tone}`, borderRadius: 3, background: ok ? C.sheet : C.failBg }}>
        <svg width="36" height="36" viewBox="0 0 24 24">
          <path d={ok ? 'M5 12.5l4.5 4.5L19 7' : 'M6 6l12 12M18 6L6 18'} stroke={tone} strokeWidth="2.6" fill="none" />
        </svg>
      </div>
    </div>
  );
};

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: C.paper, color: C.ink, fontFamily: SANS, padding: '46px 64px 40px' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', fontFamily: SERIF, fontSize: 84, lineHeight: 1 }}>
            <Logo size={70} ink={C.ink} accent={C.accent} />
            <span style={{ marginLeft: 22 }}>Ainek</span>
          </div>
          {/* The words are separate boxes because the renderer drops the spaces between them; the gap stands for one. */}
          <div style={{ display: 'flex', gap: 11, marginTop: 14, fontFamily: SERIF, fontSize: 42, lineHeight: 1.25 }}>
            <span>A</span>
            <span style={{ backgroundImage: `linear-gradient(to bottom, ${C.paper} 60%, ${C.accentSoft} 60%)` }}>glass box</span>
            <span>for private AI agents on NEAR</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', background: C.sheet, border: `2px solid ${C.ink}`, borderRadius: 4 }}>
          <Line n="01" ok={false} title="Message not sent" text="The model key is not in the public log on NEAR: the client refuses before sending." />
          <Line n="02" ok title="Verified in your browser" text="Encrypted to the attested key, signed in the enclave, hashes recomputed by you." />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 20, color: C.muted }}>
          <span>ainek.vercel.app</span>
          <span style={{ letterSpacing: 1.6, textTransform: 'uppercase' }}>NEAR Hackathon 2026 · testnet, not audited</span>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: SERIF, data: serif, weight: 500, style: 'normal' },
        { name: SANS, data: sans, weight: 400, style: 'normal' },
        { name: MONO, data: mono, weight: 500, style: 'normal' },
      ],
    },
  );
}
