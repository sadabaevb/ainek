// Offline tests: the decision logic around attestation, with the recorded report from docs/samples standing in
// for the network. The SDK's verification itself is exercised by `pnpm demo` (replay) and by the live run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { VerificationError, type VerificationFailure, type verifyModelAttestation } from '@nearai/inference-sdk/node';
import { buildKeyEntryInput, type KeyEntry, type RawReport } from '@ainek/proof';
import { attestModel, selectModelAttestations, withDeadline, type AttestedKey } from './attest.ts';
import { MAX_INTERVAL_MIN, MAX_REPORTS_PER_ROUND, loadConfig } from './config.ts';
import { alreadyLogged, parseLoggedIndex, type KeyLogWriter } from './log.ts';
import { RETRY_AFTER_FAILURE_MS, failureStreaks, nextDelayMs, runRound } from './main.ts';

const samples = new URL('../../../docs/samples/', import.meta.url);
const reportBytes = readFileSync(new URL('attestation-report.json', samples));
const raw = JSON.parse(reportBytes.toString('utf8')) as RawReport;
const logged = (JSON.parse(readFileSync(new URL('key-entry.sample.json', samples), 'utf8')) as { entry: KeyEntry }).entry;
const model = raw.model_attestations[0]!.model_name;

/** The entry the daemon would build from the recorded report, if the SDK had verified it (structural evidence only). */
function entryFromRecording() {
  const m = selectModelAttestations(raw, model)[0]!;
  return buildKeyEntryInput({
    model: m.model_name,
    verified: {
      signer: { signingAlgo: m.signing_algo, signingAddress: m.signing_address },
      ...(m.signing_public_key === undefined ? {} : { signingPublicKey: m.signing_public_key }),
      tcbStatus: 'UpToDate',
      deployment: { appCompose: m.info.tcb_info.app_compose, runtimeMeasurements: { composeHash: m.info.tcb_info.compose_hash } },
      report: { nonce: m.request_nonce },
    },
    reportBytes,
    observedAtMs: Date.now(),
  });
}

test('selectModelAttestations returns every attestation of the model, so a second replica is logged too', () => {
  const twoReplicas: RawReport = { ...raw, model_attestations: [raw.model_attestations[0]!, { ...raw.model_attestations[0]!, signing_address: 'ab'.repeat(32) }] };
  assert.equal(selectModelAttestations(twoReplicas, model).length, 2);
  assert.throws(() => selectModelAttestations(raw, 'nobody/such-model'), /no model_attestations/);
});

test('alreadyLogged: same key + same compose hash from us within the window is not re-logged', () => {
  const entry = entryFromRecording();
  const mine: KeyEntry = { ...logged, signing_address: entry.signing_address, compose_hash: entry.compose_hash };
  assert.equal(alreadyLogged(entry, [mine])?.index, mine.index);
  // A rotated key or a redeployed compose is new information and must be logged.
  assert.equal(alreadyLogged(entry, [{ ...mine, signing_address: 'ab'.repeat(32) }]), undefined);
  assert.equal(alreadyLogged(entry, [{ ...mine, compose_hash: 'cd'.repeat(32) }]), undefined);
  assert.equal(alreadyLogged(entry, []), undefined);
});

/** The entry with the marks a verifier writes after following the release: the enclave's action log at `actions` actions. */
function marked<E extends { image_digests: string[] }>(entry: E, actions: number): E {
  return { ...entry, image_digests: [...entry.image_digests, `log:19aea1693533dc2d:${actions}:${'a'.repeat(64)}`, `release:0123456789abcdef:${'b'.repeat(64)}`] };
}

