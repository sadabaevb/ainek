import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoJson, readRepoText } from './fixtures.ts';
import { COUNTERSIGN, QUILL_POLICY_URL, countersignLine, outsideReadings, quillLine, readFeedEntry, teemoonLine, teemoonPageUrl, type AttestedState } from './outside-readings.ts';

// Recorded on Nov 13, 2026 (docs/samples/README.md): two entries of Countersign's feed as its contract returned them,
// two pins of Quill Cloud's policy file, and the first lines of one teemoon review page.
const entry7 = readRepoText('docs/samples/outside/countersign-entry-7.jwt');
const entry8 = readRepoText('docs/samples/outside/countersign-entry-8.jwt');
const policy = readRepoJson('docs/samples/outside/quill-policy.excerpt.json');
const page = readRepoText('docs/samples/outside/teemoon-page.excerpt.md');

// What the enclave attested on Nov 12, when the feed and the policy were written: the state our entries #73 and #74 mark.
const FILE = 'prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V12Q8.yaml';
const nov12: AttestedState = {
  model: 'z-ai/glm-5.3-flash',
  signingKey: '5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff',
  composeHash: 'c900dc7304663b73b623cd5d941fbdab6f02858017b371ae28de445a16d2e2d0',
  actions: { count: 271, sha256: 'e196ae7210ec5344b3c0c78b918126a195ff37b8e116fb0766e7df9e55180faa' },
  release: { name: 'v0.0.567', file: FILE, fileSha256: '2d10ba2c3dbcf021ccf888f180c23454c3209736f00836093c583af0f2f742df' },
};
// The same enclave after the release of Nov 13, 00:56 UTC: four more actions, another file.
const nov13: AttestedState = {
  ...nov12,
  actions: { count: 275, sha256: 'ab'.repeat(32) },
  release: { name: 'v0.0.581', file: FILE, fileSha256: '39bacef1630e83a9121cd3aaa636fe702ae0949f80988cfe762a7b5cb81ceac8' },
};
const SIGNED = Date.UTC(2026, 10, 12, 19, 18, 46);
const WHILE_VALID = Date.UTC(2026, 10, 13, 6, 0, 0);

test('readFeedEntry: an entry of the feed verifies under the pinned key and names the machines it reviewed', async () => {
  const entry = await readFeedEntry(entry8);
  assert.equal(entry.seq, 8);
  assert.equal(entry.host, 'cloud-api.near.ai/z-ai/glm-5.3-flash');
  assert.equal(entry.signedAtMs, SIGNED);
  assert.equal(entry.expiresAtMs, Date.UTC(2026, 10, 15, 19, 14, 24));
  const model = entry.machines.find((m) => m.signingKey === nov12.signingKey);
  assert.equal(model?.composeHash, nov12.composeHash);
  assert.equal(model?.status, 'warning');
  assert.deepEqual(model?.open, ['collateral_early', 'nvswitch']);
  assert.equal(model?.deployments.find((d) => d.file === FILE)?.sha256, nov12.release?.fileSha256);
  assert.equal((await readFeedEntry(entry7)).host, 'glm-5-3-flash.completions.near.ai');
});

test('readFeedEntry: one changed character, another key or a string that is no entry is not read', async () => {
  const [head, body, signature] = entry8.split('.') as [string, string, string];
  // The payload says "warning"; a hop that turns it into a clean verdict must not be believed.
  const forged = Buffer.from(Buffer.from(body, 'base64url').toString().replace('"ear_status":"warning"', '"ear_status":"affirmin"')).toString('base64url');
  await assert.rejects(readFeedEntry(`${head}.${forged}.${signature}`), /does not verify/);
  const otherKey = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'someone-else' })).toString('base64url');
  await assert.rejects(readFeedEntry(`${otherKey}.${body}.${signature}`), /a key this client does not hold/);
  const unsigned = Buffer.from(JSON.stringify({ alg: 'none', kid: Object.keys(COUNTERSIGN.keys)[0] })).toString('base64url');
  await assert.rejects(readFeedEntry(`${unsigned}.${body}.${signature}`), /a key this client does not hold/);
  await assert.rejects(readFeedEntry('not an entry'), /not a signed entry/);
});

