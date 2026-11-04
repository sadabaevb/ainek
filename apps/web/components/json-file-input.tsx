'use client';
// The paste box and the "Load file" button shared by /verify and /auditor. The file is read in the browser, never uploaded.
import { useT } from '@/app/providers';
import { describeError } from '@/lib/errors';

export function JsonTextarea({ value, onChange, placeholder }: { value: string; onChange: (text: string) => void; placeholder: string }) {
  return <textarea className="json" value={value} onChange={(e) => onChange(e.target.value)} rows={6} placeholder={placeholder} />;
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
