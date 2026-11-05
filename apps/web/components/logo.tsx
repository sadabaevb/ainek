/** The glass box: a rounded square with a check, in the brand gradient (the accent tokens, so it follows the theme). Inline SVG so it needs no asset request. Rendered once per page (the nav): the gradient id is fixed. */
export function Logo() {
  return (
    <svg width={22} height={22} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="ainek-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--accent)' }} />
          <stop offset="1" style={{ stopColor: 'var(--accent-2)' }} />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#ainek-g)" />
      <path d="M20 33l8 8 16-18" fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
