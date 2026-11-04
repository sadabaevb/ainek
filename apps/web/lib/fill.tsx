import { Fragment, type ReactNode } from 'react';

/** A dictionary sentence with `{name}` slots filled by React nodes (a code span, a link), so word order and punctuation stay in the translation. */
export function fill(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((piece, i) => (i % 2 === 0 ? piece : <Fragment key={i}>{parts[piece]}</Fragment>));
}
