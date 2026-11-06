// The policy side (SPEC §7.2 step 2): one HTTPS call to the OutLayer job with the §6.2 input; the job's signed decision
// comes back with the run's attestation URL. The answer is checked by `checkPolicyOutput` in the pipeline, not here.
import { setTimeout as sleep } from 'node:timers/promises';
import { PolicyOutput, canonicalJson, type Check, type PolicyInput } from '@ainek/proof';
import { verifyPolicyRunAt } from '@ainek/tier1-node/dcap';

export interface PolicyResult {
  output: PolicyOutput;
  /** Absolute and valid, so an action proof built from it after the money moved cannot fail on it. */
  attestationUrl: string;
}
export interface PolicyEvaluator {
  evaluate(input: PolicyInput): Promise<PolicyResult>;
}

/** The documented answer of `POST /call/{owner}/{project}` and of the poll URL; empty fields are absent. */
interface Answer {
  status?: 'completed' | 'failed' | 'pending';
  output?: unknown;
  error?: string;
  reason?: string;
  poll_url?: string;
  attestation_url?: string;
}

export function outLayerPolicy({ apiUrl, paymentKey, project, fetch: f = fetch, pollMs = 1000, timeoutMs = 120_000 }: { apiUrl: string; paymentKey: string; /** `owner.testnet/project` */ project: string; fetch?: typeof fetch; pollMs?: number; timeoutMs?: number }): PolicyEvaluator {
  const headers = { 'content-type': 'application/json', 'x-payment-key': paymentKey };
  const apiOrigin = new URL(apiUrl).origin;
  return {
    evaluate: async (input) => {
      // One deadline for the POST and every poll: bot updates run one at a time, so a stalled socket here would block every later message.
      const signal = AbortSignal.timeout(timeoutMs);
      const call = async (url: string, init: RequestInit = {}): Promise<Answer> => {
        const res = await f(url, { ...init, headers, signal, redirect: 'error' }); // fetch would carry the payment key to wherever a redirect points
        const answer = (await res.json().catch(() => ({}))) as Answer;
        // A synchronous timeout (408) means the job may still be running: poll, never resend (a resend would run and be charged twice).
        if (!res.ok && !(res.status === 408 && answer.poll_url)) throw new Error(`OutLayer: ${answer.error ?? `HTTP ${res.status}`} (${answer.reason ?? `http_${res.status}`})`);
        return answer;
      };
      // OutLayer fetches secrets only when the call asks for them: without this the job has no policy and no key, and exits 1.
      const secretsRef = { profile: 'default', account_id: project.split('/')[0] }; // the profile docs/DEPLOY.md sets them in, under the project owner
      // The input goes as canonical JSON: over HTTPS the attestation's `input_hash` covers the input as it was sent (key order included),
      // and `outLayerRunCheck` below compares it with the canonical bytes.
      let answer = await call(`${apiUrl}/call/${project}`, { method: 'POST', body: `{"input":${canonicalJson(input)},"secrets_ref":${JSON.stringify(secretsRef)}}` });
      let pollUrl = answer.poll_url;
      while (answer.status !== 'completed' && answer.status !== 'failed') {
        if (!pollUrl) throw new Error(`OutLayer: unexpected answer status ${String(answer.status)}`);
        await sleep(pollMs, undefined, { signal });
        // The payment key goes only to the API it belongs to: a poll_url on another host would receive it.
        const target = new URL(pollUrl, apiUrl);
        if (target.origin !== apiOrigin) throw new Error(`OutLayer: poll_url points at ${target.origin}, refusing to send the payment key there`);
        answer = await call(target.href);
        pollUrl = answer.poll_url ?? pollUrl;
      }
      if (answer.status === 'failed') throw new Error(`OutLayer: the policy job failed: ${answer.error ?? 'no error given'}`);
      if (!answer.attestation_url) throw new Error('OutLayer returned no attestation_url for this run');
      const raw: unknown = typeof answer.output === 'string' ? JSON.parse(answer.output) : answer.output; // a WASI job prints JSON to stdout; the platform may hand it over parsed or as text
      const attestation = new URL(answer.attestation_url, apiUrl);
      if (attestation.protocol !== 'https:') throw new Error(`OutLayer: attestation_url is not https (${attestation.protocol})`);
      // The check below reads the record from here and action proofs keep this URL for auditors, so it must be the API's own.
      if (attestation.origin !== apiOrigin) throw new Error(`OutLayer: attestation_url points at ${attestation.origin}, not at the API`);
      return { output: PolicyOutput.parse(raw), attestationUrl: attestation.href };
    },
  };
}

/** A decision lives ten minutes (§6.2), so a run older than that cannot be the one just asked for. */
const MAX_RUN_AGE_SECONDS = 600;

/** Which code made the decision: the signature names only a key, and that key is not tied to a build (SPEC §3.5). The job reads and prints canonical JSON, so these are the bytes the attestation covers. */
export function outLayerRunCheck(cfg: { apiUrl: string; project: string; wasmHash: string; rpcUrl: string; network: 'testnet' | 'mainnet'; fetch?: typeof fetch; pollMs?: number; now?: () => number }) {
  const { now = Date.now, ...rest } = cfg;
  return (attestationUrl: string, input: PolicyInput, output: PolicyOutput): Promise<Check[]> =>
    verifyPolicyRunAt(attestationUrl, { ...rest, input: canonicalJson(input), output: canonicalJson(output), freshness: { nowSeconds: Math.floor(now() / 1000), maxAgeSeconds: MAX_RUN_AGE_SECONDS } });
}
