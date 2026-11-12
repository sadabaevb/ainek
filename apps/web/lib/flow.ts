// The Tier-1 client flow (SPEC §7.1) as a list of steps the page shows live:
//   verify evidence in the browser → fail-closed check against the public log → E2EE send →
//   fetch the signature → SDK byte-exact check → our proof (recomputed hashes, log binding, salted commit) → IndexedDB
//   → commit on NEAR through the caller's wallet (commitOutcome, after the card is already on screen).
// Node mirror: packages/tier1-node/src/tier1.ts (same steps and ids; keep the two in sync).
import { DEMO_SWAPPED_KEY, DEMO_UNKNOWN_COMPOSE, buildCheckedModelProof, latestKeysFor, composeHashOf, evaluateKeyLogForAll, composesBehindKey, proofEntryOf, withReleaseRule, type KeyEntry, type KeyLogVerdict, type ModelProof, type TrustSet, type ProofCommitLookup, type Tier1StepId, type VerifyReport, isAlreadyCommitted } from '@ainek/proof';
import type { CompletionSignature, VerifiedGatewayAttestation, VerifiedModelAttestation } from '@nearai/inference-sdk';
import type { PublicConfig } from './config';
import { describeError } from './errors';
import { keyLogFor } from './key-log';
import {
  chatModelOf,
  checkGatewayResponse,
  checkResponse,
  fetchModelMetadata,
  fetchSignature,
  forgetDeployment,
  prepareE2ee, transmitE2ee,
  sendPlain,
  verifyDeployment,
  verifyGateway,
  type ChatMessage,
  type Exchange,
  type VerifiedDeployment,
} from './nearai-browser';
import { getExchange, putExchange, type StoredExchange } from './store';
import { DEPOSIT_NEAR, errorText, isDialogClosed, isMethodNotFound, isNoDeposit, type Consent } from './wallet';
import { seconds, short } from './format';

export type { ChatMessage } from './nearai-browser';
export type StepId = Tier1StepId | 'store' | 'commit';
/** Wording key for the progress strip: the step id, or a route variant where the same step means something else. */
export type Phrase = StepId | 'attestation-gateway' | 'send-plain' | 'signature-gateway';
export type StepStatus = 'running' | 'ok' | 'fail' | 'skipped';
export interface StepEvent {
  id: StepId;
  /** Set on running events: which wording the UI shows while this step runs. */
  say?: Phrase;
  status: StepStatus;
  detail: string;
}

/** The failure phase follows the shared step order (TIER1_STEPS in @ainek/proof); `store` and `commit` run after the reply, so a failure there is "reply not provable", not "nothing was sent". */
export { failurePhase, type FailurePhase } from '@ainek/proof';

/** What happened to the on-chain commit of a verified reply (SPEC §4.2); `committed` puts `commitTx` on the proof. */
/** `depositing` and `pending` are the two in-flight states (the card words them differently); `committed` may lack the transaction when the chain already had the commit. */
export type CommitStatus = 'pending' | 'depositing' | 'no-wallet' | 'no-deposit' | 'not-deployed' | 'failed' | 'committed';

export interface VerifiedOutcome {
  kind: 'verified';
  reply: string;
  deployment: VerifiedDeployment;
  modelAttestation: VerifiedModelAttestation;
  logSource: 'contract' | 'sample';
  keyVerdict: KeyLogVerdict;
  logEntry: KeyEntry;
  exchange: Exchange;
  proof: ModelProof;
  report: VerifyReport;
  commit: CommitStatus;
}

export type ChatOutcome =
  | VerifiedOutcome
  | { kind: 'refused'; model: string; /** A demo switch swapped something: the card can offer the honest retry. */ tampered: Tamper; /** With a demo switch on: would the same message pass the log check without it? Only then is the retry worth offering. */ honestWouldPass: boolean; deployment: VerifiedDeployment; logSource: 'contract' | 'sample'; entriesInWindow: number; keyVerdict: KeyLogVerdict; seenKey: string; /** The compose hash the log was asked about; undefined when the deployment check did not run. */ seenCompose: string | undefined }
  | { kind: 'non-tee'; reply: string; gateway: VerifiedGatewayAttestation; exchange: Exchange; signature: CompletionSignature; model: string }
  /** `unverifiedReply` is present when a reply had come back before the failing step (see failurePhase). It is not `reply`:
   *  nothing vouches for it, so it is shown marked and never reused (packages/tier1-node calls its twin `unverifiedCompletion`). */
  | { kind: 'failed'; step: StepId; reason: string; unverifiedReply?: string };

