// Who sees what (SPEC §8). The rows live in rows.json; a test in packages/proof keeps them equal to the README table.
// Static and English only: it is the spec's table, quoted verbatim in the README.
import rows from './rows.json';

const HEAD = ['Party', 'Sees', 'Does not see', 'Guarantee'];

export default function TrustPage() {
  return (
    <main className="page">
      <h1>Who sees what</h1>
      <p className="muted">The trust boundary of Ainek, as stated in the spec. We say "our server cannot read", not "nobody can".</p>
      <table className="stack">
        <thead>
          <tr>{HEAD.map((h) => <th key={h}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map(([party, sees, not, guarantee]) => (
            <tr key={party}>
              <td data-label={HEAD[0]}><strong>{party}</strong></td>
              <td data-label={HEAD[1]}>{sees}</td>
              <td data-label={HEAD[2]}>{not}</td>
              <td data-label={HEAD[3]}>{guarantee}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
