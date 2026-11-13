// The requests the browser sends through the relay, built in one place: nearai-browser.ts uses them, and the relay
// guard's test drives the same code, so the guard is checked against what the page really sends.
import { AttestationClient, NO_ALIASING_HEADER } from '@nearai/inference-sdk';
import type { REASONING_EFFORT } from './relay-guard';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** The SDK client for model metadata, attestations and signatures, pointed at the relay (`<origin>/api/nearai/v1`). */
export function relayAttestationClient(base: string): AttestationClient {
  return new AttestationClient({ baseUrl: base, headers: { [NO_ALIASING_HEADER]: 'true' } });
}

// No Accept-Encoding here: browsers drop it as a forbidden header; the proxy asks upstream for identity itself.
/** The plaintext Chat Completions request; prepareE2eeChatRequest encrypts it for the TEE models. `reasoningEffort` is
 *  given for the encrypted route only (see REASONING_EFFORT): the other model is another vendor's, and takes its default. */
export function chatRequest(base: string, model: string, messages: ChatMessage[], reasoningEffort?: typeof REASONING_EFFORT): Request {
  return new Request(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [NO_ALIASING_HEADER]: 'true' },
    body: JSON.stringify({ model, messages, stream: false, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }),
  });
}