test('countersignLine: the feed lists this key and launcher, says what its reviewer concluded, and which release it saw', async () => {
  const entries = [await readFeedEntry(entry7), await readFeedEntry(entry8)];
  const same = countersignLine(nov12, entries, WHILE_VALID);
  assert.equal(same.status, 'ok');
  assert.match(same.text, /entry 8 of 2026-11-12 19:18 UTC lists this signing key with this launcher for cloud-api\.near\.ai\/z-ai\/glm-5\.3-flash/);
  assert.match(same.text, /its verdict there is "warning" \(not passed: collateral_early, nvswitch\), valid until 2026-11-15 19:14 UTC/);
  assert.match(same.text, /It recorded the release file that runs now\.$/);
  // After the next release the key and the launcher are the same, and the feed's record is of the earlier file.
  assert.match(countersignLine(nov13, entries, WHILE_VALID).text, /It recorded release file 2d10ba2c…42df \(v0\.0\.567\), another than the one that runs now \(39bacef1…eac8\)\.$/);
});

test('countersignLine: another key, another launcher and an expired entry are not "looked at"', async () => {
  const entries = [await readFeedEntry(entry7), await readFeedEntry(entry8)];
  const otherKey = countersignLine({ ...nov12, signingKey: 'ab'.repeat(32) }, entries, WHILE_VALID);
  assert.deepEqual([otherKey.status, /none of its 2 current entries lists this signing key/.test(otherKey.text)], ['skipped', true]);
  const otherLauncher = countersignLine({ ...nov12, composeHash: 'cd'.repeat(32) }, entries, WHILE_VALID);
  assert.deepEqual([otherLauncher.status, /lists this signing key with another launcher \(c900dc73…e2d0\)/.test(otherLauncher.text)], ['skipped', true]);
  const expired = countersignLine(nov12, entries, Date.UTC(2026, 10, 16));
  assert.deepEqual([expired.status, /its entry 8 listed this signing key with this launcher and expired on 2026-11-15 19:14 UTC/.test(expired.text)], ['skipped', true]);
});

test('quillLine: the pin is of one state of the action log, and the next action leaves it behind', () => {
  const pinned = quillLine(nov12, policy);
  assert.equal(pinned.status, 'ok');
  assert.match(pinned.text, /pins this launcher at exactly this state of the action log \(e196ae72…0faa, 271 actions\)/);
  const moved = quillLine(nov13, policy);
  assert.equal(moved.status, 'skipped');
  assert.match(moved.text, /another state of the action log \(e196ae72…0faa, release file 2d10ba2c…42df\) than the one attested now \(abababab…abab, 275 actions\): nobody there has reviewed this state/);
  assert.match(quillLine({ ...nov12, composeHash: 'cd'.repeat(32) }, policy).text, /pins another launcher for this model \(c900dc73…e2d0\)/);
  assert.match(quillLine({ ...nov12, model: 'someone/else' }, policy).text, /has no pin for this model/);
  assert.match(quillLine({ ...nov12, actions: undefined }, policy).text, /this report carries no action log to compare/);
  for (const notAPolicy of [null, {}, 'text', [1, 'x']]) assert.equal(quillLine(nov12, notAPolicy).status, 'skipped');
});

