'use client';
// Copies a hash or an id to the clipboard and says so for a moment. Clipboard access can be denied (insecure context,
// permissions): then the button quietly does nothing, the value is still selectable text next to it.
import { useEffect, useState } from 'react';
import { useT } from '@/app/providers';

export function CopyButton({ text }: { text: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button type="button" className="btn tiny" onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined)} aria-label={`${t.copy} ${text}`}>
      {copied ? t.copied : t.copy}
    </button>
  );
}
