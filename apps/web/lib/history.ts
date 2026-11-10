import type { ChatMessage } from './nearai-requests.ts';

/** The part of a turn the next request's history is built from. `outcome.reply` exists only for a reply that passed
 *  its route's checks: a failed outcome carries its text as `unverifiedReply` (lib/flow.ts). */
export interface HistoryTurn {
  message: ChatMessage;
  /** The model the turn was sent to. */
  model: string;
  outcome?: object | undefined;
}

/** The earlier exchanges to send along with a new message to `model`: the turns that went to that same model and came
 *  back with a checked reply. Each model sees only its own thread. Otherwise switching to the Incognito model would send
 *  every earlier private exchange through our relay in plaintext, and the private model would be handed another model's
 *  text as its own words. A reply whose checks failed is shown, marked as not verified, and not fed back either. */
export function chatHistory(turns: readonly HistoryTurn[], model: string): ChatMessage[] {
  return turns.flatMap((turn) => {
    const reply = turn.outcome && 'reply' in turn.outcome ? turn.outcome.reply : undefined;
    return turn.model === model && typeof reply === 'string' ? [turn.message, { role: 'assistant' as const, content: reply }] : [];
  });
}

/** Whether some earlier turn went to another model, so the next message to `model` will not carry it. */
export function hasOtherThread(turns: readonly HistoryTurn[], model: string): boolean {
  return turns.some((turn) => turn.model !== model);
}
