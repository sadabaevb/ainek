// `pnpm demo` (replay): re-verify the recorded NEAR AI evidence offline, apply the fail-closed log rule,
// re-check the signed response and print the proof card. No API key, no network.
// `pnpm demo:tamper`: same recording, but the key the client sees is swapped → the client must refuse.
import {
  verifyGatewayAttestation,
  verifyModelAttestation,
  verifyModelResponse,
  type VerifiedModelAttestation,
} from '@nearai/inference-sdk/node';
import { evaluateKeyLog, shortHex as short, verifyModelProof, type KeyEntry } from '@ainek/proof';
import { loadRecording } from './evidence.ts';
import { FAIL, NA, OK, describe, head, markOf, line as say } from './term.ts';
import { toGatewayAttestation, toModelAttestation } from './report.ts';
import { createRecordedGpuVerifier, createRecordedTdxVerifier, type RecordedGpuVerdict } from './verifiers.ts';

const TRUSTED_VERIFIERS = ['v1.ainek.testnet', 'v2.ainek.testnet', 'v3.ainek.testnet'];
const QUORUM = 1; // demo; production clients use 2
const tamper = process.argv.includes('--tamper');

let failures = 0;
function line(mark: string, text: string): void { if (say(mark, text)) failures += 1; }

const rec = loadRecording();
const model = rec.report.model_attestations[0];
if (!model) throw new Error('recording has no model attestation');
const at = new Date(rec.manifest.nras.iat * 1000);

console.log(`Ainek replay${tamper ? ' (tamper)' : ''}: recording of ${rec.manifest.reportCapturedAt.slice(0, 10)}, evidence recorded ${rec.manifest.evidenceRecordedAt.slice(0, 10)}. Offline, no API key.`);

// 1. Model attestation: the SDK's own verification, fed from the recording instead of Intel/NVIDIA.
head(`1. Model attestation: ${model.model_name}`);
let gpu: RecordedGpuVerdict | null = null;
let verifiedModel: VerifiedModelAttestation | null = null;
try {
  verifiedModel = await verifyModelAttestation({
    attestation: toModelAttestation(model),
    clientBinding: { nonce: model.request_nonce },
    policy: { acceptedTcbStatuses: ['UpToDate'], gpuEvidence: 'required' },
    verifiers: {
      tdxQuote: createRecordedTdxVerifier(rec.collateralByQuote, rec.manifest.nowSecs),
      gpuEvidence: createRecordedGpuVerifier(rec.nrasResponse, rec.jwks, at, (v) => { gpu = v; }),
    },
  });
  const g = gpu as RecordedGpuVerdict | null;
  line(OK, `Intel TDX quote verified with recorded collateral (evaluated at ${rec.manifest.evidenceRecordedAt.slice(0, 16)}Z): TCB ${verifiedModel.tcbStatus}, advisories ${verifiedModel.advisoryIds.length === 0 ? 'none' : verifiedModel.advisoryIds.join(',')}, debug off`);
  line(OK, `nonce ${short(model.request_nonce)} and signing key ${short(verifiedModel.signer.signingAddress)} bound in the TDX report data`);
  line(OK, `app_compose matches MRCONFIGID, RTMR3 event log replayed: compose ${short(verifiedModel.deployment.runtimeMeasurements.composeHash ?? '')}`);
  line(OK, `NVIDIA GPU evidence: NRAS verdict signed by NVIDIA key ${g ? g.kid.slice(0, 24) : '?'}…, nonce matches, overall result true${g ? `, ${g.hwmodel} ×${g.gpus}` : ''}`);
  line(verifiedModel.deployment.composeManager ? OK : NA, verifiedModel.deployment.composeManager ? 'compose manager attestation (deployment actions) verified' : 'no compose manager attestation in this report');
  line(NA, `freshness not re-checked: this is a recording (NRAS token issued ${at.toISOString().slice(0, 16)}Z); live mode re-attests with a fresh nonce`);
} catch (err) {
  line(FAIL, `model attestation failed: ${describe(err)}`);
}

// 2. Gateway attestation.
head('2. Gateway attestation: cloud-api.near.ai');
try {
  const gw = await verifyGatewayAttestation({
    attestation: toGatewayAttestation(rec.report.gateway_attestation),
    clientBinding: { nonce: rec.report.gateway_attestation.request_nonce },
    policy: { acceptedTcbStatuses: ['UpToDate'] },
    verifiers: { tdxQuote: createRecordedTdxVerifier(rec.collateralByQuote, rec.manifest.nowSecs) },
  });
  line(OK, `Intel TDX quote verified: TCB ${gw.tcbStatus}, signer ${short(gw.signer.signingAddress)}`);
  line(NA, `TLS binding: ${gw.tlsBinding.kind} (the TLS peer of a recorded request cannot be re-observed)`);
} catch (err) {
  line(FAIL, `gateway attestation failed: ${describe(err)}`);
}

