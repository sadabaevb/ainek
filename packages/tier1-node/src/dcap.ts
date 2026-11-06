// A TDX quote verified against Intel's collateral, as @ainek/proof wants it. Its own subpath, so what does not verify quotes does not load a DCAP library.
import qvl from '@phala/dcap-qvl';
import { bytesToHex, type QuoteVerifier } from '@ainek/proof';

export const verifyTdxQuote: QuoteVerifier = (quote, collateral, atSeconds) => {
  const verified = qvl.verify(Buffer.from(quote), collateral as qvl.Collateral, atSeconds);
  const td = verified.report.asTd10();
  if (!td) throw new Error('the quote is not a TD10 report');
  return {
    tcbStatus: verified.status,
    reportData: bytesToHex(td.reportData),
    measurements: { mrtd: bytesToHex(td.mrTd), rtmr0: bytesToHex(td.rtMr0), rtmr1: bytesToHex(td.rtMr1), rtmr2: bytesToHex(td.rtMr2), rtmr3: bytesToHex(td.rtMr3) },
  };
};
