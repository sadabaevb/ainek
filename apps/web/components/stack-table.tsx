// A table that stacks into labelled blocks below 640 px (globals.css `table.stack`). The header cells and each cell's
// data-label come from the same column list, so they cannot drift apart. The cell content is one <span>, so the stacked
// grid (label | content) holds whatever a cell renders.
import type { ReactNode } from 'react';

export interface Column<Row> {
  label: string;
  cell: (row: Row) => ReactNode;
  className?: string;
}

export function StackTable<Row>({ columns, rows, rowKey }: { columns: Column<Row>[]; rows: Row[]; rowKey: (row: Row) => string }) {
  return (
    <div className="table-wrap">
      <table className="stack">
        <thead>
          <tr>{columns.map((c) => <th key={c.label}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => <td key={c.label} className={c.className} data-label={c.label}><span>{c.cell(row)}</span></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A two-column table of names and values (`table.kv`). */
export function KvTable({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <table className="kv">
      <tbody>
        {rows.map(([name, value]) => (
          <tr key={name}><th>{name}</th><td>{value}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
