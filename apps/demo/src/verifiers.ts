// Offline stand-ins for the two network verifiers the SDK normally runs. The SDK's own policy and binding
// checks (nonce in report data, signer in report data, app_compose vs MRCONFIGID, RTMR3 replay, GPU nonce)
// still run unchanged; only "fetch collateral from Intel" and "ask NVIDIA for a verdict" are replaced by the
// recording. Time is pinned to when the evidence was recorded, so freshness is explicitly not re-checked.
import type { GpuEvidenceVerifier, TdxQuoteVerifier } from '@nearai/inference-sdk/node';
import qvl from '@phala/dcap-qvl';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { sha256Hex, hexToBytes } from '@ainek/proof';

export function createRecordedTdxVerifier(collateralByQuote: Record<string, unknown>, nowSecs: number): TdxQuoteVerifier {
  return (quoteHex) => {
    const collateral = collateralByQuote[sha256Hex(quoteHex)];
    if (collateral === undefined) throw new Error(`no recorded Intel collateral for quote ${sha256Hex(quoteHex).slice(0, 8)}…`);
    const verified = qvl.verify(Buffer.from(hexToBytes(quoteHex)), collateral as qvl.Collateral, nowSecs);
    const td10 = verified.report.asTd10();
    if (!td10) throw new Error('quote is not a TD10 report');
    return {
      tcbStatus: verified.status,
      advisoryIds: verified.advisory_ids,
      debugEnabled: ((td10.tdAttributes[0] ?? 0) & 1) !== 0,
      reportData: td10.reportData,
      mrConfigId: td10.mrConfigId,
      rtMr3: td10.rtMr3,
    };
  };
}

export interface RecordedGpuVerdict {
  kid: string;
  iat: number;
  exp: number;
  hwmodel: string;
  gpus: number;
}

export function createRecordedGpuVerifier(
  nrasResponse: string,
  jwks: unknown,
  atDate: Date,
  onVerdict: (v: RecordedGpuVerdict) => void,
): GpuEvidenceVerifier {
  return async (nvidiaPayload) => {
    const parsed = JSON.parse(nrasResponse) as [[string, string], Record<string, string>];
    const token = parsed[0][1];
    const keys = createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]);
    const { payload, protectedHeader } = await jwtVerify(token, keys, {
      algorithms: ['ES384'],
      issuer: 'https://nras.attestation.nvidia.com',
      currentDate: atDate,
    });
    const nonce = (JSON.parse(nvidiaPayload) as { nonce: string }).nonce.replace(/^0x/i, '');
    if (payload['eat_nonce'] !== nonce) throw new Error('NRAS eat_nonce does not match the GPU payload nonce');
    if (payload['x-nvidia-overall-att-result'] !== true) throw new Error('NRAS overall attestation result is not true');
    const perGpu = parsed[1];
    const firstGpu = Object.values(perGpu)[0];
    const hwmodel = firstGpu ? ((await jwtVerify(firstGpu, keys, { algorithms: ['ES384'], currentDate: atDate })).payload['hwmodel'] as string) : 'unknown';
    onVerdict({ kid: protectedHeader.kid ?? '?', iat: payload.iat ?? 0, exp: payload.exp ?? 0, hwmodel, gpus: Object.keys(perGpu).length });
  };
}
