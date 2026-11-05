import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { ActionProof, actionCommitOf, bytesToBase64, bytesToHex, canonicalBytes, commitOf, verifyActionProof, type Action, type Decision, type ModelProof, type PolicyInput } from '@ainek/proof';
import type { RunStats, Verified } from '@ainek/tier1-node';
import type { ActionChain } from './chain.ts';
import type { Extraction } from './llm.ts';
import { handleOwnerText, type Deps } from './pipeline.ts';
import type { PolicyEvaluator } from './policy.ts';
import type { ProofKeeper } from './store.ts';

const keys = nacl.sign.keyPair();
const teePubkey = bytesToHex(keys.publicKey);
const wasmHash = 'cd'.repeat(32);
const now = 1_762_300_000_000;
const action: Action = { kind: 'ft_transfer', token_id: 'token.ainek.testnet', receiver_id: 'vendor1.testnet', amount: '300000000', memo: 'October' };
const modelProof = { kind: 'model', logIndex: 3, commit: 'ab'.repeat(32), salt: '11'.repeat(32) } as unknown as ModelProof;
const verified = { proof: modelProof } as unknown as Verified & RunStats;

/** A policy job that signs honestly with the test key, or with another key, or answers with no attestation. */
function policy(opts: { verdict?: Decision['verdict']; signer?: nacl.SignKeyPair; attestation?: string | null } = {}): PolicyEvaluator & { inputs: PolicyInput[] } {
  const inputs: PolicyInput[] = [];
  return {
    inputs,
    evaluate: async (input) => {
      inputs.push(input);
      const decision: Decision = { verdict: opts.verdict ?? 'Allow', policy_hash: 'ef'.repeat(32), policy_version: 3, action_commit: actionCommitOf(input.action), model_proof_commit: input.model_proof_commit, nonce: '12'.repeat(32), expires_at: String(input.now + 600_000) };
      const sk = (opts.signer ?? keys).secretKey;
      return { output: { decision, sig: bytesToBase64(nacl.sign.detached(canonicalBytes(decision), sk)), pubkey: teePubkey, wasm_hash: wasmHash }, callId: 'c1', attestationUrl: opts.attestation === undefined ? 'https://api.test/attestations/c1' : opts.attestation, timeMs: 10 };
    },
  };
}
/** A contract that records proposals and commits; `execute` controls the action_executed event. */
function chain(opts: { execute?: boolean; commitFails?: boolean } = {}): ActionChain & { proposals: unknown[]; commits: Array<[string, string, number]> } {
  const proposals: unknown[] = [];
  const commits: Array<[string, string, number]> = [];
  return {
    proposals,
    commits,
    proposeAction: async (args) => { proposals.push(args); return { actionId: 7, txHash: 'PROPOSE_TX', events: opts.execute ? [{ event: 'action_proposed' }, { event: 'action_executed' }] : [{ event: 'action_proposed' }] }; },
    commitProof: async (commit, kind, logIndex) => { if (opts.commitFails) throw new Error('not enough prepaid storage'); commits.push([commit, kind, logIndex]); return `${kind.toUpperCase()}_TX`; },
    spentToday: async () => '100',
  };
}
const keeper = (over: Partial<ProofKeeper> = {}): ProofKeeper => ({ model: async () => undefined, action: async () => undefined, ...over });
const extractAs = (x: Extraction) => async () => x;
const deps = (over: Partial<Deps>): Deps => ({ extract: extractAs({ kind: 'action', action, outcome: verified }), policy: policy(), chain: chain({ execute: true }), keep: keeper(), teePubkey, wasmHash, now: () => now, ...over });

test('Allow: the policy gets the §6.2 input, the contract gets the signed decision, the action proof verifies and is committed, both bound to the model proof\'s log entry', async () => {
  const p = policy();
  const c = chain({ execute: true });
  const r = await handleOwnerText(deps({ policy: p, chain: c }), 'pay vendor1 300');
  assert.equal(r.kind, 'proposed');
  if (r.kind !== 'proposed') return;
  assert.deepEqual(p.inputs[0], { action, model_proof_commit: 'ab'.repeat(32), spent_today: '100', now });
  assert.equal(r.verdict, 'Allow');
  assert.equal(r.executed, true);
  assert.equal(r.proof.executeTx, 'PROPOSE_TX');
  assert.equal(r.proof.commitTx, 'ACTION_TX');
  assert.equal(r.modelCommitTx, 'MODEL_TX');
  assert.deepEqual(c.commits, [[r.proof.commit, 'action', 3], ['ab'.repeat(32), 'model', 3]]);
  assert.deepEqual(r.checks.filter((k) => k.status !== 'ok'), []);
  ActionProof.parse(r.proof);
  assert.equal(commitOf(r.proof.salt, r.proof), r.proof.commit);
  assert.deepEqual(verifyActionProof(r.proof, { teePubkey, wasmHash }).checks.filter((k) => k.status !== 'ok'), []);
});

