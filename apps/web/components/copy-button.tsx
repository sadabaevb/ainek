'use client';
// Copies a hash, an id or a link to the clipboard and says so for a moment. Clipboard access can be denied (insecure context,
// permissions): then the button quietly does nothing; a hash or an id is still selectable text next to it.
import { useState } from 'react';
import { useT } from '@/app/providers';

/**
 * `text` may be made on the click (a proof link is deflated then); `label` and `doneLabel` replace "Copy" and "Copied", and
 * `failLabel` is shown when making the text fails (a proof too long for a link).
 */
export function CopyButton({ text, label, doneLabel, failLabel, className = 'btn small' }: { text: string | (() => Promise<string>); label?: string; doneLabel?: string; failLabel?: string; className?: string }) {
  const { t } = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const flash = (next: 'copied' | 'failed') => {
    setState(next);
    setTimeout(() => setState('idle'), next === 'copied' ? 1500 : 4000);
  };
  const copy = () => {
    if (typeof text === 'string') return void navigator.clipboard?.writeText(text).then(() => flash('copied'), () => undefined);
    const made = text();
    made.catch(() => flash('failed'));
    // Safari allows a clipboard write only inside the click itself: the write starts now and takes the text when it is ready.
    // Where ClipboardItem does not take a promise, the plain write after the wait is the fallback.
    const written =
      typeof ClipboardItem === 'function' && navigator.clipboard?.write
        ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': made.then((value) => new Blob([value], { type: 'text/plain' })) })]).catch(() => made.then((value) => navigator.clipboard.writeText(value)))
        : made.then((value) => navigator.clipboard.writeText(value));
    void written.then(() => flash('copied'), () => undefined);
  };
  return (
    <button type="button" className={className} onClick={copy}>
      {state === 'copied' ? (doneLabel ?? t.copied) : state === 'failed' && failLabel ? failLabel : (label ?? t.copy)}
    </button>
  );
}
