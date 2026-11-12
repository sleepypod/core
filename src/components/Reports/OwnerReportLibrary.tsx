'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import '@/public/guide/morning-reports.css'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { ownerReportWorkspace } from '@/src/reports/ownerBrowser'
import { ReportLibrary } from './ReportLibrary'

export function OwnerReportLibrary({ compact = false }: { compact?: boolean }) {
  const [workspace] = useState(() => ownerReportWorkspace())
  const language = langFromPath(usePathname())
  return (
    <>
      <ReportLibrary workspace={workspace} autoOpen compact={compact} />
      {compact && <Link className="inline-flex min-h-11 items-center text-sm underline underline-offset-4" href={`/${language}/sleep?view=reports`}>Read reports and saved answers</Link>}
    </>
  )
}
