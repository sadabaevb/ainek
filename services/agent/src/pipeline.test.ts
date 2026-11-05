import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { actionCommitOf, bytesToBase64, bytesToHex, canonicalBytes, verifyActionProof, type Action, type Decision, type ModelProof, type PolicyInput } from '@ainek/proof';
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
const action: Action = { kind: 'ft_transfer', token_id: 'token.ainek.testnet', receiver_id: 'vendor1.testnet', amount: '300000000', memo: '' };
const modelProof = { kind: 'model', logIndex: 3, commit: 'ab'.repeat(32), salt: '11'.repeat(32) } as unknown as ModelProof;
const verified = { proof: modelProof } as unknown as Verified & RunStats;
const extracted: Extraction = { kind: 'action', action, purpose: 'October', outcome: verified };

/** A policy job that signs honestly with the test key, or with another key. */
function policy(opts: { verdict?: Decision['verdict']; signer?: nacl.SignKeyPair } = {}): PolicyEvaluator & { inputs: PolicyInput[] } {
  const inputs: PolicyInput[] = [];
  return {
    inputs,
    evaluate: async (input) => {
      inputs.push(input);
      const decision: Decision = { verdict: opts.verdict ?? 'Allow', policy_hash: 'ef'.repeat(32), policy_version: 3, action_commit: actionCommitOf(input.action), model_proof_commit: input.model_proof_commit, nonce: '12'.repeat(32), expires_at: String(input.now + 600_000) };
      return { output: { decision, sig: bytesToBase64(nacl.sign.detached(canonicalBytes(decision), (opts.signer ?? keys).secretKey)), pubkey: teePubkey, wasm_hash: wasmHash }, attestationUrl: 'https://api.test/attestations/c1' };
    },
  };
}
/** A contract that records what it is asked. */
function chain(opts: { executed?: boolean; failCommit?: 'model' | 'action'; failPropose?: boolean; proposeTx?: string } = {}): ActionChain & { proposals: unknown[]; commits: Array<[string, string, number]> } {
  const proposals: unknown[] = [];
  const commits: Array<[string, string, number]> = [];
  return {
    proposals,
    commits,
    proposeAction: async (args) => { if (opts.failPropose) throw new Error('rejected'); proposals.push(args); return { actionId: 7, txHash: opts.proposeTx ?? 'PROPOSE_TX', executed: opts.executed ?? false }; },
    commitProof: async (commit, kind, logIndex) => { if (opts.failCommit === kind) throw new Error('not enough prepaid storage'); commits.push([commit, kind, logIndex]); return `${kind.toUpperCase()}_TX`; },
    spentToday: async () => '100',
  };
}
const keeper = (over: Partial<ProofKeeper> = {}): ProofKeeper => ({ model: async () => undefined, action: async () => undefined, ...over });
const deps = (over: Partial<Deps>): Deps => ({ extract: async () => extracted, policy: policy(), chain: chain({ executed: true }), keep: keeper(), teePubkey, wasmHash, now: () => now, ...over });

test('Allow: the policy gets the §6.2 input, the contract gets the signed decision, both proofs are committed to the model proof\'s log entry, and the action proof verifies', async () => {
  const p = policy();
  const c = chain({ executed: true });
  const r = await handleOwnerText(deps({ policy: p, chain: c }), 'pay vendor1 300');
  assert.equal(r.kind, 'proposed');
  if (r.kind !== 'proposed') return;
  assert.deepEqual(p.inputs[0], { action, model_proof_commit: 'ab'.repeat(32), spent_today: '100', now });
  assert.equal(r.proof.decision.verdict, 'Allow');
  assert.equal(r.proof.executeTx, 'PROPOSE_TX');
  assert.equal(r.proof.commitTx, 'ACTION_TX');
  assert.equal(r.modelProof.commitTx, 'MODEL_TX');
  assert.equal(r.purpose, 'October');
  assert.equal(r.commitError, null);
  assert.deepEqual(c.commits, [['ab'.repeat(32), 'model', 3], [r.proof.commit, 'action', 3]]);
  assert.deepEqual(verifyActionProof(r.proof, { teePubkey, wasmHash }).checks.filter((k) => k.status !== 'ok'), []);
});

test('Deny is proposed too (the contract records the attempt); nothing is executed', async () => {
  const r = await handleOwnerText(deps({ policy: policy({ verdict: 'Deny' }), chain: chain() }), 'pay');
  assert.ok(r.kind === 'proposed' && r.proof.decision.verdict === 'Deny' && r.proof.executeTx === null);
});

