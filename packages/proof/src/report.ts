// The raw `/v1/attestation/report` reply and its mapping to the shape the SDK's pure verify functions take
// (`verifyModelAttestation` / `verifyGatewayAttestation`). The SDK applies the same mapping inside its
// AttestationClient; verifiers need it here because they must keep the exact report bytes for `report_hash`,
// which the client classes hide. Structural types only: this package does not depend on the SDK.

/** One attestation entry as received (snake_case wire shape; fields the SDK consumes). */
export interface RawAttestation {
  signing_address: string;
  signing_algo: 'ed25519' | 'ecdsa';
  signing_public_key?: string;
  request_nonce: string;
  intel_quote: string;
  event_log: string | unknown[];
  report_data?: string;
  nvidia_payload?: string;
  info: { tcb_info: { app_compose: string; compose_hash: string } };
  compose_manager_attestation?: {
    actions: unknown;
    actions_hash: string;
    nonce: string;
    quote: string;
    event_log: string | unknown[];
    report_data: string;
  };
}

export interface RawReport {
  gateway_attestation: RawAttestation;
  model_attestations: Array<RawAttestation & { model_name: string }>;
}

/** Shape-compatible with the SDK's `ModelAttestation` (cast at the call site; `actions` is opaque here). */
export interface ModelAttestationInput {
  nonce: string;
  signer: { signingAlgo: 'ed25519' | 'ecdsa'; signingAddress: string };
  intelQuote: string;
  eventLog: string | unknown[];
  appCompose: string;
  signingPublicKey?: string;
  reportedQuoteData?: string;
  nvidiaPayload?: string;
  composeManagerAttestation?: { actions: unknown; actionsHash: string; nonce: string; intelQuote: string; eventLog: string | unknown[]; reportedQuoteData: string };
}

/** Shape-compatible with the SDK's `GatewayAttestation` (no-TLS layout). */
export interface GatewayAttestationInput {
  nonce: string;
  signer: { signingAlgo: 'ed25519' | 'ecdsa'; signingAddress: string };
  intelQuote: string;
  eventLog: string | unknown[];
  appCompose: string;
  reportedQuoteData: string;
}

export function toModelAttestation(raw: RawAttestation): ModelAttestationInput {
  const cm = raw.compose_manager_attestation;
  return {
    nonce: raw.request_nonce,
    signer: { signingAlgo: raw.signing_algo, signingAddress: raw.signing_address },
    intelQuote: raw.intel_quote,
    eventLog: raw.event_log,
    appCompose: raw.info.tcb_info.app_compose,
    ...(raw.signing_public_key === undefined ? {} : { signingPublicKey: raw.signing_public_key }),
    ...(raw.report_data === undefined ? {} : { reportedQuoteData: raw.report_data }),
    ...(raw.nvidia_payload === undefined ? {} : { nvidiaPayload: raw.nvidia_payload }),
    ...(cm === undefined
      ? {}
      : { composeManagerAttestation: { actions: cm.actions, actionsHash: cm.actions_hash, nonce: cm.nonce, intelQuote: cm.quote, eventLog: cm.event_log, reportedQuoteData: cm.report_data } }),
  };
}

export function toGatewayAttestation(raw: RawAttestation): GatewayAttestationInput {
  return {
    nonce: raw.request_nonce,
    signer: { signingAlgo: raw.signing_algo, signingAddress: raw.signing_address },
    intelQuote: raw.intel_quote,
    eventLog: raw.event_log,
    appCompose: raw.info.tcb_info.app_compose,
    reportedQuoteData: raw.report_data ?? '',
  };
}
