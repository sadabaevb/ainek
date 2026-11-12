// The negative controls on the recorded evidence, as a table: `pnpm demo:controls` narrates it and controls.test.ts
// asserts it, so the command and the test cannot say different things.
//
// Each control changes one thing in the recording `pnpm demo` accepts and runs the same check. It passes only when the
// check refuses, and for the reason the control is about (`expect`, a piece of the refusal: an SDK error code or the name
// of our failed check). A refusal for another reason would mean the change was never looked at.
//
// The checks are the SDK's (quote, policy, bindings, event log, action log), fed from the recording exactly as the
// replay feeds them, and ours (key log, proof). The headings are the six obligations of Private Inference Beat, in its
// order; docs/ASSESSMENT.md answers each in words. A `note` is a line that is not a control: it says where the control
// for that part is, or that there is none.
import { createHash } from 'node:crypto';
import type { ModelAttestation } from '@nearai/inference-sdk/node';
import { DEMO_SWAPPED_KEY, DEMO_UNKNOWN_COMPOSE, ainekConfigFromEnv, composeHashOf, evaluateKeyLog, verifyModelProof, type KeyEntry, type ModelProof } from '@ainek/proof';
import { loadReplyKeyControl, type Recording } from './evidence.ts';
import { toModelAttestation } from './report.ts';
import { describe } from './term.ts';
import { verifyRecordedModelReport, type RecordedCheck } from './verifiers.ts';

export const HEADINGS = [
  'Hardware: is the platform evidence authentic and inside the policy?',
  'Session: are the recipient, the reply key and the freshness bound to this exchange?',
  'Code: does what was measured match what is shown?',
  'Operator access: what can the operator change outside the measurement?',
  'Downstream: is the answer the one this key signed, for this request?',
  'Updates: is a change nobody approved refused?',
] as const;

/** What a check said: undefined when it accepted, the words of its refusal otherwise (returned or thrown). */
type Attempt = () => Promise<string | undefined> | string | undefined;
export interface Control {
  /** Index into `HEADINGS`. */
  heading: number;
  what: string;
  /** A piece of the refusal this control must end in. */
  expect: string;
  attempt: Attempt;
}
export interface Note {
  heading: number;
  note: string;
}
export type Row = Control | Note;

