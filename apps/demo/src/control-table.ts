// The negative controls on the recorded evidence, as a table: `pnpm demo:controls` narrates it and controls.test.ts
// asserts it, through one `judge`, so the command and the test cannot say different things.
//
// Each control changes one thing in the recording `pnpm demo` accepts and runs the same check. It holds only when the
// check refuses with the code the control expects: an SDK error code, the reason of our log check, or the id of our
// failed proof check. Where one code covers more than the change (the SDK has one code for every quote failure and one
// for every nonce), the control also names a piece of the refusal's words. A refusal for another reason means the change
// was never looked at, and an exception that is not a refusal is a bug here: neither counts.
//
// The checks are the SDK's (quote, policy, bindings, event log, action log), fed from the recording as the replay feeds
// them, and ours (key log, proof). The headings are the six obligations of Private Inference Beat, in its order;
// docs/ASSESSMENT.md answers each in words. A note is a line that is not a control: it says where the control for that
// part is, or that there is none.
import { createHash } from 'node:crypto';
import { getSdkError, type ModelAttestation } from '@nearai/inference-sdk/node';
import { DEMO_SWAPPED_KEY, DEMO_UNKNOWN_COMPOSE, ainekConfigFromEnv, composeHashOf, evaluateKeyLog, sha256Hex, verifyModelProof, type KeyEntry, type ModelProof } from '@ainek/proof';
import { loadReplyKeyControl, type Recording, type ReplyKeyControl } from './evidence.ts';
import { toModelAttestation } from './report.ts';
import { verifyRecordedModelReport, type RecordedCheck } from './verifiers.ts';

export const HEADINGS = [
  'Hardware: is the platform evidence authentic and inside the policy?',
  'Session: are the recipient, the reply key and the freshness bound to this exchange?',
  'Code: does what was measured match what is shown?',
  'Operator access: what can the operator change outside the measurement?',
  'Downstream: is the answer the one this key signed, for this request?',
  'Updates: is a change nobody approved refused?',
] as const;

/** A check refusing: `code` names what refused, `detail` is its words. */
export interface Refusal {
  code: string;
  detail: string;
}
/** A check on the recording, changed or not: undefined when it accepted. It throws only when it could not be made. */
type Attempt = () => Promise<Refusal | undefined> | Refusal | undefined;
export interface Control {
  /** Index into `HEADINGS`. */
  heading: number;
  what: string;
  /** The code the refusal must carry. */
  expect: string;
  /** A piece its words must also contain, where the code covers more than this change. */
  because?: string;
  attempt: Attempt;
}
export interface Note {
  heading: number;
  note: string;
  /** Set when the note reports something that should not be: it fails the run like a control that did not hold. */
  failed?: true;
}
export type Row = Control | Note;

