import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoJson } from './fixtures.ts';
import type { KeyEntry } from './schema.ts';
import { ContractMethodNotFound, checkProofCommit, keyScopeProblem, readProofCommit, viewFunction, type ProofCommitLookup, readStorageBalance } from './near-view.ts';

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

test('readProofCommit: a MethodResolveError other than MethodNotFound (a broken export) is an error, not "not-deployed"', async () => {
  rpcAnswering({ jsonrpc: '2.0', id: '1', result: { error: 'wasm execution failed with error: MethodResolveError(MethodInvalidSignature)', logs: [], block_height: 1 } });
  await assert.rejects(lookup, /MethodInvalidSignature/);
});

test('readProofCommit: null or boolean u64 fields are rejected, not coerced to 0', async () => {
  rpcAnswering(viewResult({ kind: 'model', log_index: null, block_height: true }));
  await assert.rejects(lookup);
});

test('keyLogReader.verifiers: the registered accounts, through the contract view', async () => {
  const { keyLogReader } = await import('./near-view.ts');
  const calls = rpcAnswering(viewResult(['a.testnet', 'b.testnet']));
  assert.deepEqual(await keyLogReader('http://rpc.test', 'ainek.testnet').verifiers(), ['a.testnet', 'b.testnet']);
  assert.deepEqual(calls, [{ method: 'verifiers', args: {} }]);
});

test('keyLogReader.latestKeys: the fail-closed window by default, any age when asked (the contract subtracts with saturation)', async () => {
  const { keyLogReader, LOG_WINDOW_NS, ANY_AGE_NS } = await import('./near-view.ts');
  const calls = rpcAnswering(viewResult([]));
  const reader = keyLogReader('http://rpc.test', 'ainek.testnet');
  await reader.latestKeys('z-ai/glm-5.3-flash');
  await reader.latestKeys('z-ai/glm-5.3-flash', ANY_AGE_NS);
  assert.deepEqual(calls.map((c) => c.args), [{ model: 'z-ai/glm-5.3-flash', max_age_ns: LOG_WINDOW_NS }, { model: 'z-ai/glm-5.3-flash', max_age_ns: ANY_AGE_NS }]);
  assert.equal(LOG_WINDOW_NS, '86400000000000');
  assert.equal(ANY_AGE_NS, String(2n ** 64n - 1n));
});

const { entry: sampleEntry } = readRepoJson<{ entry: KeyEntry }>('docs/samples/key-entry.sample.json');
const logEntry = (index: number, verifier: string): KeyEntry => ({ ...sampleEntry, index, verifier });

test('latestKeysFor: each trusted verifier is read on its own, so a flood from another verifier cannot push its entries out', async () => {
  const { latestKeysFor, LOG_WINDOW_NS } = await import('./near-view.ts');
  const asked: unknown[] = [];
  const flood = [9, 8, 7].map((i) => logEntry(i, 'noisy.testnet'));
  const reader = {
    latestKeys: async (_model: string, maxAgeNs?: string, _signal?: AbortSignal, verifier?: string) => {
      asked.push([maxAgeNs, verifier]);
      if (verifier === undefined) return flood; // the general window holds only the flood
      return verifier === 'a.testnet' ? [logEntry(2, 'a.testnet')] : verifier === 'b.testnet' ? [logEntry(8, 'noisy.testnet'), logEntry(1, 'b.testnet')] : [];
    },
  };
  const entries = await latestKeysFor(reader, 'm', ['a.testnet', 'b.testnet', 'a.testnet', 'Not An Account'], LOG_WINDOW_NS);
  assert.deepEqual(entries.map((e) => e.index), [9, 8, 7, 2, 1], 'merged newest first, each index once');
  assert.deepEqual(asked, [[LOG_WINDOW_NS, undefined], [LOG_WINDOW_NS, 'a.testnet'], [LOG_WINDOW_NS, 'b.testnet']], 'one general read, one per distinct valid verifier');
});

test('latestKeysFor: one failed read fails the whole, a partial window never passes for the log', async () => {
  const { latestKeysFor } = await import('./near-view.ts');
  const reader = { latestKeys: async (_m: string, _a?: string, _s?: AbortSignal, verifier?: string) => (verifier === 'b.testnet' ? Promise.reject(new Error('rpc down')) : []) };
  await assert.rejects(latestKeysFor(reader, 'm', ['a.testnet', 'b.testnet']), /rpc down/);
});

test('latestKeysFor: a large trust set is read a few at a time, and a failure stops the reads still in flight', async () => {
  const { latestKeysFor } = await import('./near-view.ts');
  /** A reader that counts its calls and how many run at once; it fails on `failOn` and notes the signals it saw aborted. */
  const counting = (failOn?: string) => {
    const seen = { calls: 0, inFlight: 0, most: 0, aborted: 0 };
    const latestKeys = async (_m: string, _a?: string, signal?: AbortSignal, verifier?: string): Promise<KeyEntry[]> => {
      seen.calls++;
      seen.most = Math.max(seen.most, ++seen.inFlight);
      signal?.addEventListener('abort', () => seen.aborted++);
      await new Promise((r) => setTimeout(r, 2));
      seen.inFlight--;
      if (failOn !== undefined && verifier === failOn) throw new Error('rpc down');
      return [];
    };
    return { seen, reader: { latestKeys } };
  };
  const many = Array.from({ length: 40 }, (_, i) => `v${i}.testnet`);

  const calm = counting();
  assert.deepEqual(await latestKeysFor(calm.reader, 'm', many), []);
  assert.equal(calm.seen.calls, 41, 'the general read and one per verifier');
  assert.ok(calm.seen.most > 1 && calm.seen.most <= 6, `reads overlap, at most 6 at once, saw ${calm.seen.most}`);

  const failing = counting('v3.testnet');
  await assert.rejects(latestKeysFor(failing.reader, 'm', many), /rpc down/);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(failing.seen.calls <= 12, `no new reads start after the failure, saw ${failing.seen.calls} of 41`);
  assert.ok(failing.seen.aborted > 0, 'the reads in flight were told to stop');
});