test('alreadyLogged: an entry with release marks is covered only by one with the same marks', () => {
  const entry = entryFromRecording();
  const mine: KeyEntry = { ...logged, signing_address: entry.signing_address, compose_hash: entry.compose_hash, image_digests: entry.image_digests };
  // The enclave deployed since our last entry: its action log is longer, and a client that asks for a logged release
  // waits for exactly this entry. The 6 h rule must not hold it back.
  assert.equal(alreadyLogged(marked(entry, 157), [marked(mine, 156)]), undefined);
  assert.equal(alreadyLogged(marked(entry, 157), [mine]), undefined, 'an entry without marks does not cover one with marks');
  assert.equal(alreadyLogged(marked(entry, 157), [marked(mine, 156), marked({ ...mine, index: 9 }, 157)])?.index, 9, 'the same state is logged once');
  // A round that could not follow the release has nothing new to say about a key and compose already in the log.
  assert.equal(alreadyLogged(entry, [marked(mine, 156)])?.index, mine.index);
  // Marks never make another key or another compose look logged.
  assert.equal(alreadyLogged(marked(entry, 157), [marked({ ...mine, compose_hash: 'cd'.repeat(32) }, 157)]), undefined);
});

test('report_hash is the sha256 of the exact bytes we store, so the file on disk can be checked against the log', () => {
  const entry = entryFromRecording();
  assert.equal(entry.report_hash, createHash('sha256').update(reportBytes).digest('hex'));
});

test('parseLoggedIndex reads the index from log_key and fails plainly on anything else', () => {
  assert.equal(parseLoggedIndex(Buffer.from('42').toString('base64')), 42);
  assert.throws(() => parseLoggedIndex(''), /returned no index/);
  assert.throws(() => parseLoggedIndex(Buffer.from('"x"').toString('base64')), /returned no index/);
});

test('loadConfig refuses to start without the verifier account and key, and bounds the interval', () => {
  assert.throws(() => loadConfig({ AINEK_CONTRACT: 'x.testnet' }), /VERIFIER_ACCOUNT_ID and VERIFIER_PRIVATE_KEY/);
  const base = { VERIFIER_ACCOUNT_ID: 'v1.testnet', VERIFIER_PRIVATE_KEY: 'ed25519:' + '1'.repeat(80) };
  const cfg = loadConfig({ ...base, VERIFIER_MODELS: 'a/b, c/d' });
  assert.deepEqual(cfg.models, ['a/b', 'c/d']);
  assert.equal(cfg.intervalMs, 15 * 60_000);
  assert.throws(() => loadConfig({ ...base, VERIFIER_INTERVAL_MIN: String(MAX_INTERVAL_MIN + 1) }), /between 1 and/);
  // A dry run sends nothing, so the .env.example placeholders must be enough (clean-clone rule).
  assert.equal(loadConfig({ VERIFIER_ACCOUNT_ID: 'v1.ainek.testnet', VERIFIER_PRIVATE_KEY: 'ed25519:...' }, { dryRun: true }).dryRun, true);
  // A writing verifier wants every replica; the clean-clone dry run stays one report long.
  assert.equal(cfg.reportsPerRound, 5);
  assert.equal(loadConfig({}, { dryRun: true }).reportsPerRound, 1);
  assert.equal(loadConfig({ ...base, VERIFIER_REPORTS_PER_ROUND: '2' }).reportsPerRound, 2);
  assert.throws(() => loadConfig({ ...base, VERIFIER_REPORTS_PER_ROUND: String(MAX_REPORTS_PER_ROUND + 1) }), /between 1 and/);
  assert.throws(() => loadConfig({ ...base, VERIFIER_REPORTS_PER_ROUND: '1.5' }), /whole number/);
  // Release marks are on unless turned off; the GitHub token is optional and a blank line in .env is no token.
  assert.deepEqual([cfg.releaseMarks, cfg.githubToken], [true, undefined]);
  assert.equal(loadConfig({ ...base, VERIFIER_RELEASE_MARKS: '' }).releaseMarks, true);
  assert.equal(loadConfig({ ...base, VERIFIER_RELEASE_MARKS: '0' }).releaseMarks, false);
  assert.equal(loadConfig({ ...base, VERIFIER_RELEASE_MARKS: 'false' }).releaseMarks, false);
  assert.deepEqual([loadConfig({ ...base, GITHUB_TOKEN: ' ' }).githubToken, loadConfig({ ...base, GITHUB_TOKEN: ' t0ken ' }).githubToken], [undefined, 't0ken']);
});