test('teemoon: a page is looked up by the file and its hash, and its verdict is quoted, not interpreted', () => {
  assert.equal(teemoonPageUrl(nov12.release!), `https://raw.githubusercontent.com/teemoonai/audits/main/manifests/nearai/cvm-compose-files/prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V12Q8/sha256-${nov12.release!.fileSha256}.md`);
  // The file name comes from the enclave's action log: nothing that would leave the repository's folder becomes a URL.
  for (const file of ['../../etc/passwd', 'prod/../../x.yaml', '/abs.yaml', 'prod//x.yaml', '']) assert.equal(teemoonPageUrl({ file, fileSha256: nov12.release!.fileSha256 }), undefined, file);
  assert.match(teemoonPageUrl({ file: 'prod/a b?.yaml', fileSha256: nov12.release!.fileSha256 }) ?? '', /\/prod\/a%20b%3F\/sha256-/);
  assert.equal(teemoonPageUrl({ file: FILE, fileSha256: 'zz' }), undefined);
  assert.equal(teemoonPageUrl({ file: FILE }), undefined);
  const reviewed = teemoonLine(nov12.release!, page);
  assert.deepEqual([reviewed.status, /a review of exactly this release file \(2d10ba2c…42df, v0\.0\.567\); its verdict line begins "QUALIFIED PASS"/.test(reviewed.text)], ['ok', true]);
  const none = teemoonLine(nov13.release!, null);
  assert.deepEqual([none.status, /no review of this release file \(39bacef1…eac8, v0\.0\.581\)/.test(none.text)], ['skipped', true]);
  assert.match(teemoonLine(nov12.release!, 'a page without that line').text, /its verdict line was not found/);
});

// ---- the three together, against stand-ins for the NEAR RPC and raw.githubusercontent.com ----
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const viewResult = (value: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { result: Array.from(Buffer.from(JSON.stringify(value))), logs: [], block_height: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });

function world({ feedDown = false, policyStatus = 200, pageStatus = 404 } = {}): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    asked.push(target);
    if (target === COUNTERSIGN.rpcUrl) {
      if (feedDown) return new Response('down', { status: 503 });
      const call = JSON.parse(String(init?.body)) as { params: { method_name: string; args_base64: string } };
      const args = JSON.parse(Buffer.from(call.params.args_base64, 'base64').toString()) as { seq?: number };
      if (call.params.method_name === 'hosts') return viewResult([{ host: 'glm-5-3-flash.completions.near.ai', latest: { seq: 7 } }, { host: 'cloud-api.near.ai/z-ai/glm-5.3-flash', latest: { seq: 8 } }]);
      return viewResult(args.seq === 7 ? entry7 : entry8);
    }
    if (target === QUILL_POLICY_URL) return new Response(JSON.stringify(policy), { status: policyStatus });
    return new Response(pageStatus === 200 ? page : 'Not Found', { status: pageStatus });
  }) as typeof fetch;
  return asked;
}

test('outsideReadings: on Nov 13 the key and the launcher had been looked at, the state that ran had not', async () => {
  const asked = world();
  const lines = await outsideReadings(nov13, { now: WHILE_VALID });
  assert.deepEqual(lines.map((l) => l.status), ['ok', 'skipped', 'skipped']);
  assert.match(lines[0]!.text, /^Countersign, .*another than the one that runs now/);
  assert.match(lines[1]!.text, /^Quill Cloud, .*nobody there has reviewed this state$/);
  assert.match(lines[2]!.text, /^teemoon audits, .*no review of this release file/);
  // Three view calls of the feed, the policy file and one page: nothing else, and nothing that carries a key.
  assert.equal(asked.filter((u) => u === COUNTERSIGN.rpcUrl).length, 3);
  assert.equal(asked.filter((u) => u.startsWith('https://raw.githubusercontent.com/')).length, 2);
  assert.equal(asked.length, 5);
});

test('outsideReadings: a source that does not answer is a line that says so, and the others are still read', async () => {
  world({ feedDown: true, policyStatus: 500, pageStatus: 200 });
  const lines = await outsideReadings(nov12, { now: WHILE_VALID });
  assert.deepEqual(lines.map((l) => l.status), ['skipped', 'skipped', 'ok']);
  assert.match(lines[0]!.text, /^Countersign, .*: could not be read \(/);
  assert.match(lines[1]!.text, /^Quill Cloud, .*: could not be read \(HTTP 500\)$/);
  assert.match(lines[2]!.text, /its verdict line begins "QUALIFIED PASS"/);
});