test('keyLogReader.latestKeys: the verifier filter goes to the contract only when asked for', async () => {
  const { keyLogReader, LOG_WINDOW_NS } = await import('./near-view.ts');
  const calls = rpcAnswering(viewResult([]));
  await keyLogReader('http://rpc.test', 'ainek.testnet').latestKeys('m', undefined, undefined, 'a.testnet');
  assert.deepEqual(calls.map((c) => c.args), [{ model: 'm', max_age_ns: LOG_WINDOW_NS, verifier: 'a.testnet' }]);
});

test('readStorageBalance: the U128 decimal string becomes a bigint, with the call shape of SPEC §4.2', async () => {
  const calls = rpcAnswering(viewResult('10000000000000000000000'));
  assert.equal(await readStorageBalance('http://rpc.test', 'ainek.testnet', 'alice.testnet'), 10n ** 22n);
  assert.deepEqual(calls, [{ method: 'storage_balance_of', args: { account: 'alice.testnet' } }]);
  rpcAnswering(viewResult('0'));
  assert.equal(await readStorageBalance('http://rpc.test', 'ainek.testnet', 'alice.testnet'), 0n);
  rpcAnswering(viewResult(12));
  await assert.rejects(readStorageBalance('http://rpc.test', 'ainek.testnet', 'alice.testnet'));
});

test('viewFunction: an aborted signal ends the call at once, with no retry', async () => {
  let calls = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls++;
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  await assert.rejects(viewFunction('http://rpc.test', 'ainek.testnet', 'latest_keys', {}, AbortSignal.abort()), (err: unknown) => err instanceof Error && err.name === 'AbortError');
  assert.equal(calls, 1);
});

test('viewFunction: a response cut off while its body is read is retried (seen live: "terminated", read ETIMEDOUT)', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) return { status: 200, ok: true, json: async () => { throw new TypeError('terminated'); } } as unknown as Response;
    return new Response(JSON.stringify(viewResult(7)), { status: 200 });
  }) as typeof fetch;
  assert.equal(await viewFunction('http://rpc.test', 'c.testnet', 'm', {}), 7);
  assert.equal(calls, 2);
});

test('keyScopeProblem: only a function-call key for this contract and exactly these two methods passes', () => {
  const key = (receiver_id: string, method_names: string[]) => ({ FunctionCall: { allowance: '1', receiver_id, method_names } });
  assert.equal(keyScopeProblem(key('c.testnet', ['propose_action', 'commit_proof']), 'c.testnet'), null);
  assert.match(keyScopeProblem('FullAccess', 'c.testnet') ?? '', /not a function-call key/);
  assert.match(keyScopeProblem(key('other.testnet', ['propose_action', 'commit_proof']), 'c.testnet') ?? '', /scoped to other\.testnet/);
  assert.match(keyScopeProblem(key('c.testnet', []), 'c.testnet') ?? '', /\[any\]/);
  assert.match(keyScopeProblem(key('c.testnet', ['propose_action', 'commit_proof', 'approve']), 'c.testnet') ?? '', /approve/);
});

test('viewAccessKeys: the keys of an account as the RPC lists them, and an error the node reports names the account', async () => {
  const { viewAccessKeys } = await import('./near-view.ts');
  const sent: unknown[] = [];
  const keys = [{ public_key: 'ed25519:abc', access_key: { nonce: 1, permission: 'FullAccess' } }, { public_key: 'ed25519:def', access_key: { nonce: 2, permission: { FunctionCall: { receiver_id: 'ainek.testnet', method_names: ['commit_proof'], allowance: '1' } } } }];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push((JSON.parse(String(init?.body)) as { params: unknown }).params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { keys, block_height: 1, block_hash: 'x' } }), { status: 200 });
  }) as typeof fetch;
  const read = await viewAccessKeys('http://rpc.test', 'agent.testnet');
  assert.deepEqual(read.map((k) => k.public_key), ['ed25519:abc', 'ed25519:def']);
  assert.equal(read[0]?.access_key.permission, 'FullAccess');
  assert.deepEqual(sent, [{ finality: 'final', request_type: 'view_access_key_list', account_id: 'agent.testnet' }]);
  globalThis.fetch = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', error: { message: 'Server error', data: 'invalid account id' } }), { status: 200 })) as typeof fetch;
  await assert.rejects(viewAccessKeys('http://rpc.test', 'Agent'), /access keys of Agent: invalid account id/);
});
