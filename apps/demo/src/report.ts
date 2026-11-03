// Raw `/v1/attestation/report` entries → the SDK's normalised evidence types (same mapping the SDK applies
// inside `AttestationClient`; exposed here because the pure verify functions take the normalised shape).
import type { GatewayAttestation, ModelAttestation } from '@nearai/inference-sdk/node';
import type { RawAttestation } from './evidence.ts';

export function toModelAttestation(raw: RawAttestation): ModelAttestation {
  const cm = raw.compose_manager_attestation;
  return {
    nonce: raw.request_nonce,
    signer: { signingAlgo: raw.signing_algo, signingAddress: raw.signing_address },
    intelQuote: raw.intel_quote,
    eventLog: raw.event_log as ModelAttestation['eventLog'],
    appCompose: raw.info.tcb_info.app_compose,
    ...(raw.signing_public_key === undefined ? {} : { signingPublicKey: raw.signing_public_key }),
    ...(raw.report_data === undefined ? {} : { reportedQuoteData: raw.report_data }),
    ...(raw.nvidia_payload === undefined ? {} : { nvidiaPayload: raw.nvidia_payload }),
    ...(cm === undefined
      ? {}
      : {
          composeManagerAttestation: {
            actions: cm.actions as never,
            actionsHash: cm.actions_hash,
            nonce: cm.nonce,
            intelQuote: cm.quote,
            eventLog: cm.event_log as ModelAttestation['eventLog'],
            reportedQuoteData: cm.report_data,
          },
        }),
  };
}

export function toGatewayAttestation(raw: RawAttestation): GatewayAttestation {
  return {
    nonce: raw.request_nonce,
    signer: { signingAlgo: raw.signing_algo, signingAddress: raw.signing_address },
    intelQuote: raw.intel_quote,
    eventLog: raw.event_log as GatewayAttestation['eventLog'],
    appCompose: raw.info.tcb_info.app_compose,
    reportedQuoteData: raw.report_data ?? '',
  };
}