/** A round in which the gateway's balancer answers from the given replicas, one per report; `fail` reports do not come back. */
function roundWith(...composes: (string | 'fail')[]) {
  const base = selectModelAttestations(raw, model)[0]!;
  let call = 0;
  const attest = async (m: string) => {
    const compose = composes[call++ % composes.length]!;
    if (compose === 'fail') throw new Error('gateway: HTTP 502');
    const entry = { ...entryFromRecording(), compose_hash: compose.repeat(32) };
    return { model: m, nonce: base.request_nonce, reportBytes: new Uint8Array([call]), reportHash: `report-${call}`, keys: [{ ok: true as const, verified: { gpuEvidence: 'verified' } as AttestedKey extends { verified: infer V } ? V : never, entry }] };
  };
  const logged: string[] = [];
  const writer: KeyLogWriter = { recentByMe: async () => [], logKey: async (e) => (logged.push(e.compose_hash), { index: logged.length, txHash: `tx${logged.length}` }) };
  return { attest, writer, logged, calls: () => call };
}

test('one round sees every replica behind the balancer and logs each deployment once', async () => {
  const reportsDir = `${tmpdir()}/ainek-verifier-test-${process.pid}`;
  after(() => rmSync(reportsDir, { recursive: true, force: true }));
  const cfg = { ...loadConfig({ VERIFIER_ACCOUNT_ID: 'v1.testnet', VERIFIER_PRIVATE_KEY: 'ed25519:' + '1'.repeat(80), VERIFIER_REPORTS_PER_ROUND: '4' }), reportsDir };
  const lines: string[] = [];
  // Nov 10: the same key is served from several composes (replicas). Until a verifier logs a compose, a client that checks
  // the deployment refuses it; with one report a round that took as long as the balancer took to pick that replica.
  const r = roundWith('aa', 'bb', 'aa', 'fail');
  const results = await runRound(cfg, r.writer, (l) => lines.push(l), r.attest);
  assert.equal(r.calls(), 4, 'every report of the round is fetched, a failed one is not retried in the round');
  assert.deepEqual(r.logged, ['aa'.repeat(32), 'bb'.repeat(32)], 'each deployment is logged once, the repeated replica is not');
  assert.equal(results.filter((x) => x.outcome === 'logged').length, 2);
  assert.equal(results.filter((x) => x.outcome === 'current').length, 1, 'the repeated replica counts as current, not as a failure');
  assert.ok(lines.some((l) => /report 4 of 4 failed/.test(l)), 'the lost report is said, and does not fail the round');
  assert.ok(lines.some((l) => /3 report\(s\) with 3 attestation/.test(l)));

  // No report at all is the one case the model's round fails: nothing could be checked.
  const none = roundWith('fail');
  const failed = await runRound(cfg, none.writer, () => {}, none.attest);
  assert.deepEqual(failed.map((x) => x.outcome), ['failed']);
  assert.equal(none.logged.length, 0);
});

test('a new failure is retried within a minute; one that stays backs off without slowing the others', () => {
  const interval = 15 * 60_000;
  const failed = (key: string) => ({ model: 'a/b', key, outcome: 'failed', error: 'fetch failed' }) as const;
  const ok = { model: 'a/b', key: 'ok', outcome: 'current', index: 3 } as const;
  assert.equal(nextDelayMs(failureStreaks([ok], new Map()), interval), interval);
  // Each lost round eats into the clients' 24 h window, so a transient error must not cost a whole interval.
  let streaks = failureStreaks([ok, failed('bad')], new Map());
  assert.equal(nextDelayMs(streaks, interval), RETRY_AFTER_FAILURE_MS);
  // A replica whose evidence never verifies must not make us hit PCCS and NRAS every minute for as long as it is up.
  streaks = failureStreaks([failed('bad')], failureStreaks([failed('bad')], streaks));
  assert.equal(nextDelayMs(streaks, interval), 4 * RETRY_AFTER_FAILURE_MS);
  for (let i = 0; i < 20; i++) streaks = failureStreaks([failed('bad')], streaks);
  assert.equal(nextDelayMs(streaks, interval), interval);
  // ...and that standing failure must not take the fast retry away from a fresh one on another key.
  streaks = failureStreaks([failed('bad'), failed('new')], streaks);
  assert.equal(nextDelayMs(streaks, interval), RETRY_AFTER_FAILURE_MS);
  // A key that recovered starts from scratch the next time it fails.
  assert.equal(failureStreaks([failed('bad')], failureStreaks([ok], streaks)).get('a/b/bad'), 1);
  assert.equal(nextDelayMs(failureStreaks([failed('bad')], new Map()), 30_000), 30_000, 'never slower than the configured interval');
});