class StepFailed extends Error {
  constructor(readonly step: StepId, readonly reason: string) {
    super(reason);
  }
}

type Emit = (e: StepEvent) => void;

function fail(emit: Emit, id: StepId, reason: string): never {
  emit({ id, status: 'fail', detail: reason });
  throw new StepFailed(id, reason);
}

/** Runs one step: emits running, then ok with `okDetail(result)`, or fail and aborts the flow. Always emitting running keeps runChat's "step last seen running" exact. */
async function runStep<T>(emit: Emit, id: StepId, running: string, fn: () => Promise<T>, okDetail: (value: T) => string, say: Phrase = id): Promise<T> {
  emit({ id, status: 'running', detail: running, say });
  try {
    const value = await fn();
    emit({ id, status: 'ok', detail: okDetail(value) });
    return value;
  } catch (err) {
    return fail(emit, id, describeError(err));
  }
}

/** Filled in as the route advances, so a failure can still show the reply that had already come back. */
interface Progress {
  reply?: string;
}

/** The demo switches for the private model: what the client is shown instead of what was attested, before the log check. With one on, that route sends nothing, whatever the log says (`teeRoute`). */
export type Tamper = false | 'key' | 'deployment';


export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tamper: Tamper;
  /** Who counts for the key-log check: the viewer's choice or the site default (useTrust). */
  trust: TrustSet;
  onStep: Emit;
}

export async function runChat(cfg: PublicConfig, params: ChatParams): Promise<ChatOutcome> {
  // Every error becomes a failed outcome: a StepFailed knows its step, anything else is charged to the step last seen running.
  let running: StepId = 'metadata';
  const progress: Progress = {};
  const emit: Emit = (e) => {
    if (e.status === 'running') running = e.id;
    params.onStep(e);
  };
  const route = { ...params, onStep: emit };
  try {
    return await (params.model === cfg.incognitoModel ? nonTeeRoute(cfg, route, progress) : teeRoute(cfg, route, progress));
  } catch (err) {
    // `unverifiedReply` only when one came back: the page shows the marked bubble on the key's presence.
    const failed = (step: StepId, reason: string): ChatOutcome => ({ kind: 'failed', step, reason, ...(progress.reply === undefined ? {} : { unverifiedReply: progress.reply }) });
    if (err instanceof StepFailed) return failed(err.step, err.reason);
    const reason = describeError(err);
    emit({ id: running, status: 'fail', detail: reason });
    return failed(running, reason);
  }
}

