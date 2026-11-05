import { Fragment, type ReactNode } from 'react';

/**
 * A dictionary sentence with `{name}` slots filled by React nodes (a code span, a link), so word order and punctuation stay
 * in the translation. A slot the caller did not supply stays visible as `{name}`: a typo in one language shows instead of vanishing.
 */
export function fill(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((piece, i) => (i % 2 === 0 ? piece : piece in parts ? <Fragment key={i}>{parts[piece]}</Fragment> : `{${piece}}`));
}