test('withDeadline fails a hung call instead of blocking the loop forever, and leaves a slow one alone', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 20, 'attestation of a/b'), /attestation of a\/b did not finish within/);
  assert.equal(await withDeadline(new Promise((r) => setTimeout(() => r(7), 20)), 5_000, 'x'), 7);
  await assert.rejects(withDeadline(Promise.reject(new Error('own failure')), 5_000, 'x'), /own failure/);
});

/** The SDK's verdict for the recorded report, with the client's nonce: what `verifyModelAttestation` would resolve to. */
function verifiedWithNonce(nonce: string) {
  const m = selectModelAttestations(raw, model)[0]!;
  return {
    signer: { signingAlgo: m.signing_algo, signingAddress: m.signing_address },
    tcbStatus: 'UpToDate',
    deployment: { appCompose: m.info.tcb_info.app_compose, runtimeMeasurements: { composeHash: m.info.tcb_info.compose_hash } },
    report: { nonce },
  } as unknown as Awaited<ReturnType<typeof verifyModelAttestation>>;
}

test('attestModel retries a verification Intel let down and does not retry a verdict against the attestation', async () => {
  const sdkFailure = (code: string, retryable: boolean) => new VerificationError({ code, retryable } as VerificationFailure);
  // Each report must travel on its own connection: the gateway picks a replica per connection, so a reused one would show a
  // round the same replica every time and the others' deployments would never be logged.
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('connection'), 'close');
    return new Response(reportBytes);
  }) as unknown as typeof fetch;
  const opts = { baseUrl: 'https://recorded', acceptedTcbStatuses: ['UpToDate'], fetchImpl };

  // Nov 7, Bektur's clean-clone run: two of three dry runs failed on `quote.collateral_unavailable` and the third went
  // through. One such failure must not cost the round: dry-run and --once failed, the daemon waited a minute (RETRY_AFTER_FAILURE_MS).
  let calls = 0;
  const flaky: typeof verifyModelAttestation = async ({ clientBinding }) => {
    calls++;
    if (calls === 1) throw sdkFailure('quote.collateral_unavailable', true);
    return verifiedWithNonce(clientBinding!.nonce);
  };
  const round = await attestModel(model, { ...opts, verify: flaky });
  assert.equal(calls, 2);
  assert.equal(round.keys[0]?.ok, true, 'the retried verification counts');

  // A quote that does not verify is a verdict, not a hiccup: retrying it would only repeat the answer and hide how fast it came.
  calls = 0;
  const refusing: typeof verifyModelAttestation = async () => {
    calls++;
    throw sdkFailure('quote.signature_invalid', false);
  };
  const refused = await attestModel(model, { ...opts, verify: refusing });
  assert.equal(calls, 1);
  assert.equal(refused.keys[0]?.ok, false);
});