test('Deny and NeedsApproval are proposed too (the contract records them); nothing is executed', async () => {
  for (const verdict of ['Deny', 'NeedsApproval'] as const) {
    const r = await handleOwnerText(deps({ policy: policy({ verdict }), chain: chain() }), 'pay');
    assert.equal(r.kind, 'proposed');
    if (r.kind === 'proposed') {
      assert.equal(r.verdict, verdict);
      assert.equal(r.executed, false);
      assert.equal(r.proof.executeTx, null);
    }
  }
});

test('a decision signed by another key, or with no attestation, never reaches the contract', async () => {
  const c = chain();
  const r = await handleOwnerText(deps({ policy: policy({ signer: nacl.sign.keyPair() }), chain: c }), 'pay');
  assert.equal(r.kind, 'decision-rejected');
  if (r.kind === 'decision-rejected') assert.deepEqual(r.checks.filter((k) => k.status === 'fail').map((k) => k.id), ['decision-signature']);
  const r2 = await handleOwnerText(deps({ policy: policy({ attestation: null }), chain: c }), 'pay');
  assert.equal(r2.kind, 'failed');
  assert.equal(c.proposals.length, 0);
});

test('a failed commit keeps the proof and reports the error; model outcomes other than an action end before the policy', async () => {
  const p = policy();
  const r = await handleOwnerText(deps({ policy: p, chain: chain({ commitFails: true }) }), 'pay');
  assert.equal(r.kind, 'proposed');
  if (r.kind === 'proposed') {
    assert.equal(r.commitTx, null);
    assert.equal(r.modelCommitTx, null);
    assert.match(r.commitError ?? '', /prepaid storage; model proof: not enough prepaid storage/);
    assert.equal(r.proof.commitTx, undefined);
  }
  const quiet = policy();
  assert.equal((await handleOwnerText(deps({ policy: quiet, extract: extractAs({ kind: 'declined', reason: 'no payment', outcome: verified }) }), 'hi')).kind, 'declined');
  assert.equal((await handleOwnerText(deps({ policy: quiet, extract: extractAs({ kind: 'bad-call', reason: 'text', outcome: verified }) }), 'hi')).kind, 'bad-call');
  assert.equal((await handleOwnerText(deps({ policy: quiet, extract: extractAs({ kind: 'not-sent', step: 'key-log', reason: 'absent', outcome: { kind: 'refused' } as never }) }), 'hi')).kind, 'not-sent');
  assert.equal(quiet.inputs.length, 0);
});

test('salts are saved before their commits can reach the chain; a model proof that cannot be saved stops everything', async () => {
  const order: string[] = [];
  const c = chain({ execute: true });
  const logged: ActionChain = {
    spentToday: c.spentToday,
    proposeAction: async (a) => { order.push('propose_action'); return c.proposeAction(a); },
    commitProof: async (commit, kind, i) => { order.push(`commit_proof ${kind}`); return c.commitProof(commit, kind, i); },
  };
  await handleOwnerText(deps({ chain: logged, keep: keeper({ model: async () => void order.push('keep model'), action: async (p) => void order.push(p.commitTx ? 'keep action with tx' : 'keep action') }) }), 'pay');
  assert.deepEqual(order, ['keep model', 'propose_action', 'keep action', 'commit_proof action', 'keep action with tx', 'commit_proof model']);

  const p = policy();
  const stopped = await handleOwnerText(deps({ policy: p, keep: keeper({ model: async () => { throw new Error('disk full'); } }) }), 'pay');
  assert.deepEqual(stopped, { kind: 'failed', stage: 'store', reason: 'disk full' });
  assert.equal(p.inputs.length, 0);
});

test('an action proof that cannot be saved is not committed; the action itself is still reported, and the model commit still goes out', async () => {
  const c = chain({ execute: true });
  const r = await handleOwnerText(deps({ chain: c, keep: keeper({ action: async () => { throw new Error('disk full'); } }) }), 'pay');
  assert.equal(r.kind, 'proposed');
  if (r.kind === 'proposed') {
    assert.equal(r.executed, true);
    assert.equal(r.commitTx, null);
    assert.equal(r.commitError, 'disk full');
  }
  assert.deepEqual(c.commits.map(([, kind]) => kind), ['model']);
});

test('a spent_today that cannot be read stops before the policy runs', async () => {
  const p = policy();
  const r = await handleOwnerText(deps({ policy: p, chain: { ...chain(), spentToday: async () => { throw new Error('the per-day cap cannot be checked'); } } }), 'pay');
  assert.deepEqual(r, { kind: 'failed', stage: 'policy', reason: 'the per-day cap cannot be checked' });
  assert.equal(p.inputs.length, 0);
});
