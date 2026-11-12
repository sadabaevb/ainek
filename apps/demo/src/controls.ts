// `pnpm demo:controls`: negative controls on the recorded evidence. Offline, no API key.
//
// `pnpm demo` shows the recording passing. This shows what must not pass: each control changes one thing in that same
// recording and runs the same check, and the check has to refuse. A change that is accepted fails this command.
// The checks are the SDK's (quote, policy, bindings, event log, action log) and ours (key log, proof); Intel's collateral
// and NVIDIA's verdict come from the recording, as in the replay.
//
// The headings are the six obligations of Private Inference Beat, in its order (docs/ASSESSMENT.md answers each in
// words). Not every obligation has a control that can run offline. Where it cannot, the line says where the control is:
// the reply key is refused by the service, so its control is a live run whose recording is printed; the release behind
// the key is read from GitHub, so its controls are unit tests against a fake one.
import { existsSync } from 'node:fs';
import { verifyModelAttestation, type ModelAttestation, type TcbStatus } from '@nearai/inference-sdk/node';
import { DEMO_SWAPPED_KEY, DEMO_UNKNOWN_COMPOSE, ainekConfigFromEnv, composeHashOf, evaluateKeyLog, sha256Hex, verifyModelProof, type KeyEntry, type ModelProof } from '@ainek/proof';
import { loadRecording, readJson, samplesDir } from './evidence.ts';
import { toModelAttestation } from './report.ts';
import { FAIL, NA, OK, describe, head, line } from './term.ts';
import { createRecordedGpuVerifier, createRecordedTdxVerifier } from './verifiers.ts';

const cfg = ainekConfigFromEnv({ ...process.env, AINEK_LOG_SOURCE: 'sample' });
const rec = loadRecording();
const raw = rec.report.model_attestations[0];
if (!raw) throw new Error('recording has no model attestation');
const recorded: ModelAttestation = toModelAttestation(raw);
const exchange = rec.exchanges.find((x) => x.proof.e2ee) ?? rec.exchanges[0];
if (!exchange) throw new Error('recording has no exchanges');
const at = new Date(rec.manifest.nras.iat * 1000);

interface Changed {
  attestation?: ModelAttestation;
  /** The nonce the client says it sent. */
  nonce?: string;
  acceptedTcb?: TcbStatus[];
  /** Intel's recorded collateral is keyed by quote: a changed quote is checked against the collateral of this, the original. */
  collateralOf?: string;
}
/** The SDK's verification of the recorded model report with one thing changed. Resolves when the report is accepted. */
async function verifyReport({ attestation = recorded, nonce = recorded.nonce, acceptedTcb = ['UpToDate'], collateralOf }: Changed = {}): Promise<void> {
  const collateral = collateralOf ? { ...rec.collateralByQuote, [sha256Hex(attestation.intelQuote)]: rec.collateralByQuote[sha256Hex(collateralOf)] } : rec.collateralByQuote;
  await verifyModelAttestation({
    attestation,
    clientBinding: { nonce },
    policy: { acceptedTcbStatuses: acceptedTcb, gpuEvidence: 'required' },
    verifiers: { tdxQuote: createRecordedTdxVerifier(collateral, rec.manifest.nowSecs), gpuEvidence: createRecordedGpuVerifier(rec.nrasResponse, rec.jwks, at, () => undefined) },
  });
}
/** A changed report, as a control: undefined when it was accepted; the SDK's refusal is thrown. */
const report = (change: Changed) => async (): Promise<undefined> => {
  await verifyReport(change);
  return undefined;
};
/** The log check before sending, as a control: undefined when the key would be sent to. */
const logCheck = (signingAddress: string, composeHash?: string) => (): string | undefined => {
  const verdict = evaluateKeyLog([rec.logEntry], { model: raw.model_name, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum, signingAddress, composeHash });
  return verdict.status === 'ok' ? undefined : `nothing is sent: ${verdict.detail}`;
};
/** Our check of the recorded proof with one thing changed, as a control: undefined when the proof still passes. */
const proofCheck =
  (proof: ModelProof = exchange.proof, response: Uint8Array = exchange.rawResponse, entry: KeyEntry | null = rec.logEntry) =>
  (): string | undefined => {
    const failed = verifyModelProof(proof, exchange.rawRequest, response, entry).checks.filter((c) => c.status === 'fail');
    // The first failed check is the change; a changed proof also stops matching its commit, which says nothing more.
    return failed[0] ? `${failed[0].id}: ${failed[0].detail}` : undefined;
  };

let run = 0;
let accepted = 0;
/** One control: `attempt` must end in a refusal, returned as words or thrown. Undefined means the change was accepted. */
async function control(what: string, attempt: () => Promise<string | undefined> | string | undefined): Promise<void> {
  run += 1;
  let refusal: string | undefined;
  try {
    refusal = await attempt();
  } catch (err) {
    refusal = describe(err);
  }
  if (refusal === undefined) accepted += 1;
  line(refusal === undefined ? FAIL : OK, refusal === undefined ? `${what} → ACCEPTED: this change must be refused` : `${what} → refused: ${refusal}`);
}

console.log(`Ainek negative controls: recording of ${rec.manifest.reportCapturedAt.slice(0, 10)}. Offline, no API key.`);
console.log('Each line changes one thing in the evidence `pnpm demo` accepts. Every one of them has to be refused.');