test('attestModel: release marks ride in the entry, and a release that cannot be followed never costs the key', async () => {
  const fetchImpl = (async () => new Response(reportBytes)) as unknown as typeof fetch;
  const verify: typeof verifyModelAttestation = async ({ clientBinding }) => verifiedWithNonce(clientBinding!.nonce);
  const opts = { baseUrl: 'https://recorded', acceptedTcbStatuses: ['UpToDate'], fetchImpl, verify };
  const keyOf = async (release?: Parameters<typeof attestModel>[1]['release']) => {
    const key = (await attestModel(model, { ...opts, ...(release ? { release } : {}) })).keys[0];
    assert.ok(key?.ok, 'the key verified');
    return key;
  };
  const plain = await keyOf();
  assert.equal(plain.unmarked, undefined, 'no marker was given, so there is nothing to explain');

  // The marker sees the verified report of the model it is asked about, and its marks follow the image digests.
  const marks = marked({ image_digests: [] }, 156).image_digests;
  const followed = await keyOf(async (m, verified) => {
    assert.deepEqual([m, verified.signer.signingAddress], [model, plain.entry.signing_address]);
    return { marks };
  });
  assert.deepEqual(followed.entry.image_digests, [...plain.entry.image_digests, ...marks]);
  assert.equal(followed.unmarked, undefined);

  // GitHub's rate limit, a check that did not hold, a marker that throws: the entry is the one a verifier always logged.
  const limited = await keyOf(async () => ({ marks: [], why: "GitHub's rate limit is used up" }));
  assert.deepEqual([limited.entry.image_digests, limited.unmarked], [plain.entry.image_digests, "GitHub's rate limit is used up"]);
  const broken = await keyOf(async () => Promise.reject(new Error('socket hang up')));
  assert.deepEqual([broken.entry.image_digests, broken.unmarked], [plain.entry.image_digests, 'socket hang up']);
  // Marks the contract's limits leave no room for are left out, and the line says so.
  const crowded = await keyOf(async () => ({ marks: Array(16).fill(marks[0]) as string[] }));
  assert.deepEqual([crowded.entry.image_digests, crowded.unmarked], [plain.entry.image_digests, 'the marks do not fit the entry']);
});

test('one round logs a key again when the enclave\'s action log has moved, once per state', async () => {
  const reportsDir = `${tmpdir()}/ainek-verifier-marks-${process.pid}`;
  after(() => rmSync(reportsDir, { recursive: true, force: true }));
  const cfg = { ...loadConfig({ VERIFIER_ACCOUNT_ID: 'v1.testnet', VERIFIER_PRIVATE_KEY: 'ed25519:' + '1'.repeat(80), VERIFIER_REPORTS_PER_ROUND: '5' }), reportsDir };
  // Five reports from one replica: the same action log twice, then the enclave deploys, then GitHub stops answering and
  // the release is not followed, then the new state once more.
  const base = entryFromRecording();
  const states = [marked(base, 156), marked(base, 156), marked(base, 157), base, marked(base, 157)];
  let call = 0;
  const attest = async (m: string) => {
    const entry = states[call++]!;
    return { model: m, nonce: 'n', reportBytes: new Uint8Array([call]), reportHash: `marks-${call}`, keys: [{ ok: true as const, verified: { gpuEvidence: 'verified' } as AttestedKey extends { verified: infer V } ? V : never, entry, ...(entry === base ? { unmarked: "GitHub's rate limit is used up" } : {}) }] };
  };
  const sent: string[][] = [];
  const writer: KeyLogWriter = { recentByMe: async () => [], logKey: async (e) => (sent.push(e.image_digests), { index: sent.length, txHash: `tx${sent.length}` }) };
  const lines: string[] = [];
  const results = await runRound(cfg, writer, (l) => lines.push(l), attest);
  assert.deepEqual(results.map((r) => r.outcome), ['logged', 'current', 'logged', 'current', 'current']);
  assert.deepEqual(sent, [states[0]!.image_digests, states[2]!.image_digests], 'each state of the action log is sent once; the unmarked entry adds nothing');
  assert.equal(lines.filter((l) => /release checked, action log of 15[67] actions marked/.test(l)).length, 4);
  assert.ok(lines.some((l) => new RegExp(`${base.image_digests.length} image digest\\(s\\); release not marked: GitHub's rate limit is used up`).test(l)), 'the digests are counted without the marks, and the reason is said');
});
