// Who sees what (SPEC §8). The rows live in rows.json; a test in packages/proof keeps them equal to the README table. Static.
import rows from './rows.json';

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
