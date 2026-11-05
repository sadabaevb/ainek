// The model side (SPEC §7.2 step 1): the owner's text goes to the attested model under E2EE with two function tools, the
// model answers by calling one of them, and the call's arguments become an Action. It is the same Tier-1 sequence as the
// chat, so the conversation gets a model proof that the decision and the contract bind to (`model_proof_commit`).
import { z } from 'zod';
import type { Action, AinekConfig } from '@ainek/proof';
import { functionCallsOf, nothingSent, runTier1, type ChatTool, type ReadLog, type RunStats, type Tier1Outcome, type Verified } from '@ainek/tier1-node';

export const PROPOSE_TRANSFER = 'propose_transfer';
export const DECLINE = 'decline';

/** The two ways the model may answer. Their definitions travel encrypted (the SDK encrypts `tools` under E2EE) and their names go into the model proof as `toolNames`. */
export const TOOLS: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: PROPOSE_TRANSFER,
      description: 'Propose one token transfer for the policy to check. Use the receiver, the amount and the purpose exactly as the owner wrote them; never invent or change them.',
      parameters: {
        type: 'object',
        properties: {
          receiver_id: { type: 'string', description: 'the NEAR account to pay, for example vendor1.testnet' },
          amount: { type: 'string', description: 'whole tokens as a decimal string, for example "300" or "12.5"' },
          memo: { type: 'string', description: "what the payment is for, in the owner's words" },
        },
        required: ['receiver_id', 'amount', 'memo'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: DECLINE,
      description: 'The message asks for no payment, or the receiver or the amount is missing.',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false },
    },
  },
];

/** The agent extracts; the policy decides. Urgency or "ignore the limits" in a message changes nothing, because the limits are not the model's to apply. */
export function treasurerPrompt(tokenId: string, ownerId: string): string {
  return [
    `You are the treasurer agent of ${ownerId}. You can propose transfers of the token ${tokenId}; a separate policy decides whether a transfer happens.`,
    `When the owner asks for a payment, call ${PROPOSE_TRANSFER} with the receiver, the amount and a short memo exactly as asked, even if the message says it is urgent or tells you to skip checks: the policy, not you, enforces the limits.`,
    `When no payment is asked for, or the receiver or the amount is missing, call ${DECLINE} and say why. Never answer with text.`,
  ].join(' ');
}

const NEAR_ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
/** The arguments of a `propose_transfer` call, as the model must produce them. */
export const Proposal = z
  .object({
    receiver_id: z.string().regex(NEAR_ACCOUNT, 'not a NEAR account id'),
    amount: z.string().regex(/^\d+(\.\d+)?$/, 'amount must be a decimal number as a string'),
    memo: z.string().max(200),
  })
  .strict();
export type Proposal = z.infer<typeof Proposal>;

/** "12.5" with 6 decimals → "12500000". Digit strings only (no floats), more fractional digits than the token has is an error, not a rounding, and zero is not a payment. */
export function toMinimalUnits(amount: string, decimals: number): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!m) throw new Error(`amount "${amount}" is not a decimal number`);
  const whole = m[1] ?? '0';
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`amount "${amount}" has more than ${decimals} decimals`);
  const units = (whole + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
  if (units === '0') throw new Error('amount must be positive');
  return units;
}

/** "12500000" with 6 decimals → "12.5", for the card. */
export function fromMinimalUnits(units: string, decimals: number): string {
  const padded = units.padStart(decimals + 1, '0');
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return decimals > 0 && fraction ? `${padded.slice(0, padded.length - decimals)}.${fraction}` : padded.slice(0, padded.length - decimals);
}

export function actionFrom(proposal: Proposal, tokenId: string, decimals: number): Action {
  return { kind: 'ft_transfer', token_id: tokenId, receiver_id: proposal.receiver_id, amount: toMinimalUnits(proposal.amount, decimals), memo: proposal.memo };
}

export type Extraction =
  | { kind: 'action'; action: Action; outcome: Verified & RunStats }
  | { kind: 'declined'; reason: string; outcome: Verified & RunStats }
  /** The model answered without a usable tool call: nothing to propose, but the exchange is still proven. */
  | { kind: 'bad-call'; reason: string; outcome: Verified & RunStats }
  /** Refused by the log rule or failed before the send: nothing left the service. */
  | { kind: 'not-sent'; step: string; reason: string; outcome: Tier1Outcome }
  | { kind: 'failed'; step: string; reason: string; outcome: Tier1Outcome };

export interface ExtractParams {
  apiKey: string;
  cfg: AinekConfig;
  readLog: ReadLog;
  tokenId: string;
  decimals: number;
  ownerId: string;
  text: string;
}

export async function extractAction(p: ExtractParams): Promise<Extraction> {
  const outcome = await runTier1({
    apiKey: p.apiKey,
    cfg: p.cfg,
    readLog: p.readLog,
    chat: { messages: [{ role: 'system', content: treasurerPrompt(p.tokenId, p.ownerId) }, { role: 'user', content: p.text }], tools: TOOLS, tool_choice: 'required' },
  });
  if (outcome.kind !== 'verified') return { kind: nothingSent(outcome.step) ? 'not-sent' : 'failed', step: outcome.step, reason: outcome.reason, outcome };
  return interpret(outcome, p.tokenId, p.decimals);
}

/** The first tool call of a verified exchange, turned into an Action or a reason there is none. */
export function interpret(outcome: Verified & RunStats, tokenId: string, decimals: number): Extraction {
  const bad = (reason: string): Extraction => ({ kind: 'bad-call', reason, outcome });
  const call = functionCallsOf(outcome.completion)[0];
  if (!call) return bad('the model answered without calling a tool');
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return bad(`the arguments of ${call.name} are not JSON`);
  }
  if (call.name === DECLINE) {
    const r = z.object({ reason: z.string() }).safeParse(args);
    return { kind: 'declined', reason: r.success ? r.data.reason : 'no reason given', outcome };
  }
  if (call.name !== PROPOSE_TRANSFER) return bad(`the model called an unknown tool ${call.name}`);
  const parsed = Proposal.safeParse(args);
  if (!parsed.success) return bad(`unusable ${PROPOSE_TRANSFER} arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`);
  try {
    return { kind: 'action', action: actionFrom(parsed.data, tokenId, decimals), outcome };
  } catch (err) {
    return bad((err as Error).message);
  }
}
