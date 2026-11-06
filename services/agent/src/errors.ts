/** One line for any thrown value. No SDK here: the stop button must not load the inference SDK. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The transaction landed and the contract refused it: nothing moved. A timeout or a transport error is not this: there, a transaction may still have landed. */
export class ContractRefused extends Error {}
