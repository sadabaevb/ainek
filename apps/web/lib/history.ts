import type { ChatOutcome } from './flow.ts';
import type { ChatMessage } from './nearai-requests.ts';

/** The part of a turn the next request's history is built from. */
export interface HistoryTurn {
  message: ChatMessage;
  /** The model the turn was sent to. */
  model: string;
  /** `reply` exists only on a reply that passed its route's checks; a failed outcome carries `unverifiedReply` (lib/flow.ts). */
  outcome?: (Pick<ChatOutcome, 'kind'> & { reply?: string }) | undefined;
}

/** The outcome kind whose turns a message to `model` may carry. The private model is only ever sent end-to-end encrypted,
 *  so it gets verified turns. Any other model may go out in plaintext (the route is chosen per request, from the
 *  gateway's metadata), so it gets only turns that were plaintext already: a turn that happened to be encrypted for it
 *  is never repeated in the clear. */
function carriedKind(model: string, privateModel: string): ChatOutcome['kind'] {
  return model === privateModel ? 'verified' : 'non-tee';
}

function carried(turn: HistoryTurn, model: string, privateModel: string): turn is HistoryTurn & { outcome: { reply: string } } {
  return turn.model === model && turn.outcome?.kind === carriedKind(model, privateModel) && typeof turn.outcome.reply === 'string';
}

/** The earlier exchanges to send along with a new message to `model`: the turns that went to that same model, on the
 *  route `carriedKind` allows, and came back with a checked reply. Each model sees only its own thread. Otherwise
 *  switching to the Incognito model would send every earlier private exchange through our relay in plaintext, and the
 *  private model would be handed another model's text as its own words. A turn whose checks failed is shown, marked as
 *  not verified, and left out whole: the question without its answer would mislead the model as well. */
export function chatHistory(turns: readonly HistoryTurn[], model: string, privateModel: string): ChatMessage[] {
  return turns.flatMap((turn) => (carried(turn, model, privateModel) ? [turn.message, { role: 'assistant' as const, content: turn.outcome.reply }] : []));
}

/** Whether the conversation has an answered exchange the next message to `model` will not carry, so the page can say so. */
export function hasOtherThread(turns: readonly HistoryTurn[], model: string, privateModel: string): boolean {
  return turns.some((turn) => typeof turn.outcome?.reply === 'string' && !carried(turn, model, privateModel));
}
