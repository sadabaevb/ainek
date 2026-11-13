import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdSection, readRepoText } from './fixtures.ts';

// docs/CLAIMS.md is the source of what we do not claim: each item is a bold title and a paragraph. The README carries
// the same list by title and sends the reader to CLAIMS for the paragraphs. Copying by hand had already left two items
// out of the README, so the two lists are compared here: the same titles, in the same order, and the count the README
// states.
const titlesOf = (section: string): string[] => [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1] ?? '');

test('README "What we do not claim" lists the titles of docs/CLAIMS.md "We do not claim", in order', () => {
  const readme = mdSection(readRepoText('README.md'), 'What we do not claim');
  const claims = mdSection(readRepoText('docs/CLAIMS.md'), 'We do not claim');
  assert.ok(readme, 'README has a "What we do not claim" section');
  assert.ok(claims, 'CLAIMS.md has a "We do not claim" section');
  const listed = titlesOf(readme);
  assert.deepEqual(listed, titlesOf(claims));
  assert.ok(listed.length > 20, 'the list is there');
  assert.match(readme, new RegExp(`^\\n?${listed.length} things, each with its paragraph in`), 'the README states how many');
  // A title alone must read as a denial; a paragraph under it belongs in CLAIMS.
  for (const line of readme.split('\n').filter((l) => l.startsWith('- '))) assert.match(line, /^- \*\*.+\*\*$/, line);
});

// The paragraph on the field as it stood on Nov 13 lives in CLAIMS ("We claim") and, with two more sentences, in
// docs/PRIOR-ART.md. The README summarises it and must not grow a third copy that drifts.
test('the README does not carry its own copy of the Nov 13 field paragraph', () => {
  assert.equal(readRepoText('README.md').includes('On Nov 13 the gallery held 820 entries.'), false);
  for (const file of ['docs/CLAIMS.md', 'docs/PRIOR-ART.md']) assert.ok(readRepoText(file).includes('On Nov 13 the gallery held 820 entries.'), file);
});
