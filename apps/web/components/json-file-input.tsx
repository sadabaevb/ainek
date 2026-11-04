'use client';
// The paste box and the "Load file" button shared by /verify and /auditor. The file is read in the browser, never uploaded.
export function JsonTextarea({ value, onChange, placeholder }: { value: string; onChange: (text: string) => void; placeholder: string }) {
  return <textarea className="json" value={value} onChange={(e) => onChange(e.target.value)} rows={6} placeholder={placeholder} />;
}

export function LoadFileButton({ onText }: { onText: (text: string) => void }) {
  return (
    <label className="btn">
      Load file <input type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => void e.target.files?.[0]?.text().then(onText)} />
    </label>
  );
}
