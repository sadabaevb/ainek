// Offline tests: the decision logic around attestation, with the recorded report from docs/samples standing in
// for the network. The SDK's verification itself is exercised by `pnpm demo` (replay) and by the live run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildKeyEntryInput, type KeyEntry, type RawReport } from '@ainek/proof';
import { selectModelAttestation } from './attest.ts';
import { loadConfig } from './config.ts';
import { alreadyLogged } from './log.ts';

const samples = new URL('../../../docs/samples/', import.meta.url);
const reportBytes = readFileSync(new URL('attestation-report.json', samples));
const raw = JSON.parse(reportBytes.toString('utf8')) as RawReport;
const sampleEntry = (JSON.parse(readFileSync(new URL('key-entry.sample.json', samples), 'utf8')) as { entry?: KeyEntry } & KeyEntry);
const logged: KeyEntry = sampleEntry.entry ?? sampleEntry;

/** The entry the daemon would build from the recorded report, if the SDK had verified it (structural evidence only). */
function entryFromRecording() {
  const m = selectModelAttestation(raw, raw.model_attestations[0]!.model_name);
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

test('selectModelAttestation picks the entry for the model that carries an E2EE key', () => {
  const model = raw.model_attestations[0]!.model_name;
  const m = selectModelAttestation(raw, model);
  assert.equal(m.model_name, model);
  assert.ok(m.signing_public_key, 'the pinned key must be the quote-bound E2EE key');
  assert.throws(() => selectModelAttestation(raw, 'nobody/such-model'), /no model_attestations/);
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
  assert.match(entry.report_hash, /^[0-9a-f]{64}$/);
  assert.equal(entry.report_hash, createHash('sha256').update(reportBytes).digest('hex'));
});

test('loadConfig refuses to start without the verifier account and key', () => {
  assert.throws(() => loadConfig({ AINEK_CONTRACT: 'x.testnet' }), /VERIFIER_ACCOUNT_ID and VERIFIER_PRIVATE_KEY/);
  const cfg = loadConfig({ VERIFIER_ACCOUNT_ID: 'v1.testnet', VERIFIER_PRIVATE_KEY: 'ed25519:' + '1'.repeat(80), VERIFIER_MODELS: 'a/b, c/d' });
  assert.deepEqual(cfg.models, ['a/b', 'c/d']);
  assert.equal(cfg.intervalMs, 15 * 60_000);
});
