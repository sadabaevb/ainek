import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdSection, readRepoText } from './fixtures.ts';

// docs/CLAIMS.md is the source of what we do not claim: each item is a bold title and a paragraph. Until Nov 14 the
// README repeated all the titles; it now names the few that matter most under "Limits", says how many there are in all
// and sends the reader to CLAIMS. What is tied here is what can drift: the count, and the shape of the list in CLAIMS.
const titlesOf = (section: string): string[] => [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1] ?? '');

test('docs/CLAIMS.md "We do not claim" is a list of titled items, and the README states how many there are', () => {
  const readme = mdSection(readRepoText('README.md'), 'Limits');
  const claims = mdSection(readRepoText('docs/CLAIMS.md'), 'We do not claim');
  assert.ok(readme, 'README has a "Limits" section');
  assert.ok(claims, 'CLAIMS.md has a "We do not claim" section');
  const titles = titlesOf(claims);
  // An item whose title wraps onto a second line, or is written with another bullet, would be read as no item at all.
  assert.equal(claims.split('\n').filter((l) => /^[-*] /.test(l)).length, titles.length, 'every item of CLAIMS opens with a bold title on one line');
  assert.ok(titles.length > 20, 'the list is there');
  assert.match(readme, new RegExp(`There are ${titles.length} in all`), 'the README states how many');
  assert.match(readme, /docs\/CLAIMS\.md#we-do-not-claim/);
});

// The README's own short list must stay short and must not grow paragraphs: a limit that needs more than its title and a
// sentence or two belongs in CLAIMS. And the items of CLAIMS it leans on must still be there under their titles.
test('the README "Limits" are a handful of titled items that CLAIMS still backs', () => {
  const readme = mdSection(readRepoText('README.md'), 'Limits') ?? '';
  const mine = titlesOf(readme);
  assert.ok(mine.length >= 4 && mine.length <= 6, `the README names ${mine.length} limits`);
  const titles = titlesOf(mdSection(readRepoText('docs/CLAIMS.md'), 'We do not claim') ?? '');
  for (const title of ['Verified model weights.', 'No retention inside the model enclave.', 'Protection from the server that serves the page.', 'An immutable log.', 'That a logged release is an approved one, or that the release rule closes this gap.', 'An audited contract.']) {
    assert.ok(titles.includes(title), `CLAIMS still has the item "${title}"`);
  }
});

// The paragraph on the field as it stood on Nov 13 lives in CLAIMS ("We claim") and, with two more sentences, in
// docs/PRIOR-ART.md. The README must not grow a third copy that drifts.
test('the README does not carry its own copy of the Nov 13 field paragraph', () => {
  assert.equal(readRepoText('README.md').includes('On Nov 13 the gallery held 820 entries.'), false);
  for (const file of ['docs/CLAIMS.md', 'docs/PRIOR-ART.md']) assert.ok(readRepoText(file).includes('On Nov 13 the gallery held 820 entries.'), file);
});
