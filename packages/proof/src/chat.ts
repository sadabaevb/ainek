// The decrypted reply of `/v1/chat/completions`, as both clients read it (the browser's flow and the Node runner). A 200 can carry an error
// envelope or a truncated body, and a tool call of a kind nobody reads must not vanish silently: an agent would take a real answer for
// "the model did nothing". So the shape is checked once, here, and a reply that fails it fails the send step with a clear reason.
import { z } from 'zod';

const ChatCompletionShape = z.looseObject({
  object: z.literal('chat.completion'),
  id: z.string().min(1),
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({
          content: z.string().nullish(),
          tool_calls: z.array(z.looseObject({ id: z.string(), type: z.literal('function'), function: z.looseObject({ name: z.string().min(1), arguments: z.string() }) })).nullish(),
        }),
      }),
    )
    .min(1),
});
export type ChatCompletionShape = z.infer<typeof ChatCompletionShape>;

export function parseChatCompletion(plaintext: string): ChatCompletionShape {
  const parsed = ChatCompletionShape.safeParse(JSON.parse(plaintext));
  if (!parsed.success) throw new Error(`unexpected response shape: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
  return parsed.data;
}