/** Runs a check and returns its refusal, or undefined when it accepted. An SDK error is shown with what caused it. */
export async function refusalOf(attempt: Attempt): Promise<string | undefined> {
  try {
    return await attempt();
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${describe(err)}${cause}`;
  }
}

/** dstack's runtime event type, and the digest it extends RTMR3 with: sha384(type ‖ ":" ‖ name ‖ ":" ‖ payload). */
const RUNTIME_EVENT = 0x08000001;
function runtimeEvent(event: string, payloadHex: string): { imr: number; event_type: number; digest: string; event: string; event_payload: string } {
  const type = Buffer.alloc(4);
  type.writeUInt32LE(RUNTIME_EVENT);
  const digest = createHash('sha384').update(Buffer.concat([type, Buffer.from(':'), Buffer.from(event), Buffer.from(':'), Buffer.from(payloadHex, 'hex')])).digest('hex');
  return { imr: 3, event_type: RUNTIME_EVENT, digest, event, event_payload: payloadHex };
}

/** The hex digit of byte 200 of the quote: past the 48-byte header, inside the TD report's MRTD, which the quote's signature covers. */
const QUOTE_FLIP_AT = 2 * 200;

/** The unchanged checks, which must accept, and the controls with the notes between them, in the order they are printed. */
export function controlSet(rec: Recording): { unchanged: { what: string; attempt: Attempt }[]; rows: Row[] } {
  const raw = rec.report.model_attestations[0];
  const exchange = rec.exchanges.find((x) => x.proof.e2ee) ?? rec.exchanges[0];
  if (!raw || !exchange) throw new Error('the recording has no model attestation or no exchange');
  const recorded: ModelAttestation = toModelAttestation(raw);
  // The sample world's trust set and quorum, whatever the shell exports: a control must not depend on the environment.
  const cfg = ainekConfigFromEnv({ AINEK_LOG_SOURCE: 'sample' });

  const report = (attestation: ModelAttestation, check: RecordedCheck = {}): Attempt => async () => {
    await verifyRecordedModelReport(rec, attestation, check);
    return undefined;
  };
  const logCheck = (signingAddress: string, composeHash?: string): Attempt => () => {
    const verdict = evaluateKeyLog([rec.logEntry], { model: raw.model_name, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum, signingAddress, composeHash });
    return verdict.status === 'ok' ? undefined : `nothing is sent: ${verdict.detail}`;
  };
  const proofCheck = (proof: ModelProof = exchange.proof, response: Uint8Array = exchange.rawResponse, entry: KeyEntry | null = rec.logEntry): Attempt => () => {
    // The first failed check is the change; a changed proof also stops matching its commit, which says nothing more.
    const failed = verifyModelProof(proof, exchange.rawRequest, response, entry).checks.find((c) => c.status === 'fail');
    return failed ? `${failed.id}: ${failed.detail}` : undefined;
  };

  const quote = recorded.intelQuote;
  const flippedQuote = `${quote.slice(0, QUOTE_FLIP_AT)}${quote[QUOTE_FLIP_AT] === '0' ? '1' : '0'}${quote.slice(QUOTE_FLIP_AT + 1)}`;
  const { nvidiaPayload: _gpu, ...withoutGpu } = recorded;
  const events: readonly unknown[] = typeof recorded.eventLog === 'string' ? (JSON.parse(recorded.eventLog) as unknown[]) : recorded.eventLog;
  const manager = recorded.composeManagerAttestation;
  const tampered = new Uint8Array(exchange.rawResponse);
  tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 0x01;
  const replyKey = loadReplyKeyControl();
  const otherNonce = 'ef'.repeat(32);

  return {
    unchanged: [
      { what: 'the model report', attempt: report(recorded) },
      { what: 'the model report without its GPU evidence, when the policy does not ask for it', attempt: report(withoutGpu, { gpuEvidence: 'if-present' }) },
      { what: 'the key and its launcher, looked up in the log entry', attempt: logCheck(recorded.signer.signingAddress, composeHashOf(recorded)) },
      { what: 'the proof of the recorded exchange', attempt: proofCheck() },
    ],
    rows: [
      { heading: 0, what: 'one byte of the TDX quote changed', expect: 'quote.verification_failed', attempt: report({ ...recorded, intelQuote: flippedQuote }) },
      { heading: 0, what: 'a policy that does not accept the TCB status the quote has', expect: 'policy.tcb_status_not_allowed', attempt: report(recorded, { acceptedTcb: ['OutOfDate'] }) },
      { heading: 0, what: 'the NVIDIA GPU evidence removed from the report', expect: 'policy.gpu_evidence_required', attempt: report(withoutGpu) },

      { heading: 1, what: 'a report served again to a client that sent another nonce', expect: 'binding.nonce_mismatch', attempt: report(recorded, { nonce: otherNonce }) },
      // The replay a server would try: the old quote under a report that names the new nonce. Only the quote can refuse
      // it, so the GPU evidence, which carries the old nonce too, is set aside.
      { heading: 1, what: 'an old quote under a report that names the new nonce', expect: 'binding.nonce_mismatch', attempt: report({ ...withoutGpu, nonce: otherNonce }, { nonce: otherNonce, gpuEvidence: 'if-present' }) },
      { heading: 1, what: 'another signing key than the one the quote binds', expect: 'binding.report_data_mismatch', attempt: report({ ...recorded, signer: { ...recorded.signer, signingAddress: DEMO_SWAPPED_KEY }, signingPublicKey: DEMO_SWAPPED_KEY }) },
      { heading: 1, what: 'a key no trusted verifier logged', expect: 'is not in the public log', attempt: logCheck(DEMO_SWAPPED_KEY) },
      { heading: 1, note: `the reply key swapped in transit: the refusal is the service's, so its control is a live run (pnpm demo:reply-key), not made here. ${replyKey ? `As recorded on ${replyKey.recordedAt.slice(0, 10)}: ${replyKey.verdict}, HTTP ${replyKey.swapped?.status ?? '?'}` : 'docs/samples holds no recording of one'}` },

      { heading: 2, what: 'one character added to the app compose', expect: 'measurement.app_compose_mrconfigid_mismatch', attempt: report({ ...recorded, appCompose: `${recorded.appCompose} ` }) },
      // A well-formed event the quote's RTMR3 does not hold, here a second `compose-hash`: what a hop could add to the log it forwards.
      { heading: 2, what: 'an event added to the RTMR3 event log', expect: 'measurement.rtmr3_mismatch', attempt: report({ ...recorded, eventLog: [...events, runtimeEvent('compose-hash', DEMO_UNKNOWN_COMPOSE)] }) },
      manager && manager.actions.length > 0
        ? { heading: 2, what: "the last action removed from the enclave's action log", expect: 'binding.compose_manager_actions_mismatch', attempt: report({ ...recorded, composeManagerAttestation: { ...manager, actions: manager.actions.slice(0, -1) } }) }
        : { heading: 2, note: 'this recording carries no action log to edit' },
      { heading: 2, note: 'the release behind the key (a file that does not match, a moved or missing tag, an image with no build proof, the log of another replica): read from GitHub, so its controls are unit tests against a fake one (pnpm test, release.test.ts)' },

      { heading: 3, note: 'no control: Ainek constrains nothing here. pnpm demo:attest prints the settings of the measured launcher it can read (the manager image, the minimum tag age)' },

      { heading: 4, what: 'one bit of the response changed', expect: 'response-hash', attempt: proofCheck(exchange.proof, tampered) },
      { heading: 4, what: 'the signature presented under another key', expect: 'signature:', attempt: proofCheck({ ...exchange.proof, signingAddress: DEMO_SWAPPED_KEY }) },
      { heading: 4, what: 'an answer signed by the gateway, not by the model enclave', expect: 'route:', attempt: proofCheck({ ...exchange.proof, signatureKind: 'gateway' }) },
      { heading: 4, what: 'a proof whose key is not in the log', expect: 'key-in-log', attempt: proofCheck(exchange.proof, exchange.rawResponse, null) },

      { heading: 5, what: 'the right key, logged with another launcher than the one attested', expect: 'but not with deployment', attempt: logCheck(recorded.signer.signingAddress, DEMO_UNKNOWN_COMPOSE) },
      { heading: 5, note: 'a new release of the serving containers behind the same launcher: not refused today. The client does not read the action log yet (README, "What we do not claim")' },
    ],
  };
}
