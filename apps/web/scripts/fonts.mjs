// Copies the IBM Plex files the site serves from the pinned @fontsource packages into public/fonts (`pnpm -F web fonts`).
// The copies are committed, so a clean clone builds and serves them with no install step of its own and no request to a
// third party; this script is how they got there and how to refresh them after a version bump. The @font-face rules are in
// app/globals.css and the preloads in app/layout.tsx: a weight or subset added here has to be added there.
// The link preview (app/opengraph-image.tsx) reads three of the faces as .woff: its renderer does not read .woff2.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const out = path.resolve(import.meta.dirname, '../public/fonts');
const FAMILIES = { sans: [400, 600], mono: [400, 500], serif: [500] };
const SUBSETS = ['latin', 'cyrillic'];
const PREVIEW = { serif: 500, sans: 400, mono: 500 }; // Latin only: the picture is in English

mkdirSync(out, { recursive: true });
for (const [family, weights] of Object.entries(FAMILIES)) {
  const pkg = path.dirname(require.resolve(`@fontsource/ibm-plex-${family}/package.json`));
  for (const weight of weights) {
    for (const subset of SUBSETS) {
      const name = `ibm-plex-${family}-${subset}-${weight}-normal.woff2`;
      copyFileSync(path.join(pkg, 'files', name), path.join(out, name));
      console.log(name);
    }
  }
  const preview = `ibm-plex-${family}-latin-${PREVIEW[family]}-normal.woff`;
  copyFileSync(path.join(pkg, 'files', preview), path.join(out, preview));
  console.log(preview);
  // One licence per family: the text is the same (SIL OFL 1.1), the copyright line above it is the family's own.
  copyFileSync(path.join(pkg, 'LICENSE'), path.join(out, `LICENSE-IBM-Plex-${family[0].toUpperCase()}${family.slice(1)}.txt`));
}