async function teeRoute(cfg: PublicConfig, { model, messages, tamper, trust, onStep: emit }: ChatParams, progress: Progress): Promise<ChatOutcome> {
  const policy = { acceptedTcbStatuses: cfg.acceptedTcbStatuses };

  // 0. The user chose the private model: it must support model attestation, otherwise nothing is sent (never a silent downgrade to plaintext).
  const meta = await runStep(emit, 'metadata', `asking the gateway about ${model}`, () => fetchModelMetadata(model), (m) => `${model}: provider ${String(m.providerType)}, model attestation ${m.attestationSupported === true ? 'supported' : 'not supported'}`);
  if (meta.attestationSupported !== true) fail(emit, 'metadata', `${model} reports no model attestation: refusing to send in plaintext (fail-closed)`);

  // 1. Verify gateway and model evidence on this device; read the log meanwhile (independent, the send waits for both).
  const log = keyLogFor(cfg);
  const logStop = new AbortController(); // if attestation fails, the log reads have nothing left to serve
  const keyLogPromise = latestKeysFor(log, model, trust.verifiers, undefined, logStop.signal);
  keyLogPromise.catch(() => undefined); // awaited below; avoid an unhandled rejection if attestation fails first
  const deployment = await runStep(emit, 'attestation', 'verifying Intel TDX quotes and NVIDIA GPU evidence in this browser', () => verifyDeployment(model, policy), (d) => `${d.tookMs === 0 ? 'cached' : seconds(d.tookMs)}: gateway ${d.gateway.tcbStatus}; ${d.models.length} model report${d.models.length === 1 ? '' : 's'} ${d.models.map((x) => `${x.tcbStatus}/gpu ${x.gpuEvidence}`).join(', ')}`).catch((err: unknown) => {
    logStop.abort();
    throw err;
  });
  const modelAttestation = chatModelOf(deployment);
  if (!modelAttestation) fail(emit, 'attestation', 'no model attestation returned');

  // 2. Fail-closed: the attested signing key must be in the public log; with the deployment check on (config, or the demo switch),
  // it must be logged together with the attested compose hash.
  const entries = await runStep(emit, 'key-log', `reading the public key log (${log.source})`, () => keyLogPromise, (e) => `${e.length} entr${e.length === 1 ? 'y' : 'ies'} in window (source: ${log.source})`);
  const seenKey = tamper === 'key' ? DEMO_SWAPPED_KEY : modelAttestation.signer.signingAddress;
  const attestedCompose = composeHashOf(modelAttestation.deployment);
  // Every report that carries this key is checked: the one that signs the reply need not be the first (attestedCompose stays first).
  const honestComposes = cfg.requireLoggedDeployment ? composesBehindKey(deployment.models.map((m) => ({ signingAddress: m.signer.signingAddress, composeHash: composeHashOf(m.deployment) })), modelAttestation.signer.signingAddress) : [undefined];
  const logPolicy = { model, trustedVerifiers: trust.verifiers, quorum: trust.quorum };
  const keyOnly = evaluateKeyLogForAll(entries, { ...logPolicy, signingAddress: seenKey }, tamper === 'deployment' ? [DEMO_UNKNOWN_COMPOSE] : honestComposes);
  // SPEC §7.5, when asked for: the action log of each attested report must be one the same verifiers checked and logged.
  const keyVerdict = cfg.requireLoggedRelease ? withReleaseRule(keyOnly, entries, { ...logPolicy, signingAddress: seenKey }, deployment.models, cfg.requireLoggedDeployment) : keyOnly;
  const seenCompose = keyVerdict.deployment?.composeHash;
  if (keyVerdict.status !== 'ok') {
    emit({ id: 'key-log', status: 'fail', detail: keyVerdict.detail });
    const honestWouldPass = tamper !== false && evaluateKeyLogForAll(entries, { ...logPolicy, signingAddress: modelAttestation.signer.signingAddress }, honestComposes).status === 'ok';
    // An honest refusal on the deployment: forget this verification, so the next try attests again and may reach a replica the log knows.
    // The same for an action log nobody logged yet: a verifier may log it meanwhile, and another replica may already be logged.
    if (tamper === false && (keyVerdict.reason === 'unknown-deployment' || keyVerdict.reason === 'unknown-release')) await forgetDeployment(model, policy);
    return { kind: 'refused', model, tampered: tamper, honestWouldPass, deployment, logSource: log.source, entriesInWindow: entries.length, keyVerdict, seenKey, seenCompose };
  }
  // A demo value passed the check, so somebody logged it: the real key and deployment were never checked, and a demo must not send.
  if (tamper) fail(emit, 'key-log', `the demo ${tamper} is in the log of a verifier this client trusts: nothing is sent while a demo switch is on`);
  const logEntry = proofEntryOf(keyVerdict, attestedCompose);
  emit({ id: 'key-log', status: 'ok', detail: `${keyVerdict.detail} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in window, source: ${log.source})` });

  // 3. Encrypt to the verified key (nothing leaves the browser yet), then send through the proxy and decrypt the reply.
  const prepared = await runStep(emit, 'encrypt', 'encrypting to the attested model key', () => prepareE2ee(model, messages, modelAttestation), (p) => `${p.requestBody.length} B encrypted to the attested model key`);
  const exchange = await runStep(emit, 'send', 'sending through our relay', () => transmitE2ee(prepared), (x) => `completion ${x.completionId}, ${x.requestBody.length} B sent, ${x.responseBody.length} B received (ciphertext kept)`);
  progress.reply = exchange.reply;

  // 4. Signature from the gateway, 5. SDK byte-exact check against the verified model signer.
  const signature = await runStep(emit, 'signature', 'fetching the completion signature', () => fetchSignature(exchange.completionId), (s) => `signature_kind ${s.kind}, signer ${short(s.signer.signingAddress)}`);
  const signer = await runStep(emit, 'sdk-check', 'SDK byte-exact check against the attested signer', async () => checkResponse(exchange, signature, deployment), () => 'SDK: signature covers exactly these request and response bytes, signer is the attested model key');

  // 6. Our proof: hashes recomputed from the kept bytes, bound to the log entry, salted commit for the chain.
  const { proof, report } = await runStep(emit, 'proof', 'recomputing hashes and building the proof', async () => buildCheckedModelProof({ completionId: exchange.completionId, model, signature, requestBody: exchange.requestBody, responseBody: exchange.responseBody, logEntry, verifiedAt: deployment.verifiedAt, e2ee: true }), ({ proof, report }) => `${report.checks.filter((c) => c.status === 'ok').length}/${report.checks.length} checks; commit ${proof.commit?.slice(0, 12)}… (salt stays on this device)`);

  // 7. Keep bytes + proof locally (best effort: a private window may refuse).
  const outcome: VerifiedOutcome = { kind: 'verified', reply: exchange.reply, deployment, modelAttestation: signer, logSource: log.source, keyVerdict, logEntry, exchange, proof, report, commit: 'pending' };
  try {
    await putExchange(storedExchangeOf(outcome));
    emit({ id: 'store', status: 'ok', detail: 'raw bytes, proof and salt saved in this browser (IndexedDB)' });
  } catch (err) {
    emit({ id: 'store', status: 'skipped', detail: `could not save locally: ${describeError(err)}` });
  }
  return outcome;
}

