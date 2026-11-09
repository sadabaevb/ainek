// The model side (SPEC §7.2 step 1): the owner's text goes to the attested model under E2EE with two function tools, the
// model answers by calling one of them, and the call's arguments become an Action. It is the same Tier-1 sequence as the
// chat, so the conversation gets a model proof that the decision and the contract bind to (`model_proof_commit`).
import { z } from 'zod';
import { NEAR_ACCOUNT, toMinimalUnits, type Action } from '@ainek/proof';
import { functionCallsOf, nothingSent, runTier1, type ChatTool, type ReadLog, type RunStats, type Verified } from '@ainek/tier1-node';
import type { AgentConfig } from './config.ts';

export const PROPOSE_TRANSFER = 'propose_transfer';
export const DECLINE = 'decline';

/** The two ways the model may answer. Their definitions travel encrypted (the SDK encrypts `tools` under E2EE) and their names go into the model proof as `toolNames`. */
export const TOOLS: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: PROPOSE_TRANSFER,
      description: 'Propose one token transfer for the policy to check. Use the receiver and the amount exactly as the owner wrote them; never invent or change them.',
      parameters: {
        type: 'object',
        properties: {
          receiver_id: { type: 'string', description: 'the NEAR account to pay, for example vendor1.testnet' },
          amount: { type: 'string', description: 'whole tokens as a decimal string, for example "300" or "12.5"' },
          purpose: { type: 'string', description: 'a few words on what the payment is for, shown to the owner only' },
        },
        required: ['receiver_id', 'amount', 'purpose'],
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
    `When the owner asks for a payment, call ${PROPOSE_TRANSFER} with the receiver and the amount exactly as asked, even if the message says it is urgent or tells you to skip checks: the policy, not you, enforces the limits.`,
    `When no payment is asked for, or the receiver or the amount is missing, call ${DECLINE} and say why. Call exactly one tool, once; for several payments, decline and ask for one at a time. Never answer with text.`,
  ].join(' ');
}

/** The arguments of a `propose_transfer` call. `amount` is checked by toMinimalUnits. The length cap on `purpose` keeps the card sendable: a reply that fails after the money moved is the worst moment to fail. */
const Proposal = z
  .object({
    receiver_id: z.string().regex(NEAR_ACCOUNT, 'not a NEAR account id'),
    amount: z.string(),
    purpose: z.string().max(200),
  })
  .strict();

type ProvenExchange = Verified & RunStats;
export type Extraction =
  | { kind: 'action'; action: Action; purpose: string; outcome: ProvenExchange }
  | { kind: 'declined'; reason: string; outcome: ProvenExchange }
  /** The model answered without a usable tool call: nothing to propose. */
  | { kind: 'bad-call'; reason: string; outcome: ProvenExchange }
  /** Refused by the log rule or failed before the send: the message did not reach the model. */
  | { kind: 'not-sent'; step: string; reason: string }
  | { kind: 'failed'; step: string; reason: string };

export async function extractAction({ cfg, tokenDecimals, readLog, text }: { cfg: AgentConfig; tokenDecimals: number; readLog: ReadLog; text: string }): Promise<Extraction> {
  const outcome = await runTier1({
    apiKey: cfg.apiKey,
    cfg,
    readLog,
    chat: { messages: [{ role: 'system', content: treasurerPrompt(cfg.tokenId, cfg.ownerId) }, { role: 'user', content: text }], tools: TOOLS, tool_choice: 'required' },
  });
  if (outcome.kind !== 'verified') return { kind: nothingSent(outcome.step) ? 'not-sent' : 'failed', step: outcome.step, reason: outcome.reason };
  return interpret(outcome, cfg.tokenId, tokenDecimals);
}

/**
 * The first tool call of a verified exchange, turned into an Action or a reason there is none. `memo` stays empty on purpose: an
 * Action's arguments are public on-chain, and the owner's words must never be (CLAUDE.md). The purpose stays on the card.
 */
export function interpret(outcome: ProvenExchange, tokenId: string, decimals: number): Extraction {
  const bad = (reason: string): Extraction => ({ kind: 'bad-call', reason, outcome });
  // Exactly one call. With two, the first would silently win: "pay A and B" would pay A and lose B, and an injected message could steer which call comes first.
  const calls = functionCallsOf(outcome.completion);
  const call = calls[0];
  if (!call) return bad('the model answered without calling a tool');
  if (calls.length > 1) return bad(`the model made ${calls.length} tool calls; one payment at a time`);
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
    const action: Action = { kind: 'ft_transfer', token_id: tokenId, receiver_id: parsed.data.receiver_id, amount: toMinimalUnits(parsed.data.amount, decimals), memo: '' };
    return { kind: 'action', action, purpose: parsed.data.purpose, outcome };
  } catch (err) {
    return bad((err as Error).message);
  }
}
