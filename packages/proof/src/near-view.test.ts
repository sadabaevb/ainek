import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractMethodNotFound, checkProofCommit, readProofCommit, viewFunction, type ProofCommitLookup } from './near-view.ts';

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
const viewResult = (value: unknown): unknown => ({ jsonrpc: '2.0', id: '1', result: { result: Array.from(Buffer.from(JSON.stringify(value))), logs: [], block_height: 1 } });
const METHOD_MISSING = { jsonrpc: '2.0', id: '1', result: { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)', logs: [], block_height: 1 } };
const COMMIT = 'ab'.repeat(32);
const lookup = () => readProofCommit('http://rpc.test', 'ainek.testnet', 'alice.testnet', COMMIT);

test('readProofCommit: a committed hash comes back as found, with the call shape of SPEC §4.2', async () => {
  const calls = rpcAnswering(viewResult({ kind: 'model', log_index: 0, block_height: 123456 }));
  assert.deepEqual(await lookup(), { status: 'found', record: { kind: 'model', log_index: 0, block_height: 123456 } });
  assert.deepEqual(calls, [{ method: 'proof_commit', args: { account: 'alice.testnet', commit: COMMIT } }]);
});

test('readProofCommit: u64 fields are accepted as decimal strings as well as numbers', async () => {
  rpcAnswering(viewResult({ kind: 'action', log_index: '7', block_height: '99' }));
  assert.deepEqual(await lookup(), { status: 'found', record: { kind: 'action', log_index: 7, block_height: 99 } });
});

test('readProofCommit: Option::None is "none"', async () => {
  rpcAnswering(viewResult(null));
  assert.deepEqual(await lookup(), { status: 'none' });
});

test('readProofCommit: a contract without the view is "not-deployed", not an error', async () => {
  rpcAnswering(METHOD_MISSING);
  assert.deepEqual(await lookup(), { status: 'not-deployed' });
});

test('readProofCommit: other contract or RPC errors propagate', async () => {
  rpcAnswering({ jsonrpc: '2.0', id: '1', error: { message: 'Server error', data: 'account alice.testnet does not exist while viewing' } });
  await assert.rejects(lookup, /does not exist/);
});

test('readProofCommit: a malformed record is rejected', async () => {
  rpcAnswering(viewResult({ kind: 'model', log_index: -1, block_height: 5 }));
  await assert.rejects(lookup);
});

test('viewFunction: a missing method is a typed error for every view, so later views get the same detection', async () => {
  rpcAnswering(METHOD_MISSING);
  await assert.rejects(() => viewFunction('http://rpc.test', 'ainek.testnet', 'proposals', {}), (err: unknown) => err instanceof ContractMethodNotFound && /ainek\.testnet\.proposals/.test(err.message));
});

const found = (record: { kind: 'model' | 'action'; log_index: number; block_height: number }): ProofCommitLookup => ({ status: 'found', record });

test('checkProofCommit: the record must carry the proof kind and the log index the proof points at', () => {
  const proof = { kind: 'model' as const, logIndex: 0 };
  assert.equal(checkProofCommit(proof, found({ kind: 'model', log_index: 0, block_height: 42 }), 'alice.testnet').status, 'ok');
  assert.match(checkProofCommit(proof, found({ kind: 'model', log_index: 0, block_height: 42 }), 'alice.testnet').detail, /alice\.testnet at block 42/);
  assert.match(checkProofCommit(proof, found({ kind: 'action', log_index: 0, block_height: 42 }), 'alice.testnet').detail, /kind "action"/);
  assert.match(checkProofCommit(proof, found({ kind: 'model', log_index: 3, block_height: 42 }), 'alice.testnet').detail, /log_index 3/);
  assert.equal(checkProofCommit(proof, found({ kind: 'model', log_index: 3, block_height: 42 }), 'alice.testnet').status, 'fail');
});

test('checkProofCommit: no record is a failure, a contract without the view is a skip', () => {
  const proof = { kind: 'model' as const, logIndex: 0 };
  assert.deepEqual(checkProofCommit(proof, { status: 'none' }, 'alice.testnet'), { id: 'on-chain-commit', status: 'fail', detail: 'alice.testnet never committed this hash' });
  assert.equal(checkProofCommit(proof, { status: 'not-deployed' }, 'alice.testnet').status, 'skipped');
});
