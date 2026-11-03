// Who sees what (SPEC §8), verbatim in README as well. Static.
const rows: Array<[party: string, sees: string, doesNotSee: string, guarantee: string]> = [
  ['Relay (our server)', 'ciphertext, size, timing, IP, API key', 'prompt, response and tool-call contents', 'E2EE to the model key from the verified attestation report'],
  ['Relay on the Incognito demo route (user-chosen)', 'the plaintext prompt and reply', '—', 'none: no model key exists to encrypt to; the red card says so. This route exists to show what a non-attested model looks like'],
  ['NEAR AI gateway', 'ciphertext, token accounting', 'contents', 'E2EE; the gateway is attested'],
  ['Model enclave', 'plaintext for the duration of inference', '—', 'TDX + GPU attestation; retention inside the enclave is not provable by attestation'],
  ['OutLayer job', 'the action and the policy', 'the conversation', 'TDX; decision key generated in the TEE; what the OutLayer API gateway sees is being clarified'],
  ['NEAR blockchain', 'provider keys and measurements, policy hash, decisions, salted commits, executed transfers (testnet)', 'the policy, the conversation, the proofs', 'salted commits; transfer details are hidden only with Confidential Intents (stretch)'],
  ['Policy job (TEE)', 'the action and the policy while computing', 'the conversation', 'WASI-P1 without network or disk, reproducible build: retention impossible by construction (does not apply to the model)'],
  ['Auditor', 'one disclosed proof + its salt', 'the others', 'selective disclosure'],
  ['Not solved', '—', '—', 'size/timing side channels; identity of the weights (the deployment is attested); operator code inside the enclave (partly: provenance via Sigstore)'],
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
