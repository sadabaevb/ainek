// Who sees what (SPEC §8). The rows live in rows.json; a test in packages/proof keeps them equal to the README table.
// Static and English only: it is the spec's table, quoted verbatim in the README.
import { StackTable, type Column } from '@/components/stack-table';
import rows from './rows.json';

type TrustRow = string[];

const COLUMNS: Column<TrustRow>[] = [
  { label: 'Party', cell: (r) => <strong>{r[0]}</strong> },
  { label: 'Sees', cell: (r) => r[1] },
  { label: 'Does not see', cell: (r) => r[2] },
  { label: 'Guarantee', cell: (r) => r[3] },
];

export default function TrustPage() {
  return (
    <main className="page">
      <h1>Who sees what</h1>
      <p className="muted">The trust boundary of Ainek, as stated in the spec. We say "our server cannot read", not "nobody can".</p>
      <StackTable columns={COLUMNS} rows={rows} rowKey={(r) => r[0] ?? ''} />
    </main>
  );
}
