'use client';
// The paste box and the "Load file" button shared by /verify and /auditor. The file is read in the browser, never uploaded.
// A file can also be dropped straight onto the box. Both paths go through one reader with one error wording.
import { useState, type DragEvent } from 'react';
import { useT } from '@/app/providers';
import { describeError } from '@/lib/errors';

const MAX_BYTES = 2_000_000; // a proof or a disclosure file is kilobytes; a stray large drop must not freeze the tab

function useReadFile(onText: (text: string) => void, onError: (message: string) => void): (file: File) => void {
  const { t } = useT();
  return (file) => {
    if (file.size > MAX_BYTES) return onError(t.fileTooBig(file.name));
    file.text().then(onText, (err: unknown) => onError(t.readFailed(file.name, describeError(err))));
  };
}

export function JsonTextarea({ value, onChange, onError, placeholder }: { value: string; onChange: (text: string) => void; onError: (message: string) => void; placeholder: string }) {
  const [over, setOver] = useState(false);
  const read = useReadFile(onChange, onError);
  const drop = (e: DragEvent<HTMLTextAreaElement>) => {
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
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={() => setOver(true)}
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
