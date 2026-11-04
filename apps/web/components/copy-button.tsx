'use client';
// Copies a hash or an id to the clipboard and says so for a moment. Clipboard access can be denied (insecure context,
// permissions): then the button quietly does nothing, the value is still selectable text next to it.
import { useState } from 'react';
import { useT } from '@/app/providers';

export function CopyButton({ text }: { text: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  return (
    <button type="button" className="btn small" onClick={copy} aria-label={`${t.copy} ${text}`}>
      {copied ? t.copied : t.copy}
    </button>
  );
}
