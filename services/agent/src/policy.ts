// The policy side (SPEC §7.2 step 2): one HTTPS call to the OutLayer job with the §6.2 input; the job's signed decision
// comes back with the run's attestation URL. The answer is checked by `checkPolicyOutput` in the pipeline, not here.
import { PolicyOutput, type PolicyInput } from '@ainek/proof';

export interface PolicyResult {
  output: PolicyOutput;
  callId: string;
  attestationUrl: string | null;
  timeMs: number | null;
}
export interface PolicyEvaluator {
  evaluate(input: PolicyInput): Promise<PolicyResult>;
}

/** An OutLayer refusal or job failure, with the platform's machine-readable `reason` (invalid_key, insufficient_balance, project_not_allowed, rate_limit_exceeded, …). */
export class OutLayerError extends Error {
  readonly reason: string;
  readonly status: number;
  constructor(message: string, reason: string, status: number) {
    super(message);
    this.reason = reason;
    this.status = status;
  }
}

/** The documented answer of `POST /call/{owner}/{project}` and of the poll URL; empty fields are absent. */
interface Answer {
  call_id?: string;
  status?: 'completed' | 'failed' | 'pending';
  output?: unknown;
  error?: string;
  reason?: string;
  poll_url?: string;
  attestation_url?: string;
  time_ms?: number;
}

export interface OutLayerOptions {
  apiUrl: string;
  paymentKey: string;
  /** `owner.testnet/project` */
  project: string;
  fetch?: typeof fetch;
  pollMs?: number;
  maxPolls?: number;
}

export function outLayerPolicy({ apiUrl, paymentKey, project, fetch: f = fetch, pollMs = 1000, maxPolls = 30 }: OutLayerOptions): PolicyEvaluator {
  const headers = { 'content-type': 'application/json', 'x-payment-key': paymentKey };
  const refusal = (status: number, answer: Answer) => new OutLayerError(answer.error ?? `OutLayer HTTP ${status}`, answer.reason ?? `http_${status}`, status);
  const settle = (answer: Answer): PolicyResult => {
    if (answer.status === 'failed') throw new OutLayerError(answer.error ?? 'the policy job failed', 'job_failed', 200);
    if (answer.status !== 'completed') throw new OutLayerError(`unexpected answer status ${String(answer.status)}`, 'bad_answer', 200);
    const raw: unknown = typeof answer.output === 'string' ? JSON.parse(answer.output) : answer.output; // a WASI job prints JSON to stdout; the platform may hand it over parsed or as text
    return { output: PolicyOutput.parse(raw), callId: answer.call_id ?? '', attestationUrl: answer.attestation_url ?? null, timeMs: answer.time_ms ?? null };
  };
  const poll = async (url: string, polls: number): Promise<PolicyResult> => {
    if (polls >= maxPolls) throw new OutLayerError('the policy job did not finish in time', 'poll_timeout', 408);
    await new Promise((r) => setTimeout(r, pollMs));
    const res = await f(url.startsWith('http') ? url : `${apiUrl}${url}`, { headers });
    const answer = (await res.json().catch(() => ({}))) as Answer;
    if (!res.ok) throw refusal(res.status, answer);
    return answer.status === 'pending' ? poll(url, polls + 1) : settle(answer);
  };
  return {
    evaluate: async (input) => {
      const res = await f(`${apiUrl}/call/${project}`, { method: 'POST', headers, body: JSON.stringify({ input }) });
      const answer = (await res.json().catch(() => ({}))) as Answer;
      // A synchronous timeout (408) means the job may still be running: poll, never resend (a resend would run and be charged twice).
      if (res.status === 408 && answer.poll_url) return poll(answer.poll_url, 0);
      if (!res.ok) throw refusal(res.status, answer);
      return answer.status === 'pending' && answer.poll_url ? poll(answer.poll_url, 0) : settle(answer);
    },
  };
}
