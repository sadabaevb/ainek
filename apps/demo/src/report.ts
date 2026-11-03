// Raw report → SDK input shapes come from @ainek/proof; the SDK types are structurally identical, hence the casts.
import type { GatewayAttestation, ModelAttestation } from '@nearai/inference-sdk/node';
import { toGatewayAttestation as toGateway, toModelAttestation as toModel, type RawAttestation } from '@ainek/proof';

export const toModelAttestation = (raw: RawAttestation): ModelAttestation => toModel(raw) as ModelAttestation;
export const toGatewayAttestation = (raw: RawAttestation): GatewayAttestation => toGateway(raw) as GatewayAttestation;
