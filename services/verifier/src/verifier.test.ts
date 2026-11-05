// Offline tests: the decision logic around attestation, with the recorded report from docs/samples standing in
// for the network. The SDK's verification itself is exercised by `pnpm demo` (replay) and by the live run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildKeyEntryInput, type KeyEntry, type RawReport } from '@ainek/proof';
import { selectModelAttestations } from './attest.ts';
import { MAX_INTERVAL_MIN, loadConfig } from './config.ts';
import { alreadyLogged, parseLoggedIndex } from './log.ts';

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
});
