// The stop button (SPEC §7.2 step 6): delete the agent's function-call key and pause it on the contract. Both are attempted
// whatever happens to the other, because stopping must do as much as it can. The key comes first: it needs no contract at
// all, and once it is gone the agent cannot sign anything.
export interface StopSteps {
  deleteKey: () => Promise<string>;
  pause: () => Promise<string>;
}
export type StepResult = { ok: true; tx: string } | { ok: false; error: string };
export interface StopReport {
  deleteKey: StepResult;
  pause: StepResult;
}

const attempt = async (fn: () => Promise<string>): Promise<StepResult> => {
  try {
    return { ok: true, tx: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

export async function stopAgent(steps: StopSteps): Promise<StopReport> {
  const deleteKey = await attempt(steps.deleteKey);
  const pause = await attempt(steps.pause);
  return { deleteKey, pause };
}