/** Runs one control. It held when the check refused, with the expected code and words. */
export async function judge(control: Control): Promise<{ held: boolean; refusal: Refusal | undefined }> {
  const refusal = await control.attempt();
  const held = refusal !== undefined && refusal.code === control.expect && (control.because === undefined || refusal.detail.includes(control.because));
  return { held, refusal };
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

/** The live reply-key control as the repository records it. A recording that does not say REFUSED is not a neutral line. */
function replyKeyNote(heading: number): Note {
  const live = "the reply key swapped in transit: the refusal is the service's, so its control is a live run (pnpm demo:reply-key), not made here.";
  let recorded: Partial<ReplyKeyControl> | undefined;
  try {
    recorded = loadReplyKeyControl();
  } catch {
    return { heading, note: `${live} docs/samples holds a recording of one that cannot be read`, failed: true };
  }
  if (!recorded) return { heading, note: `${live} docs/samples holds no recording of one` };
  const when = typeof recorded.recordedAt === 'string' ? recorded.recordedAt.slice(0, 10) : 'an unknown day';
  const note = `${live} As recorded on ${when}: ${recorded.verdict ?? 'no verdict'}${typeof recorded.swapped?.status === 'number' ? `, HTTP ${recorded.swapped.status}` : ''}`;
  return recorded.verdict === 'REFUSED' ? { heading, note } : { heading, note, failed: true };
}

/** The unchanged checks, which must accept, and the controls with the notes between them, in the order they are printed. */
export function controlSet(rec: Recording): { unchanged: { what: string; attempt: Attempt }[]; rows: Row[] } {
  const raw = rec.report.model_attestations[0];
  const exchange = rec.exchanges.find((x) => x.proof.e2ee) ?? rec.exchanges[0];
  if (!raw || !exchange) throw new Error('the recording has no model attestation or no exchange');
  const recorded: ModelAttestation = toModelAttestation(raw);
  // The sample world's trust set and quorum, whatever the shell exports: a control must not depend on the environment.
  const cfg = ainekConfigFromEnv({ AINEK_LOG_SOURCE: 'sample' });

  const report = (attestation: ModelAttestation, check: RecordedCheck = {}, recording: Recording = rec): Attempt => async () => {
    try {
      await verifyRecordedModelReport(recording, attestation, check);
      return undefined;
    } catch (err) {
      const refused = getSdkError(err);
      if (!refused) throw err; // not the SDK refusing: a bug on the way, which must not pass for a refusal
      return { code: refused.failure.code, detail: `${refused.message}${refused.cause instanceof Error ? ` (${refused.cause.message})` : ''}` };
    }
  };
  const logCheck = (signingAddress: string, composeHash?: string): Attempt => () => {
    const verdict = evaluateKeyLog([rec.logEntry], { model: raw.model_name, trustedVerifiers: cfg.trustedVerifiers, quorum: cfg.quorum, signingAddress, composeHash });
    return verdict.status === 'ok' ? undefined : { code: verdict.reason, detail: `nothing is sent: ${verdict.detail}` };
  };
  const proofCheck = (proof: ModelProof = exchange.proof, response: Uint8Array = exchange.rawResponse, entry: KeyEntry | null = rec.logEntry): Attempt => () => {
    // The first failed check is the change; a changed proof also stops matching its commit, which says nothing more.
    const failed = verifyModelProof(proof, exchange.rawRequest, response, entry).checks.find((c) => c.status === 'fail');
    return failed ? { code: failed.id, detail: failed.detail } : undefined;
  };

  const quote = recorded.intelQuote;
  const flippedQuote = `${quote.slice(0, QUOTE_FLIP_AT)}${quote[QUOTE_FLIP_AT] === '0' ? '1' : '0'}${quote.slice(QUOTE_FLIP_AT + 1)}`;
  // Intel's collateral is recorded per quote. The changed quote gets the collateral of the original: otherwise it would
  // be turned away for having none, before its signature is looked at.
  const forFlippedQuote: Recording = { ...rec, collateralByQuote: { ...rec.collateralByQuote, [sha256Hex(flippedQuote)]: rec.collateralByQuote[sha256Hex(quote)] } };
  const { nvidiaPayload: _gpu, ...withoutGpu } = recorded;
  // The quote and nothing else that carries a nonce: no GPU evidence, no action log.
  const { composeManagerAttestation: _log, ...quoteOnly } = withoutGpu;
  const events: readonly unknown[] = typeof recorded.eventLog === 'string' ? (JSON.parse(recorded.eventLog) as unknown[]) : recorded.eventLog;
  const manager = recorded.composeManagerAttestation;
  const tampered = new Uint8Array(exchange.rawResponse);
  tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 0x01;
  const otherNonce = 'ef'.repeat(32);

  return {
    unchanged: [
      { what: 'the model report', attempt: report(recorded) },
      { what: 'the model report with its quote alone (no GPU evidence, no action log), under a policy that asks for no more', attempt: report(quoteOnly, { gpuEvidence: 'if-present' }) },
      { what: 'the key and its launcher, looked up in the log entry', attempt: logCheck(recorded.signer.signingAddress, composeHashOf(recorded)) },
      { what: 'the proof of the recorded exchange', attempt: proofCheck() },
    ],
    rows: [
      { heading: 0, what: 'one byte of the TDX quote changed', expect: 'quote.verification_failed', because: 'signature is invalid', attempt: report({ ...recorded, intelQuote: flippedQuote }, {}, forFlippedQuote) },
      { heading: 0, what: 'a policy that does not accept the TCB status the quote has', expect: 'policy.tcb_status_not_allowed', attempt: report(recorded, { acceptedTcb: ['OutOfDate'] }) },
      { heading: 0, what: 'the NVIDIA GPU evidence removed from the report', expect: 'policy.gpu_evidence_required', attempt: report(withoutGpu) },

      // A report served again to a client that sent another nonce. Two things in it carry the old one, and each is shown
      // refusing: the GPU evidence, and the quote once nothing else is left to refuse (the report then names the new nonce).
      { heading: 1, what: 'a report served again for another nonce: its GPU evidence carries the old one', expect: 'binding.nonce_mismatch', because: 'nvidiaPayload', attempt: report(recorded, { nonce: otherNonce }) },
      { heading: 1, what: 'a report served again for another nonce: its quote carries the old one', expect: 'binding.nonce_mismatch', because: 'quoteReportData', attempt: report({ ...quoteOnly, nonce: otherNonce }, { nonce: otherNonce, gpuEvidence: 'if-present' }) },
      { heading: 1, what: 'another signing key than the one the quote binds', expect: 'binding.report_data_mismatch', attempt: report({ ...recorded, signer: { ...recorded.signer, signingAddress: DEMO_SWAPPED_KEY }, signingPublicKey: DEMO_SWAPPED_KEY }) },
      { heading: 1, what: 'a key no trusted verifier logged', expect: 'absent', attempt: logCheck(DEMO_SWAPPED_KEY) },
      replyKeyNote(1),

      { heading: 2, what: 'one character added to the app compose', expect: 'measurement.app_compose_mrconfigid_mismatch', attempt: report({ ...recorded, appCompose: `${recorded.appCompose} ` }) },
      // A well-formed event the quote's RTMR3 does not hold, here a second `compose-hash`: what a hop could add to the log it forwards.
      { heading: 2, what: 'an event added to the RTMR3 event log', expect: 'measurement.rtmr3_mismatch', attempt: report({ ...recorded, eventLog: [...events, runtimeEvent('compose-hash', DEMO_UNKNOWN_COMPOSE)] }) },
      manager && manager.actions.length > 0
        ? { heading: 2, what: "the last action removed from the enclave's action log", expect: 'binding.compose_manager_actions_mismatch', attempt: report({ ...recorded, composeManagerAttestation: { ...manager, actions: manager.actions.slice(0, -1) } }) }
        : { heading: 2, note: 'this recording carries no action log to edit' },
      { heading: 2, note: 'the release behind the key (a file that does not match, a moved or missing tag, an image with no build proof, the log of another replica): read from GitHub, so its controls are unit tests against a fake one (pnpm test, release.test.ts)' },

      { heading: 3, note: 'no control: Ainek constrains nothing here. pnpm demo:attest prints the settings of the measured launcher it can read (the manager image, the minimum tag age)' },

      { heading: 4, what: 'one bit of the response changed', expect: 'response-hash', attempt: proofCheck(exchange.proof, tampered) },
      { heading: 4, what: 'the signature presented under another key', expect: 'signature', attempt: proofCheck({ ...exchange.proof, signingAddress: DEMO_SWAPPED_KEY }) },
      { heading: 4, what: 'an answer signed by the gateway, not by the model enclave', expect: 'route', attempt: proofCheck({ ...exchange.proof, signatureKind: 'gateway' }) },
      { heading: 4, what: 'a proof whose key is not in the log', expect: 'key-in-log', attempt: proofCheck(exchange.proof, exchange.rawResponse, null) },

      { heading: 5, what: 'the right key, logged with another launcher than the one attested', expect: 'unknown-deployment', attempt: logCheck(recorded.signer.signingAddress, DEMO_UNKNOWN_COMPOSE) },
      { heading: 5, note: 'a new release of the serving containers behind the same launcher: not refused today. The client reads the action log on request and does not refuse on it (docs/CLAIMS.md, "We do not claim")' },
    ],
  };
}
