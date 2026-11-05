// The policy side (SPEC §7.2 step 2): one HTTPS call to the OutLayer job with the §6.2 input; the job's signed decision
// comes back with the run's attestation URL. The answer is checked by `checkPolicyOutput` in the pipeline, not here.
import { setTimeout as sleep } from 'node:timers/promises';
import { PolicyOutput, type PolicyInput } from '@ainek/proof';

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
  return {
    evaluate: async (input) => {
      // One deadline for the POST and every poll: bot updates run one at a time, so a stalled socket here would block every later message.
      const signal = AbortSignal.timeout(timeoutMs);
      const call = async (url: string, init: RequestInit = {}): Promise<Answer> => {
        const res = await f(url, { ...init, headers, signal });
        const answer = (await res.json().catch(() => ({}))) as Answer;
        // A synchronous timeout (408) means the job may still be running: poll, never resend (a resend would run and be charged twice).
        if (!res.ok && !(res.status === 408 && answer.poll_url)) throw new Error(`OutLayer: ${answer.error ?? `HTTP ${res.status}`} (${answer.reason ?? `http_${res.status}`})`);
        return answer;
      };
      let answer = await call(`${apiUrl}/call/${project}`, { method: 'POST', body: JSON.stringify({ input }) });
      let pollUrl = answer.poll_url;
      while (answer.status !== 'completed' && answer.status !== 'failed') {
        if (!pollUrl) throw new Error(`OutLayer: unexpected answer status ${String(answer.status)}`);
        await sleep(pollMs, undefined, { signal });
        answer = await call(new URL(pollUrl, apiUrl).href);
        pollUrl = answer.poll_url ?? pollUrl;
      }
      if (answer.status === 'failed') throw new Error(`OutLayer: the policy job failed: ${answer.error ?? 'no error given'}`);
      if (!answer.attestation_url) throw new Error('OutLayer returned no attestation_url for this run');
      const raw: unknown = typeof answer.output === 'string' ? JSON.parse(answer.output) : answer.output; // a WASI job prints JSON to stdout; the platform may hand it over parsed or as text
      return { output: PolicyOutput.parse(raw), attestationUrl: new URL(answer.attestation_url, apiUrl).href };
    },
  };
}
