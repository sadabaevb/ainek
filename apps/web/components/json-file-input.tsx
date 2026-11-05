'use client';
// The paste box and the "Load file" button shared by /verify and /auditor. The file is read in the browser, never uploaded.
// A file can also be dropped straight onto the box. Both paths go through one reader with one error wording.
import { useEffect, useState, type DragEvent } from 'react';
import { useT } from '@/app/providers';
import { describeError } from '@/lib/errors';

const MAX_MB = 2; // a proof or a disclosure file is kilobytes; a stray large drop must not freeze the tab
const isJson = (file: File) => file.type === 'application/json' || /\.json$/i.test(file.name); // `type` is empty on some systems
const hasFiles = (e: { dataTransfer: DataTransfer | null }) => e.dataTransfer?.types.includes('Files') ?? false;

function useReadFile(onText: (text: string) => void, onError: (message: string) => void): (file: File) => void {
  const { t } = useT();
  return (file) => {
    if (!isJson(file)) return onError(t.notJsonFile(file.name));
    if (file.size > MAX_MB * 1_000_000) return onError(t.fileTooBig(file.name, MAX_MB));
    file.text().then(onText, (err: unknown) => onError(t.readFailed(file.name, describeError(err))));
  };
}

export function JsonTextarea({ value, onChange, onError, placeholder }: { value: string; onChange: (text: string) => void; onError: (message: string) => void; placeholder: string }) {
  const [over, setOver] = useState(false);
  const read = useReadFile(onChange, onError);
  // A file released next to the box would otherwise navigate the tab to it and lose the page state.
  useEffect(() => {
    const swallow = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    document.addEventListener('dragover', swallow);
    document.addEventListener('drop', swallow);
    return () => {
      document.removeEventListener('dragover', swallow);
      document.removeEventListener('drop', swallow);
    };
  }, []);
  const drop = (e: DragEvent<HTMLTextAreaElement>) => {
    if (!hasFiles(e)) return; // dragged text keeps the browser's own behaviour
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) read(file);
  };
  return (
    <textarea
      className={`json${over ? ' drop' : ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onDragEnter={(e) => hasFiles(e) && setOver(true)}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      rows={6}
      placeholder={placeholder}
    />
  );
}

export function LoadFileButton({ onText, onError }: { onText: (text: string) => void; onError: (message: string) => void }) {
  const { t } = useT();
  const read = useReadFile(onText, onError);
  return (
    <label className="btn">
      {t.loadFile}{' '}
      <input
        type="file"
        accept="application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // so picking the same file again fires onChange
          if (file) read(file);
        }}
      />
    </label>
  );
}
