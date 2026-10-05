'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BedDouble } from 'lucide-react'
import { langFromPath } from '@/src/components/AppShell/navItems'

export function BaseLink() {
  const lang = langFromPath(usePathname())
  return (
    <Link href={`/${lang}/base`} className="inline-flex items-center gap-1.5 rounded-ctl border border-line-2 px-3 py-2 text-[13px] text-fg">
      <BedDouble size={14} />
      Base
    </Link>
  )
}
