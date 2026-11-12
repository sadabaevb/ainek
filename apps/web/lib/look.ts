// What of the look has to live outside the stylesheet: the light colours for the two places that cannot read its
// variables (the link preview in app/opengraph-image.tsx, the colour of the browser's own frame in app/layout.tsx) and
// the geometry of the mark. The stylesheet (app/globals.css) is where the look is set; look.test.ts keeps these values,
// the stylesheet and the icon file (app/icon.svg) equal.
export const LIGHT = { paper: '#f6f4ee', sheet: '#fffdf9', ink: '#17150f', muted: '#5f5b51', rule: '#d8d3c6', accent: '#1f44d6', accentSoft: '#e2e8fb', ok: '#1b6b3a', fail: '#b3261e', failBg: '#fbeae7' } as const;
export const DARK_PAPER = '#14130f';

/** The window mark in a box of 64 units: the frame with its cross, and the pane that is tinted. */
export const MARK = { frame: 'M9 9h46v46H9zM32 9v46M9 32h46', strokeWidth: 6, pane: { x: 35, y: 9, width: 20, height: 20 } } as const;