test('a decision signed by another key never reaches the contract', async () => {
  const c = chain();
  const r = await handleOwnerText(deps({ policy: policy({ signer: nacl.sign.keyPair() }), chain: c }), 'pay');
  assert.equal(r.kind, 'decision-rejected');
  if (r.kind === 'decision-rejected') assert.deepEqual(r.checks.filter((k) => k.status === 'fail').map((k) => k.id), ['decision-signature']);
  assert.deepEqual(c.proposals, []);
  assert.deepEqual(c.commits, []);
});

test('model outcomes other than an action end before the policy runs and before any save', async () => {
  const quiet = policy();
  let saves = 0;
  const keep = keeper({ model: async () => void saves++ });
  const run = (x: Extraction) => handleOwnerText(deps({ policy: quiet, keep, extract: async () => x }), 'hi');
  assert.equal((await run({ kind: 'declined', reason: 'no payment', outcome: verified })).kind, 'declined');
  assert.equal((await run({ kind: 'bad-call', reason: 'text', outcome: verified })).kind, 'bad-call');
  assert.equal((await run({ kind: 'not-sent', step: 'key-log', reason: 'absent' })).kind, 'not-sent');
  assert.deepEqual(await run({ kind: 'failed', step: 'send', reason: 'HTTP 500' }), { kind: 'failed', stage: 'model', reason: 'send: HTTP 500' });
  assert.deepEqual([quiet.inputs.length, saves], [0, 0]);
});

test('order: the salt is saved before its commit, and the model proof is committed before any money can move', async () => {
  const order: string[] = [];
  const c = chain({ executed: true });
  const logged: ActionChain = {
    spentToday: c.spentToday,
    proposeAction: async (a) => { order.push('propose_action'); return c.proposeAction(a); },
    commitProof: async (commit, kind, i) => { order.push(`commit_proof ${kind}`); return c.commitProof(commit, kind, i); },
  };
  await handleOwnerText(deps({ chain: logged, keep: keeper({ model: async (x) => void order.push(x.proof.commitTx ? 'keep model with tx' : 'keep model'), action: async (p) => void order.push(p.commitTx ? 'keep action with tx' : 'keep action') }) }), 'pay');
  assert.deepEqual(order, ['keep model', 'commit_proof model', 'keep model with tx', 'propose_action', 'keep action', 'commit_proof action', 'keep action with tx']);
});

test('before the money: a salt that cannot be saved, a spent_today that cannot be read, or a model commit that fails (no storage) stops everything', async () => {
  const p = policy();
  assert.deepEqual(await handleOwnerText(deps({ policy: p, keep: keeper({ model: async () => { throw new Error('disk full'); } }) }), 'pay'), { kind: 'failed', stage: 'store', reason: 'disk full' });
  assert.equal(p.inputs.length, 0);
  assert.deepEqual(await handleOwnerText(deps({ policy: p, chain: { ...chain(), spentToday: async () => { throw new Error('the per-day cap cannot be checked'); } } }), 'pay'), { kind: 'failed', stage: 'policy', reason: 'the per-day cap cannot be checked' });
  assert.equal(p.inputs.length, 0);
  const c = chain({ failCommit: 'model' });
  assert.deepEqual(await handleOwnerText(deps({ chain: c }), 'pay'), { kind: 'failed', stage: 'commit', reason: 'not enough prepaid storage' });
  assert.deepEqual(c.proposals, []);
});

test('a rejected propose_action is the chain stage; nothing was saved as an action', async () => {
  let actions = 0;
  const r = await handleOwnerText(deps({ chain: chain({ failPropose: true }), keep: keeper({ action: async () => void actions++ }) }), 'pay');
  assert.deepEqual(r, { kind: 'failed', stage: 'chain', reason: 'rejected' });
  assert.equal(actions, 0);
});

test('after the money: a commit or a save that fails is reported on the proposed result, never thrown', async () => {
  const noCommit = await handleOwnerText(deps({ chain: chain({ executed: true, failCommit: 'action' }) }), 'pay');
  assert.ok(noCommit.kind === 'proposed' && noCommit.proof.commitTx === undefined && noCommit.proof.executeTx === 'PROPOSE_TX' && noCommit.commitError === 'not enough prepaid storage');

  const c = chain({ executed: true });
  const noSave = await handleOwnerText(deps({ chain: c, keep: keeper({ action: async () => { throw new Error('disk full'); } }) }), 'pay');
  assert.ok(noSave.kind === 'proposed' && noSave.commitError === 'disk full');
  assert.deepEqual(c.commits.map(([, kind]) => kind), ['model']); // an action proof whose salt is not saved is not committed
});

test('after the money: a proof that cannot be built still names the action and its transaction', async () => {
  const r = await handleOwnerText(deps({ chain: chain({ executed: true, proposeTx: '' }) }), 'pay');
  assert.equal(r.kind, 'failed');
  if (r.kind === 'failed') {
    assert.equal(r.stage, 'after-propose');
    assert.match(r.reason, /action #7 is on-chain/);
  }
});
