import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdSection, readRepoText } from './fixtures.ts';

// docs/CLAIMS.md is the source of what we do not claim, and the README carries the same list. Copying by hand had
// already left two items out of the README, so the two texts are compared here: only the two headings may differ.
test('README "What we do not claim" and "Known issues" repeat docs/CLAIMS.md word for word', () => {
  const readme = mdSection(readRepoText('README.md'), 'What we do not claim');
  const claims = mdSection(readRepoText('docs/CLAIMS.md'), 'We do not claim', true);
  assert.ok(readme, 'README has a "What we do not claim" section');
  assert.ok(claims, 'CLAIMS.md has a "We do not claim" section');
  assert.equal(
    readme.replace('\nKnown issues we inherited (and say so):\n', '\n## Known issues we inherited (say so)\n').trim(),
    claims.trim(),
  );
});
