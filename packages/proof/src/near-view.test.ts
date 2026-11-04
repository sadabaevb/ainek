import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { isMethodNotFoundMessage, readProofCommit } from './near-view.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stands in for the NEAR JSON-RPC: records the view call it received and answers with the given body. */
function rpcAnswering(body: unknown): Array<{ method: string; args: unknown }> {
  const calls: Array<{ method: string; args: unknown }> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { params: { method_name: string; args_base64: string } };
    calls.push({ method: req.params.method_name, args: JSON.parse(Buffer.from(req.params.args_base64, 'base64').toString('utf8')) });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

/** A successful view call: the contract's JSON return value as bytes. */
function viewResult(value: unknown): unknown {
  return { jsonrpc: '2.0', id: '1', result: { result: Array.from(Buffer.from(JSON.stringify(value))), logs: [], block_height: 1 } };
}

const COMMIT = 'ab'.repeat(32);

test('readProofCommit: a committed hash comes back as found, with the call shape of SPEC §4.2', async () => {
  const calls = rpcAnswering(viewResult({ kind: 'model', log_index: 0, block_height: 123456 }));
  const r = await readProofCommit('http://rpc.test', 'ainek.testnet', 'alice.testnet', COMMIT);
  assert.deepEqual(r, { status: 'found', record: { kind: 'model', log_index: 0, block_height: 123456 } });
  assert.deepEqual(calls, [{ method: 'proof_commit', args: { account: 'alice.testnet', commit: COMMIT } }]);
});

test('readProofCommit: u64 fields are accepted as decimal strings as well as numbers', async () => {
  rpcAnswering(viewResult({ kind: 'action', log_index: '7', block_height: '99' }));
  const r = await readProofCommit('http://rpc.test', 'ainek.testnet', 'alice.testnet', COMMIT);
  assert.deepEqual(r, { status: 'found', record: { kind: 'action', log_index: 7, block_height: 99 } });
});

test('readProofCommit: Option::None is "none"', async () => {
  rpcAnswering(viewResult(null));
  assert.deepEqual(await readProofCommit('http://rpc.test', 'ainek.testnet', 'alice.testnet', COMMIT), { status: 'none' });
});

test('readProofCommit: a contract without the view is "not-deployed", not an error', async () => {
  rpcAnswering({ jsonrpc: '2.0', id: '1', result: { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)', logs: [], block_height: 1 } });
  assert.deepEqual(await readProofCommit('http://rpc.test', 'ainek.testnet', 'alice.testnet', COMMIT), { status: 'not-deployed' });
});

test('readProofCommit: other contract or RPC errors propagate', async () => {
  rpcAnswering({ jsonrpc: '2.0', id: '1', error: { message: 'Server error', data: 'account alice.testnet does not exist while viewing' } });
  await assert.rejects(() => readProofCommit('http://rpc.test', 'ainek.testnet', 'alice.testnet', COMMIT), /does not exist/);
});

test('readProofCommit: a malformed record is rejected', async () => {
  rpcAnswering(viewResult({ kind: 'model', log_index: -1, block_height: 5 }));
  await assert.rejects(() => readProofCommit('http://rpc.test', 'ainek.testnet', 'alice.testnet', COMMIT));
});

test('isMethodNotFoundMessage matches the wordings seen from the RPC and the wallets', () => {
  assert.equal(isMethodNotFoundMessage('wasm execution failed with error: MethodResolveError(MethodNotFound)'), true);
  assert.equal(isMethodNotFoundMessage('Contract method is not found'), true);
  assert.equal(isMethodNotFoundMessage('account does not exist'), false);
});
