'use client';
import Link from 'next/link';
import { useT } from '@/app/providers';

export function NavLinks() {
  const { t } = useT();
  return (
    <>
      <Link href="/log">{t.nav.log}</Link>
      <Link href="/verify">{t.nav.verify}</Link>
      <Link href="/auditor">{t.nav.auditor}</Link>
      <Link href="/trust">{t.nav.trust}</Link>
    </>
  );
}
