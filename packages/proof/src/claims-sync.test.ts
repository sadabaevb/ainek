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
  // An item whose title wraps onto a second line, or is written with another bullet, would be read as no item at all.
  assert.equal(claims.split('\n').filter((l) => /^[-*] /.test(l)).length, listed.length, 'every item of CLAIMS opens with a bold title on one line');
  assert.ok(listed.length > 20, 'the list is there');
  assert.match(readme, new RegExp(`^\\n?${listed.length} things, each with its paragraph in`), 'the README states how many');
  // A title alone must read as a denial; a paragraph under it belongs in CLAIMS.
  for (const line of readme.split('\n').filter((l) => l.startsWith('- '))) assert.match(line, /^- \*\*.+\*\*$/, line);
});

// The README retells two things from CLAIMS in its own words: the five items it asks a reader not to miss, and how many
// known issues were inherited. Both are tied to CLAIMS here, so a new issue or a retitled item fails a test (it did:
// the first summary named two of the three).
test('the README prose under "What we do not claim" still matches docs/CLAIMS.md', () => {
  const readme = mdSection(readRepoText('README.md'), 'What we do not claim') ?? '';
  const claimsText = readRepoText('docs/CLAIMS.md');
  const titles = titlesOf(mdSection(claimsText, 'We do not claim') ?? '');
  assert.match(readme, /Five a reader should not miss/);
  for (const title of ['Verified model weights.', 'No retention inside the model enclave.', 'Protection from the server that serves the page.', 'That the action log is a measurement.', 'That a logged release is an approved one, or that the release rule closes this gap.']) {
    assert.ok(titles.includes(title), `CLAIMS still has the item "${title}"`);
  }
  const known = (mdSection(claimsText, 'Known issues we inherited (say so)', true) ?? '').split('\n').filter((l) => l.startsWith('- ')).length;
  assert.equal(known, 3, 'the README says "Three known issues": another in CLAIMS needs a sentence in the README');
  assert.match(readme, /^Three known issues we inherited/m);
});

// The paragraph on the field as it stood on Nov 13 lives in CLAIMS ("We claim") and, with two more sentences, in
// docs/PRIOR-ART.md. The README summarises it and must not grow a third copy that drifts.
test('the README does not carry its own copy of the Nov 13 field paragraph', () => {
  assert.equal(readRepoText('README.md').includes('On Nov 13 the gallery held 820 entries.'), false);
  for (const file of ['docs/CLAIMS.md', 'docs/PRIOR-ART.md']) assert.ok(readRepoText(file).includes('On Nov 13 the gallery held 820 entries.'), file);
});
