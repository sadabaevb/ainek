// The stylesheet sets the look; three other files repeat a part of it because they cannot read the stylesheet. These tests
// fail when one of them is changed without the others.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DARK_PAPER, LIGHT, MARK } from './look.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const DARK_BLOCK = '@media screen and (prefers-color-scheme: dark)';

test('the colours kept outside the stylesheet are the tokens of the stylesheet', () => {
  const css = read('../app/globals.css');
  assert.ok(css.includes(DARK_BLOCK), 'the dark tokens are set for the screen only, so paper stays light');
  const light = css.slice(css.indexOf(':root {'), css.indexOf(DARK_BLOCK));
  const dark = css.slice(css.indexOf(DARK_BLOCK));
  const token = (block: string, name: string) => new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(block)?.[1];
  const names: Record<keyof typeof LIGHT, string> = { paper: 'paper', sheet: 'sheet', ink: 'ink', muted: 'muted', rule: 'rule', accent: 'accent', accentSoft: 'accent-soft', ok: 'ok', fail: 'fail', failBg: 'fail-bg' };
  for (const [key, name] of Object.entries(names)) assert.equal(LIGHT[key as keyof typeof LIGHT], token(light, name), `--${name}`);
  assert.equal(DARK_PAPER, token(dark, 'paper'), 'dark --paper');
});

test('the icon file draws the mark of the page, in the light colours', () => {
  const svg = read('../app/icon.svg');
  const { x, y, width, height } = MARK.pane;
  assert.ok(svg.includes(`<rect width="64" height="64" fill="${LIGHT.paper}"/>`), 'the paper');
  assert.ok(svg.includes(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${LIGHT.accent}"/>`), 'the tinted pane');
  assert.ok(svg.includes(`<path d="${MARK.frame}" fill="none" stroke="${LIGHT.ink}" stroke-width="${MARK.strokeWidth}"/>`), 'the frame');
});