// 3. Fail-closed: is the attested key in the public log?
head('3. Public key log (fail-closed check before sending)');
const entries: KeyEntry[] = [rec.logEntry];
const attestedKey = verifiedModel?.signer.signingAddress ?? model.signing_address;
const seenKey = tamper ? 'ab'.repeat(32) : attestedKey;
if (tamper) line(NA, `tamper mode: the client is shown key ${short(seenKey)} instead of the attested ${short(attestedKey)}`);
line(NA, `log source: docs/samples/key-entry.sample.json (sample entry; the live demo reads latest_keys on ainek.testnet)`);
const verdict = evaluateKeyLog(entries, {
  model: model.model_name,
  signingAddress: seenKey,
  trustedVerifiers: TRUSTED_VERIFIERS,
  quorum: QUORUM,
  ...(verifiedModel?.deployment.runtimeMeasurements.composeHash === undefined ? {} : { composeHash: verifiedModel.deployment.runtimeMeasurements.composeHash }),
});
if (verdict.status === 'ok') {
  const e = verdict.matching[0] as KeyEntry;
  line(OK, `key #${e.index} logged by ${verdict.confirmedBy.join(', ')} (quorum ${QUORUM} of trusted ${TRUSTED_VERIFIERS.join(', ')}), TCB ${e.tcb_status}`);
} else {
  line(FAIL, verdict.detail);
  console.log(`\nResult: REFUSED. ${tamper ? 'The swapped key never reached the model: this is the fail-closed behaviour the demo is meant to show.' : 'Nothing was sent.'}`);
  process.exit(tamper ? 0 : 1);
}

// 4. The signed responses, two independent checks each: the SDK's byte-exact check, then our proof re-verification.
head(`4. Signed responses (${rec.exchanges.length} recorded exchanges)`);
const results = rec.exchanges.map((x) => {
  console.log(`  ${x.label}${x.plaintext ? `: ${JSON.stringify(x.plaintext.prompt)} → ${JSON.stringify(x.plaintext.reply)} (plaintext as decrypted by the recording client; the proof covers the ciphertext)` : ''}`);
  try {
    if (!verifiedModel) throw new Error('no verified model attestation to compare the signer with');
    verifyModelResponse({
      requestBody: x.rawRequest,
      responseBody: x.rawResponse,
      signature: { kind: x.signature.signature_kind, signer: { signingAlgo: x.signature.signing_algo, signingAddress: x.signature.signing_address }, signedText: x.signature.text, signature: x.signature.signature },
      attestation: verifiedModel,
    });
    line(OK, `SDK: signature over sha256(request bytes), sha256(response bytes) verifies under the attested model signer (${x.signature.signature_kind})`);
  } catch (err) {
    line(FAIL, `SDK response check failed: ${describe(err)}`);
  }
  const report = verifyModelProof(x.proof, x.rawRequest, x.rawResponse, rec.logEntry);
  for (const c of report.checks) line(markOf(c.status), `proof.${c.id}: ${c.detail}`);
  return { exchange: x, report };
});
const shown = results.find((r) => r.exchange.proof.e2ee) ?? results[0];
if (!shown) throw new Error('recording has no exchanges');
const { exchange: e2ee, report } = shown;

// 5. The card a person sees.
const composeHash = verifiedModel?.deployment.runtimeMeasurements.composeHash ?? model.info.tcb_info.compose_hash;
const g = gpu as RecordedGpuVerdict | null;
console.log('\n┌─ Ainek proof card ─ replay ─────────────────────────────────────────');
console.log(`│ ${verifiedModel ? OK : FAIL} Model: ${model.model_name}, attested deployment (compose ${short(composeHash)})`);
console.log(`│ ${verifiedModel ? OK : FAIL} Hardware: Intel TDX ${verifiedModel?.tcbStatus ?? '?'}, NVIDIA ${g?.hwmodel ?? '?'} ×${g?.gpus ?? '?'} verified via NRAS. Re-verified offline from the recording.`);
console.log(`│ ${OK} Key #${rec.logEntry.index} in the public log, logged by ${rec.logEntry.verifier} (sample entry)`);
console.log(`│ ${results.every((r) => r.report.ok) ? OK : FAIL} Request and response: hashes match the signature made inside the model TEE (${e2ee.proof.signatureKind}; ${rec.exchanges.length} exchanges checked)`);
console.log(`│ ${e2ee.proof.e2ee ? OK : NA} End-to-end encryption: ${e2ee.proof.e2ee ? 'yes, encrypted to the attested model key (recorded exchange; plaintext not covered by the proof)' : 'not in this recording'}`);
console.log(`│ ${NA} On NEAR: commit ${short(e2ee.proof.commit ?? '')} (sample salt, not committed yet)`);
console.log(`└─ Result: ${failures === 0 ? 'VERIFIED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
