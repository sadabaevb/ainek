export { canonicalJson, canonicalBytes, compareCodePoints, CanonicalError } from './canonical.ts';
export type { JsonValue } from './canonical.ts';
export { sha256Hex, utf8Bytes, bytesToHex, hexToBytes, concatBytes, isHex64, randomHex32, shortHex } from './hash.ts';
export { parseSignedText } from './signed-text.ts';
export type { SignedText } from './signed-text.ts';
export { verifySignedText, decodeSignature } from './signature.ts';
export type { SignatureCheck } from './signature.ts';
export { commitOf, proofPayload, actionCommitOf, entryHashOf } from './commit.ts';
export { verifyModelProof, withChecks } from './verify.ts';
export type { VerifyReport, Check, CheckId, CheckStatus } from './verify.ts';
export {
  ModelProof,
  ActionProof,
  Proof,
  Action,
  Decision,
  Verdict,
  KeyEntryInput,
  KeyEntry,
  SignatureResponse,
  ProofCommitRecord,
  SigningAlgo,
  hex64,
} from './schema.ts';
export { DEMO_SWAPPED_KEY, evaluateKeyLog, findSplitView, proofEntryOf, resolveLogEntry, verifiersOf } from './key-log.ts';
export { TIER1_STEPS, failurePhase } from './steps.ts';
export type { Tier1StepId, FailurePhase } from './steps.ts';
export type { KeyLogQuery, KeyLogReason, KeyLogVerdict, KeyLogStatus, SplitView, ResolvedEntry } from './key-log.ts';
export { buildModelProof, buildCheckedModelProof, buildActionProof } from './build.ts';
export type { BuildActionProofInput, CommittedActionProof } from './build.ts';
export { withRetry } from './retry.ts';
export { parseChatCompletion } from './chat.ts';
export { PolicyInput, PolicyOutput, checkPolicyOutput, verifyActionProof, verifyDecisionSignature } from './policy.ts';
export type { RetryOptions } from './retry.ts';
export type { BuildModelProofInput } from './build.ts';
export { Disclosure, toDisclosure, parseDisclosure, isDisclosure, bytesToBase64, base64ToBytes } from './disclosure.ts';
export type { DisclosedExchange, ParsedDisclosure } from './disclosure.ts';
export { buildKeyEntryInput, composeHashOf, imageDigestsOf } from './key-entry.ts';
export type { BuildKeyEntryInputParams, VerifiedModelEvidence } from './key-entry.ts';
export { toModelAttestation, toGatewayAttestation } from './report.ts';
export type { RawAttestation, RawReport, ModelAttestationInput, GatewayAttestationInput } from './report.ts';
export { stripHexPrefix, normalizeHex } from './hash.ts';
export { ainekConfigFromEnv, explorerTxUrl } from './config.ts';
export type { AinekConfig, EnvLike } from './config.ts';
export { actionRunChecks, actionStatusProblem, checkActionProof, verifyActionProofOnChain } from './action-on-chain.ts';
export type { ActionVerdict } from './action-on-chain.ts';
export type { ActionReport } from './policy.ts';
export { PolicyRun, checkPolicyRun, policySecretsRef, quoteVerifierOf, tryVerifyQuote, verifyPolicyRun } from './policy-run.ts';
export type { PolicyRunEvidence, QuoteVerifier, VerifiedQuote } from './policy-run.ts';
export { NEAR_ACCOUNT, chooseTrust, parseTrustSet, previewTrust } from './trust-set.ts';
export type { TrustPreview, TrustSet } from './trust-set.ts';
export { AGENT_KEY_METHODS, keyScopeProblem, viewFunction, keyLogReader, readProofCommit, readStorageBalance, checkProofCommit, isAlreadyCommitted, ContractMethodNotFound, LOG_WINDOW_NS, ANY_AGE_NS } from './near-view.ts';
export type { KeyLogReader, ProofCommitLookup } from './near-view.ts';
export { TCB_STATUSES } from './config.ts';
export type { TcbStatusName } from './config.ts';