function storedExchangeOf(o: VerifiedOutcome): StoredExchange {
  const { exchange } = o;
  return { completionId: exchange.completionId, model: o.proof.model, sentAt: exchange.sentAt, requestBody: exchange.requestBody, responseBody: exchange.responseBody, reply: exchange.reply, proof: o.proof, logEntry: o.logEntry };
}

/** A wallet account that can commit (SPEC §4.2). Commits spend storage the account prepaid; `deposit` is present only when the user clicked for it. */
export interface Committer {
  account: string;
  /** yoctoNEAR prepaid on the contract for this account. */
  storageBalance: () => Promise<bigint>;
  /** `proof_commit` for this account: the chain's answer when a local row and the contract disagree. */
  lookup: (commit: string) => Promise<ProofCommitLookup>;
  /** `deposit_storage` through the wallet dialog. */
  deposit?: () => Promise<void>;
  commit: (proof: ModelProof) => Promise<string>;
}

/** Commit states a click can move forward: no wallet, no prepaid storage, or a commit that failed. `not-deployed` waits for the contract, not for the user. */
export function canCommitNow(status: CommitStatus): boolean {
  return status === 'no-wallet' || status === 'no-deposit' || status === 'failed';
}

export type CommitAction = 'connect' | 'deposit' | 'retry' | 'commit';
/** What the commit button does for this status with the wallet as it is now: the label and the click come from the same answer. */
export function commitAction(status: CommitStatus, signedIn: boolean): CommitAction {
  if (!signedIn) return 'connect';
  if (status === 'no-deposit') return 'deposit';
  return status === 'failed' ? 'retry' : 'commit';
}
/** The dialogs a click on that button may open. */
export const consentFor = (action: CommitAction): Consent => (action === 'deposit' ? 'deposit' : 'connect');

/**
 * Step 8 on an exchange kept in this browser: resolve the wallet, call commit_proof and record the transaction in the stored
 * row. One boundary for the chat (right after a reply, or from the card's button) and for /verify (an older exchange). Never throws.
 * The client does not know what a commit costs (it depends on the account name): a committer that may deposit does so first;
 * otherwise only an account with nothing prepaid is spared the transaction, and the contract decides the rest.
 */
