'use client';
// The paste box and the "Load file" button shared by /verify and /auditor. The file is read in the browser, never uploaded.
// A file can also be dropped straight onto the box.
import { useState, type DragEvent } from 'react';
import { useT } from '@/app/providers';
import { describeError } from '@/lib/errors';

export function JsonTextarea({ value, onChange, placeholder }: { value: string; onChange: (text: string) => void; placeholder: string }) {
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void file.text().then(onChange);
  };
  return (
    <textarea
      className={`json${over ? ' drop' : ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      rows={6}
      placeholder={placeholder}
    />
  );
}

export function LoadFileButton({ onText, onError }: { onText: (text: string) => void; onError: (message: string) => void }) {
  const { t } = useT();
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
          if (file) file.text().then(onText).catch((err: unknown) => onError(t.readFailed(file.name, describeError(err))));
        }}
      />
    </label>
  );
}
