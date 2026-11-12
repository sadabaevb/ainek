import { MARK } from '@/lib/look';

/**
 * The mark: a window of four panes, one of them tinted. "Ainek" is Kyrgyz for glass and for a window. On a page the frame
 * takes the colour of the text and the pane the accent token, so the mark follows the theme; the link preview hands in
 * the light colours, because its renderer cannot read the tokens. Inline SVG, so it needs no request.
 */
export function Logo({ size = 22, ink = 'currentColor', accent = 'var(--accent)' }: { size?: number; ink?: string; accent?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      {/* The pane's colour twice: the style is what a page reads (a variable in a style holds in every browser), the
          attribute is what the preview's renderer reads. */}
      <rect {...MARK.pane} fill={accent} style={{ fill: accent }} />
      <path d={MARK.frame} fill="none" stroke={ink} strokeWidth={MARK.strokeWidth} />
    </svg>
  );
}
