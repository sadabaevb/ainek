/**
 * The mark: a window of four panes, one of them tinted. "Ainek" is Kyrgyz for glass and for a window. The frame takes the
 * colour of the text and the pane the accent token, so the mark follows the theme. Inline SVG, so it needs no request.
 */
export function Logo() {
  return (
    <svg width={22} height={22} viewBox="0 0 64 64" aria-hidden>
      <rect x="35" y="9" width="20" height="20" style={{ fill: 'var(--accent)' }} />
      <path d="M9 9h46v46H9zM32 9v46M9 32h46" fill="none" stroke="currentColor" strokeWidth="6" />
    </svg>
  );
}
