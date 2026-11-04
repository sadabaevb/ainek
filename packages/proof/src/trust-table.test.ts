import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile, readRepoJson } from './fixtures.ts';

// README "Who sees what", /trust (apps/web/app/trust/rows.json) and SPEC §8 promise the same rows. The English pair is
// checked here so a wording fix in one place cannot silently leave the other behind (SPEC §8 is Russian: by eye).
function readmeRows(): string[][] {
  const md = new TextDecoder().decode(readRepoFile('README.md'));
  const section = md.split('\n## Who sees what\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'README has a "Who sees what" section');
  return section
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Party') && !line.startsWith('| ---'))
    .map((line) => line.slice(1, -1).split(' | ').map((cell) => cell.trim().replace(/`/g, '')));
}

test('the README who-sees-what table and the /trust rows are the same text', () => {
  const page = readRepoJson<string[][]>('apps/web/app/trust/rows.json');
  const readme = readmeRows();
  assert.equal(readme.length, page.length, `README has ${readme.length} rows, /trust has ${page.length}`);
  for (let i = 0; i < page.length; i++) assert.deepEqual(readme[i], page[i], `row ${i + 1} (${page[i]?.[0]}) differs`);
});
