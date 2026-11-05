import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Action, Decision, ModelProof } from '@ainek/proof';
import { renderCard } from './card.ts';
import type { Result } from './pipeline.ts';
import type { CommittedActionProof } from './proof.ts';

const cfg = { explorer: 'https://testnet.nearblocks.io', tokenDecimals: 6 };
const action: Action = { kind: 'ft_transfer', token_id: 'token.ainek.testnet', receiver_id: 'vendor1.testnet', amount: '300000000', memo: 'October' };
const modelProof = { model: 'z-ai/glm-5.3-flash', logIndex: 3 } as unknown as ModelProof;
const decision = { verdict: 'Allow', policy_version: 3, policy_hash: 'ef'.repeat(32) } as unknown as Decision;
const proof = { action, decision, commit: 'ab'.repeat(32), teePubkey: '12'.repeat(32), wasmHash: '34'.repeat(32), attestationUrl: 'https://api.test/attestations/c1' } as unknown as CommittedActionProof;
const proposed = (over: Partial<Extract<Result, { kind: 'proposed' }>>): Result => ({ kind: 'proposed', verdict: 'Allow', actionId: 7, proposeTx: 'PTX', executed: true, proof, commitTx: 'CTX', modelCommitTx: 'MTX', commitError: null, modelProof, checks: [], ...over });

test('Allow and executed: the payment in the owner\'s units, the model line, the attestation, both transactions', () => {
  const { text, approval } = renderCard(proposed({}), cfg);
  assert.match(text, /^✓ Allowed by policy v3 and executed/);
  assert.match(text, /300 token\.ainek\.testnet to vendor1\.testnet \("October"\)/);
  assert.match(text, /key #3 in the public log/);
  assert.match(text, /attestation https:\/\/api\.test\/attestations\/c1/);
  assert.match(text, /nearblocks\.io\/txns\/PTX/);
  assert.match(text, /action proof https:\/\/testnet\.nearblocks\.io\/txns\/CTX/);
  assert.match(text, /model proof https:\/\/testnet\.nearblocks\.io\/txns\/MTX/);
  assert.doesNotMatch(text, /Not committed/);
  assert.equal(approval, null);
});

test('Deny says nothing moved; NeedsApproval asks and carries the action id; Allow without execution does not claim execution', () => {
  assert.match(renderCard(proposed({ verdict: 'Deny', executed: false }), cfg).text, /^✗ Denied by policy v3\. Nothing moved\./);
  const needs = renderCard(proposed({ verdict: 'NeedsApproval', executed: false }), cfg);
  assert.match(needs.text, /^\? Needs your approval/);
  assert.equal(needs.approval, 7);
  const odd = renderCard(proposed({ executed: false }), cfg).text;
  assert.match(odd, /reported no execution/);
  assert.doesNotMatch(odd, /and executed/);
});

test('a failed commit is shown as not committed, with the reason; no card calls a proof a receipt', () => {
  const { text } = renderCard(proposed({ commitTx: null, modelCommitTx: null, commitError: 'not enough prepaid storage' }), cfg);
  assert.match(text, /Not committed: not enough prepaid storage\./);
  assert.doesNotMatch(text, /Salted commits/);
  assert.doesNotMatch(text, /receipt/i);
});

test('the stops: not sent, decision rejected and failed each say what did and did not happen', () => {
  assert.match(renderCard({ kind: 'not-sent', step: 'key-log', reason: 'key not logged' }, cfg).text, /Not sent to the model \(key-log\): key not logged\nNothing left this service/);
  assert.match(renderCard({ kind: 'decision-rejected', modelProof, checks: [{ id: 'decision-key', status: 'fail', detail: 'signed by another key' }, { id: 'wasm-hash', status: 'ok', detail: 'fine' }] }, cfg).text, /no gas was spent:\n- signed by another key\n/);
  assert.match(renderCard({ kind: 'failed', stage: 'policy', reason: 'insufficient_balance' }, cfg).text, /Nothing was proposed/);
  const chain = renderCard({ kind: 'failed', stage: 'chain', reason: 'timeout' }, cfg).text;
  assert.match(chain, /a transaction may have landed/);
  assert.doesNotMatch(chain, /Nothing was proposed/);
});
