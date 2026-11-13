import { utf8Bytes } from '@ainek/proof';
import type { ChatOutcome } from './flow.ts';
import type { ChatMessage } from './nearai-requests.ts';
import { MAX_BODY_BYTES, MAX_MESSAGES } from './relay-guard.ts';

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

type CarriedTurn = HistoryTurn & { outcome: { reply: string } };

function carried(turn: HistoryTurn, model: string, privateModel: string): turn is CarriedTurn {
  return turn.model === model && turn.outcome?.kind === carriedKind(model, privateModel) && typeof turn.outcome.reply === 'string';
}

const utf8Length = (text: string): number => utf8Bytes(text).length;
/**
 * No less than what one message adds to the body of a request. Encrypted (SDK 0.3.0), a message is its text in hex, two
 * characters for each byte, in a wrapper of at most 178 bytes; in plaintext it is its JSON string and some 35 bytes
 * around it. history.test.ts encrypts real requests and holds this bound to them.
 */
const messageBytes = (content: string): number => Math.max(2 * utf8Length(content), utf8Length(JSON.stringify(content))) + 200;
/** The rest of a request: the model's name, the other fields, the brackets. */
const REQUEST_BYTES = 512;
/** Earlier exchanges one request can hold next to the new message, by the relay's count of messages. */
const MOST_EXCHANGES = Math.floor((MAX_MESSAGES - 1) / 2);

/**
 * The thread a message to `model` may carry, and how many of its latest exchanges fit in one request next to the new
 * message `next`. The relay forwards a request of limited size (lib/relay-guard.ts). Without this a long conversation,
 * or a few long answers, would end in a request the relay refuses, and so would every message after it. The cut is one
 * cut: an exchange that does not fit ends the history there, and smaller ones before it are not picked out from behind
 * it, since a conversation with a hole in the middle would mislead the model more than a shorter one.
 */
function fitted(turns: readonly HistoryTurn[], model: string, privateModel: string, next: string): { thread: CarriedTurn[]; kept: number } {
  const thread = turns.filter((turn): turn is CarriedTurn => carried(turn, model, privateModel));
  let room = MAX_BODY_BYTES - REQUEST_BYTES - messageBytes(next);
  let kept = 0;
  while (kept < Math.min(MOST_EXCHANGES, thread.length)) {
    const turn = thread[thread.length - 1 - kept]!;
    room -= messageBytes(turn.message.content) + messageBytes(turn.outcome.reply);
    if (room < 0) break;
    kept += 1;
  }
  return { thread, kept };
}

/** The earlier exchanges to send along with the new message `next` to `model`: the turns that went to that same model, on the
 *  route `carriedKind` allows, and came back with a checked reply, as many of the latest as fit one request (`fitted`).
 *  Each model sees only its own thread. Otherwise switching to the Incognito model would send every earlier private
 *  exchange through our relay in plaintext, and the private model would be handed another model's text as its own
 *  words. A turn whose checks failed is shown, marked as not verified, and left out whole: the question without its
 *  answer would mislead the model as well. */
export function chatHistory(turns: readonly HistoryTurn[], model: string, privateModel: string, next: string): ChatMessage[] {
  const { thread, kept } = fitted(turns, model, privateModel, next);
  return thread.slice(thread.length - kept).flatMap((turn) => [turn.message, { role: 'assistant' as const, content: turn.outcome.reply }]);
}

/** How many answered exchanges of its own thread the message `next` to `model` leaves behind for lack of room, so the page can say so. */
export function leftBehind(turns: readonly HistoryTurn[], model: string, privateModel: string, next: string): number {
  const { thread, kept } = fitted(turns, model, privateModel, next);
  return thread.length - kept;
}

/** Whether the conversation has an answered exchange the next message to `model` will not carry, so the page can say so. */
export function hasOtherThread(turns: readonly HistoryTurn[], model: string, privateModel: string): boolean {
  return turns.some((turn) => typeof turn.outcome?.reply === 'string' && !carried(turn, model, privateModel));
}
