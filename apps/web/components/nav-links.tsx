'use client';
// Nav links with the current page highlighted. Labels come translated from the server layout; only the active state needs the client.
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavLinks({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <>
      {items.map((it) => (
        <Link key={it.href} href={it.href} className={`link${path === it.href ? ' active' : ''}`}>{it.label}</Link>
      ))}
    </>
  );
}