// Unchanged, everything passes. Without this a refusal below could come from a broken recording, not from the change.
head('0. Unchanged: the same checks on the recording as it is');
const attestedKey = recorded.signer.signingAddress;
const attestedLauncher = composeHashOf(recorded);
let baseline = true;
for (const [what, unchanged] of [
  ['the model report', report({})],
  ['the key and its launcher, looked up in the log entry', logCheck(attestedKey, attestedLauncher)],
  ['the proof of the recorded exchange', proofCheck()],
] as const) {
  let refusal: string | undefined;
  try {
    refusal = await unchanged();
  } catch (err) {
    refusal = describe(err);
  }
  if (refusal !== undefined) baseline = false;
  line(refusal === undefined ? OK : FAIL, refusal === undefined ? `${what}: accepted` : `${what}: not accepted, so the controls show nothing: ${refusal}`);
}

head('1. Hardware: is the platform evidence authentic and inside the policy?');
// A byte inside the quoted TD report (offset 200 of the quote, in the measurements): the quote's signature no longer covers it.
const flipped = `${recorded.intelQuote.slice(0, 400)}${recorded.intelQuote[400] === '0' ? '1' : '0'}${recorded.intelQuote.slice(401)}`;
await control('one byte of the TDX quote changed', report({ attestation: { ...recorded, intelQuote: flipped }, collateralOf: recorded.intelQuote }));
await control('a policy that does not accept the TCB status the quote has', report({ acceptedTcb: ['OutOfDate'] }));
const { nvidiaPayload: _gpu, ...withoutGpu } = recorded;
await control('the NVIDIA GPU evidence removed from the report', report({ attestation: withoutGpu }));

head('2. Session: are the recipient, the reply key and the freshness bound to this exchange?');
await control('a report replayed for another nonce than the client sent', report({ nonce: 'ef'.repeat(32) }));
await control('another signing key than the one the quote binds', report({ attestation: { ...recorded, signer: { ...recorded.signer, signingAddress: DEMO_SWAPPED_KEY }, signingPublicKey: DEMO_SWAPPED_KEY } }));
await control('a key no trusted verifier logged', logCheck(DEMO_SWAPPED_KEY));
const replyKey = existsSync(new URL('reply-key-control.json', samplesDir)) ? readJson<{ recordedAt: string; verdict?: string; swapped?: { status?: number } }>('reply-key-control.json') : undefined;
line(NA, `the reply key swapped in transit: the refusal is the service's, so this is a live control (pnpm demo:reply-key). ${replyKey ? `Recorded ${replyKey.recordedAt.slice(0, 10)}: ${replyKey.verdict ?? 'no verdict'}, HTTP ${replyKey.swapped?.status ?? '?'}` : 'No recording in docs/samples'}`);

head('3. Code: does what was measured match what is shown?');
await control('one character added to the app compose', report({ attestation: { ...recorded, appCompose: `${recorded.appCompose} ` } }));
// An event the quote's RTMR3 does not hold, here a second `compose-hash`: what a hop could add to the log it forwards.
const events: readonly unknown[] = typeof recorded.eventLog === 'string' ? (JSON.parse(recorded.eventLog) as unknown[]) : recorded.eventLog;
await control('an event added to the RTMR3 event log', report({ attestation: { ...recorded, eventLog: [...events, { imr: 3, event_type: 0x08000001, digest: '', event: 'compose-hash', event_payload: DEMO_UNKNOWN_COMPOSE }] } }));
const manager = recorded.composeManagerAttestation;
if (manager && manager.actions.length > 0) await control("the last action removed from the enclave's action log", report({ attestation: { ...recorded, composeManagerAttestation: { ...manager, actions: manager.actions.slice(0, -1) } } }));
else line(NA, 'this recording carries no action log to edit');
line(NA, 'the release behind the key (a file that does not match, a moved or missing tag, an image with no build proof, the log of another replica): read from GitHub, so controlled by unit tests against a fake one (pnpm test, release.test.ts)');

head('4. Operator access: what can the operator change outside the measurement?');
line(NA, 'no control: Ainek constrains nothing here. pnpm demo:attest prints the settings of the measured launcher it can read (the manager image, the minimum tag age)');

head('5. Downstream: is the answer the one this key signed, for this request?');
const tampered = new Uint8Array(exchange.rawResponse);
tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 0x01;
await control('one bit of the response changed', proofCheck(exchange.proof, tampered));
await control('the signature presented under another key', proofCheck({ ...exchange.proof, signingAddress: DEMO_SWAPPED_KEY }));
await control('an answer signed by the gateway, not by the model enclave', proofCheck({ ...exchange.proof, signatureKind: 'gateway' }));
await control('a proof whose key is not in the log', proofCheck(exchange.proof, exchange.rawResponse, null));

head('6. Updates: is a change nobody approved refused?');
await control('the right key, logged with another launcher than the one attested', logCheck(attestedKey, DEMO_UNKNOWN_COMPOSE));
line(NA, 'a new release of the serving containers behind the same launcher: not refused today. The client does not read the action log yet (README, "What we do not claim")');

console.log(`\nResult: ${!baseline ? 'NOT RUN. The recording does not pass unchanged.' : accepted === 0 ? `REFUSED. ${run} of ${run} changes were refused.` : `${accepted} of ${run} changes were ACCEPTED.`}`);
process.exit(baseline && accepted === 0 ? 0 : 1);
