'use client';
import { useT } from '@/app/providers';

export function LangToggle() {
  const { t, toggle } = useT();
  return (
    <button type="button" className="btn small" onClick={toggle} aria-label={t.langLabel}>{t.lang}</button>
  );
}
