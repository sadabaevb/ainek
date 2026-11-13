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

// The paragraph on the field as it stood on Nov 13 is in the README ("Prior art in this hackathon") and in CLAIMS
// ("We claim"), copied by hand like the list above. The README bolds two names and links the file CLAIMS names in
// backticks; nothing else may differ.
test('README and docs/CLAIMS.md carry the same paragraph on the Nov 13 field', () => {
  const paragraph = (md: string): string => {
    const start = md.indexOf('On Nov 13 the gallery held 820 entries.');
    assert.ok(start >= 0, 'the paragraph is there');
    return md
      .slice(start, md.indexOf('\n', start))
      .split('**')
      .join('')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '`$1`')
      .trim();
  };
  assert.equal(paragraph(readRepoText('README.md')), paragraph(readRepoText('docs/CLAIMS.md')));
});
