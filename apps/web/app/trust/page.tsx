// Who sees what (SPEC §8), verbatim in README as well. Static.
const rows: Array<[party: string, sees: string, doesNotSee: string, guarantee: string]> = [
  ['Relay (our server)', 'ciphertext, size, timing, IP, API key; model id, message count and roles, token usage, completion ids', 'prompt, response and tool-call contents', 'E2EE to the model key from the verified attestation report'],
  ['Relay on the Incognito demo route (user-chosen)', 'the plaintext prompt and reply', '—', 'none (no model key to encrypt to); the red card says so'],
  ['NEAR AI gateway and proxy', "ciphertext, token accounting; the browser's IP during collateral and NVIDIA calls", 'contents', "E2EE; the gateway is attested; the proxy cannot forge the NVIDIA verdict (checked against NVIDIA's keys)"],
  ['Model enclave', 'plaintext for the duration of inference', '—', 'TDX + GPU attestation; retention inside the enclave is not provable by attestation'],
  ['NEAR blockchain', 'provider keys and measurements, salted commits with the committing account and time, executed transfers (testnet); (Tier 2) proposed actions, the OutLayer job input, decisions, the policy hash', 'the policy contents, the conversation, the proofs', 'salted commits; transfer details are hidden only with Confidential Intents (out of scope)'],
  ['OutLayer policy job (Tier 2, planned)', 'the action and the policy, while computing', 'the conversation', 'TDX, decision key generated in the TEE; a WASI-P1 module with no network or disk and a reproducible build cannot retain its input (the model enclave can; this says nothing about the OutLayer worker, and the action input is public on-chain); what the OutLayer API gateway sees is still open'],
  ['Auditor', 'one disclosed proof, its salt and the ciphertext bytes', 'the plaintext, the other exchanges', 'selective disclosure (/auditor)'],
];

export default function TrustPage() {
  return (
    <main className="page">
      <h1>Who sees what</h1>
      <p className="muted">The trust boundary of Ainek, as stated in the spec. We say "our server cannot read", not "nobody can".</p>
      <table>
        <thead>
          <tr><th>Party</th><th>Sees</th><th>Does not see</th><th>Guarantee</th></tr>
        </thead>
        <tbody>
          {rows.map(([party, sees, not, guarantee]) => (
            <tr key={party}><td><strong>{party}</strong></td><td>{sees}</td><td>{not}</td><td>{guarantee}</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
