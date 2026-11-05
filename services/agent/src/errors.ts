/** One line for any thrown value. No SDK here: the stop button must not load the inference SDK. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
