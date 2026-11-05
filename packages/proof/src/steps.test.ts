import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIER1_STEPS, failurePhase } from './steps.ts';

test('failurePhase: before send nothing was sent, send itself is "sent", everything after (including the browser-only steps) is "answered"', () => {
  assert.deepEqual(TIER1_STEPS.slice(0, 4), ['metadata', 'attestation', 'key-log', 'encrypt']);
  for (const step of ['metadata', 'attestation', 'key-log', 'encrypt']) assert.equal(failurePhase(step), 'not-sent', step);
  assert.equal(failurePhase('send'), 'sent');
  for (const step of ['signature', 'sdk-check', 'proof', 'store', 'commit']) assert.equal(failurePhase(step), 'answered', step);
});
