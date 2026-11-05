import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Action, CommittedActionProof, Decision, ModelProof } from '@ainek/proof';
import { renderCard } from './card.ts';
import type { Result } from './pipeline.ts';

const cfg = { explorer: 'https://testnet.nearblocks.io', tokenDecimals: 6 };
const action: Action = { kind: 'ft_transfer', token_id: 'token.ainek.testnet', receiver_id: 'vendor1.testnet', amount: '300000000', memo: '' };
const modelProof = { model: 'z-ai/glm-5.3-flash', logIndex: 3, commitTx: 'MTX' } as unknown as ModelProof;
const proofOf = (verdict: Decision['verdict'], over: Partial<CommittedActionProof> = {}) => ({ actionId: 7, action, decision: { verdict, policy_version: 3, policy_hash: 'ef'.repeat(32) }, commit: 'ab'.repeat(32), teePubkey: '12'.repeat(32), wasmHash: '34'.repeat(32), attestationUrl: 'https://api.test/attestations/c1', proposeTx: 'PTX', executeTx: verdict === 'Allow' ? 'PTX' : null, commitTx: 'CTX', ...over }) as unknown as CommittedActionProof;
const proposed = (proof: CommittedActionProof, commitError: string | null = null): Result => ({ kind: 'proposed', proof, purpose: 'October', modelProof, commitError });

test('Allow and executed: the payment in the owner\'s units with the purpose, the model line, both commits, the contract transaction', () => {
  const { text, approval } = renderCard(proposed(proofOf('Allow')), cfg);
  assert.match(text, /^✓ Allowed by policy v3 and executed/);
  assert.match(text, /300 token\.ainek\.testnet to vendor1\.testnet \("October"\)/);
  assert.match(text, /key #3 in the public log/);
  assert.match(text, /nearblocks\.io\/txns\/PTX/);
  assert.match(text, /action proof https:\/\/testnet\.nearblocks\.io\/txns\/CTX/);
  assert.match(text, /model proof https:\/\/testnet\.nearblocks\.io\/txns\/MTX/);
  assert.equal(approval, null);
});

test('the card says only what this service checked: the signature, not the attestation behind the url', () => {
  const { text } = renderCard(proposed(proofOf('Allow')), cfg);
  assert.match(text, /signature verifies under the registered policy key/);
  assert.match(text, /attestation \(not checked by this service\): https:\/\/api\.test\/attestations\/c1/);
  assert.doesNotMatch(text, /signed in the OutLayer TEE/);
});

test('Deny says nothing moved; NeedsApproval asks and carries the action id; Allow without execution does not claim execution', () => {
  assert.match(renderCard(proposed(proofOf('Deny')), cfg).text, /^✗ Denied by policy v3\. Nothing moved\./);
  const needs = renderCard(proposed(proofOf('NeedsApproval')), cfg);
  assert.match(needs.text, /^\? Needs your approval/);
  assert.equal(needs.approval, 7);
  const odd = renderCard(proposed(proofOf('Allow', { executeTx: null })), cfg).text;
  assert.match(odd, /reported no execution/);
  assert.doesNotMatch(odd, /and executed/);
});

test('a failed action commit is shown with its reason; no card calls a proof a receipt', () => {
  const { commitTx: _gone, ...uncommitted } = proofOf('Allow');
  const { text } = renderCard(proposed(uncommitted as CommittedActionProof, 'not enough prepaid storage'), cfg);
  assert.match(text, /Action proof not committed: not enough prepaid storage\./);
  assert.doesNotMatch(text, /action proof https/);
  assert.doesNotMatch(text, /receipt/i);
});

test('the stops each say what did and did not happen', () => {
  const m = modelProof;
  assert.match(renderCard({ kind: 'not-sent', step: 'key-log', reason: 'key not logged' }, cfg).text, /Your message was not sent to the model \(key-log\): key not logged\nNothing was proposed/);
  assert.match(renderCard({ kind: 'decision-rejected', modelProof: m, checks: [{ id: 'decision-key', status: 'fail', detail: 'signed by another key' }, { id: 'wasm-hash', status: 'ok', detail: 'fine' }] }, cfg).text, /no gas was spent:\n- signed by another key\n/);
  for (const stage of ['policy', 'commit', 'store', 'model'] as const) assert.match(renderCard({ kind: 'failed', stage, reason: 'x' }, cfg).text, /Nothing was proposed/);
  const chain = renderCard({ kind: 'failed', stage: 'chain', reason: 'timeout' }, cfg).text;
  assert.match(chain, /a transaction may have landed/);
  assert.doesNotMatch(chain, /Nothing was proposed/);
  const after = renderCard({ kind: 'failed', stage: 'after-propose', reason: 'action #7 is on-chain (transaction T), but its proof could not be built: x' }, cfg).text;
  assert.match(after, /action #7 is on-chain/);
  assert.doesNotMatch(after, /Nothing was proposed/);
});