export async function commitExchange(x: StoredExchange, resolveCommitter: () => Promise<Committer | null>, emit: Emit): Promise<{ commit: CommitStatus; exchange: StoredExchange }> {
  try {
    // The chat's automatic pass and a click on /verify can race for the same exchange: the stored row is the source of truth.
    const fresh = await getExchange(x.completionId).catch(() => undefined);
    if (fresh?.proof.commitTx) {
      emit({ id: 'commit', status: 'ok', detail: `already committed in transaction ${short(fresh.proof.commitTx)}` });
      return { commit: 'committed', exchange: fresh };
    }
    const commit = x.proof.commit;
    if (!commit) {
      emit({ id: 'commit', status: 'skipped', detail: 'the proof carries no commit hash: nothing to put on-chain' });
      return { commit: 'failed', exchange: x };
    }
    const committer = await resolveCommitter();
    if (!committer) {
      emit({ id: 'commit', status: 'skipped', detail: 'no wallet connected: the commit stays local (connect a wallet to put it on NEAR)' });
      return { commit: 'no-wallet', exchange: x };
    }
    if (committer.deposit) {
      emit({ id: 'commit', status: 'running', detail: `deposit_storage(${DEPOSIT_NEAR} NEAR) through the wallet` });
      try {
        await committer.deposit();
      } catch (err) {
        if (!isDialogClosed(err)) throw err;
        emit({ id: 'commit', status: 'skipped', detail: 'the deposit dialog was closed before it reported back: commit kept locally (a deposit you already approved may still land)' });
        return { commit: 'no-deposit', exchange: x };
      }
    } else if ((await committer.storageBalance()) === 0n) {
      emit({ id: 'commit', status: 'skipped', detail: `${committer.account} has nothing prepaid for storage on the contract (deposit_storage tops it up); commit kept locally` });
      return { commit: 'no-deposit', exchange: x };
    }
    emit({ id: 'commit', status: 'running', detail: `commit_proof(${short(commit)}, "model", ${x.proof.logIndex})` });
    try {
      const commitTx = await committer.commit(x.proof);
      const committed: StoredExchange = { ...x, proof: { ...x.proof, commitTx } };
      emit({ id: 'commit', status: 'ok', detail: `commit ${short(commit)} recorded in transaction ${short(commitTx)}` });
      putExchange(committed).catch(() => undefined);
      return { commit: 'committed', exchange: committed };
    } catch (err) {
      // The chain may already hold this commit (the row never got its transaction, or the store was cleared): the view decides.
      if (!isAlreadyCommitted(errorText(err))) throw err; // this browser's row just never recorded the transaction
      const found = await committer.lookup(commit);
      if (found.status !== 'found') throw err;
      emit({ id: 'commit', status: 'ok', detail: `commit ${short(commit)} was already on NEAR for ${committer.account} (block ${found.record.block_height}; the transaction is not known to this browser)` });
      return { commit: 'committed', exchange: x };
    }
  } catch (err) {
    if (isNoDeposit(err)) {
      emit({ id: 'commit', status: 'skipped', detail: 'the contract refused: not enough prepaid storage for this account (deposit_storage tops it up); commit kept locally' });
      return { commit: 'no-deposit', exchange: x };
    }
    const notDeployed = isMethodNotFound(err);
    emit({ id: 'commit', status: 'skipped', detail: notDeployed ? `this contract lacks the SPEC §4.2 methods (${errorText(err)}): commit kept locally` : `commit failed: ${errorText(err)}; commit kept locally` });
    return { commit: notDeployed ? 'not-deployed' : 'failed', exchange: x };
  }
}

export async function commitOutcome(outcome: VerifiedOutcome, resolveCommitter: () => Promise<Committer | null>, emit: Emit): Promise<VerifiedOutcome> {
  const r = await commitExchange(storedExchangeOf(outcome), resolveCommitter, emit);
  return { ...outcome, proof: r.exchange.proof, commit: r.commit };
}

/** The user picked the Incognito model (SPEC §3.9): no model evidence, no E2EE; plaintext goes through our proxy and the gateway, and the card says so. */
async function nonTeeRoute(cfg: PublicConfig, { model, messages, trust, onStep: emit }: ChatParams, progress: Progress): Promise<ChatOutcome> {
  const policy = { acceptedTcbStatuses: cfg.acceptedTcbStatuses };
  const meta = await runStep(emit, 'metadata', `asking the gateway about ${model}`, () => fetchModelMetadata(model), (m) => `${model}: provider ${String(m.providerType)}, model attestation ${m.attestationSupported === true ? 'supported' : 'not supported'}`);
  if (meta.attestationSupported === true) return teeRoute(cfg, { model, messages, tamper: false, trust, onStep: emit }, progress); // it is attested after all: use the real path
  const gateway = await runStep(emit, 'attestation', 'verifying the gateway only (this model has no model attestation)', () => verifyGateway(policy), (g) => `gateway ${g.tcbStatus}; no model evidence exists for ${model}`, 'attestation-gateway');
  emit({ id: 'key-log', status: 'skipped', detail: 'no model key to look up: nothing to verify against the log' });
  const exchange = await runStep(emit, 'send', 'sending in plaintext through our proxy (no model key to encrypt to)', () => sendPlain(model, messages), (x) => `completion ${x.completionId} (plaintext through our proxy and the gateway)`, 'send-plain');
  progress.reply = exchange.reply;
  const signature = await runStep(emit, 'signature', 'fetching the completion signature', () => fetchSignature(exchange.completionId), (s) => `signature_kind ${s.kind}`, 'signature-gateway');
  await runStep(emit, 'sdk-check', 'SDK check against the gateway signer', async () => checkGatewayResponse(exchange, signature, gateway), () => 'SDK: the gateway signed these bytes; this says nothing about where the model ran');
  emit({ id: 'proof', status: 'skipped', detail: 'no model proof for a non-attested route' });
  return { kind: 'non-tee', reply: exchange.reply, gateway, exchange, signature, model };
}
