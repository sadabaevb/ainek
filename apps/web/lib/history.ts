import type { ChatMessage } from './nearai-requests.ts';

/** The part of a finished turn the next request's history is built from. */
export interface HistoryTurn {
  message: ChatMessage;
  outcome?: { kind: string; reply?: string } | undefined;
}

/** The earlier exchanges to send along with a new message: only turns whose reply passed its checks, or came over the
 *  Incognito route where the card already says it has no hardware proof. A reply whose signature or proof step failed is
 *  still shown, marked as unverified, but it is not fed back to the model: it may not be what the model said. */
export function chatHistory(turns: readonly HistoryTurn[]): ChatMessage[] {
  return turns.flatMap(({ message, outcome }) =>
    outcome && outcome.kind !== 'failed' && typeof outcome.reply === 'string' ? [message, { role: 'assistant' as const, content: outcome.reply }] : [],
  );
}
