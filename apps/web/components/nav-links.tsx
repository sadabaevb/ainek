'use client';
// Nav links in the current language with the current page marked (aria-current, which the stylesheet highlights).
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/app/providers';

export function NavLinks() {
  const { t } = useT();
  const path = usePathname();
  return (
    <>
      {(Object.keys(t.nav) as (keyof typeof t.nav)[]).map((key) => {
        const href = `/${key}`;
        return <Link key={key} href={href} className="link" aria-current={path === href ? 'page' : undefined}>{t.nav[key]}</Link>;
      })}
    </>
  );
}
