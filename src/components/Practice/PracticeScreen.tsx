'use client'

import '@/public/guide/control-practice.css'
import { usePathname, useRouter } from 'next/navigation'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { useDocumentTitle } from '@/src/hooks/useDocumentTitle'
import { ControlPractice } from './ControlPractice'

export function PracticeScreen() {
  const router = useRouter()
  const lang = langFromPath(usePathname())
  useDocumentTitle('Practice')
  return <div className="owner-practice"><ControlPractice onClose={() => router.push(`/${lang}/settings?section=connection`)} /></div>
}
