'use client'

import { useCallback } from 'react'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { SegmentedControl, Skeleton } from '@/src/components/ds'
import { SleepScreen } from './SleepScreen'
import { useDocumentTitle } from '@/src/hooks/useDocumentTitle'
import { resolveSleepSection, SLEEP_SECTIONS, type SleepSection } from './sleepViews'

const BiometricsPage = dynamic(
  () => import('@/src/components/biometrics/BiometricsPage').then(m => m.BiometricsPage),
  { loading: () => <Skeleton className="h-64" /> },
)
const ImportedHistory = dynamic(
  () => import('./ImportedHistory').then(module => module.ImportedHistory),
  { loading: () => <Skeleton className="h-64" /> },
)
const MorningJournal = dynamic(
  () => import('./MorningJournal').then(module => module.MorningJournal),
  { loading: () => <Skeleton className="h-64" /> },
)

/**
 * Sleep: Nights, Biometrics and separately labelled imported History. The section
 * lives in `?view=`; desktop switches it from the sidebar, phones from a
 * segmented switch.
 */
export function SleepSections() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const section = resolveSleepSection(searchParams.get('view'))
  useDocumentTitle(SLEEP_SECTIONS.find(s => s.id === section)?.label, 'Sleep')

  const select = useCallback((next: SleepSection) => {
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'nights') params.delete('view')
    else params.set('view', next)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  const sectionSwitch = (
    <SegmentedControl
      full
      ariaLabel="Sleep section"
      className="min-[900px]:hidden"
      options={SLEEP_SECTIONS.map(s => ({ value: s.id, label: s.label }))}
      value={section}
      onChange={select}
    />
  )

  if (section === 'nights') return <SleepScreen sectionSwitch={sectionSwitch} />
  if (section === 'history') return <ImportedHistory sectionSwitch={sectionSwitch} />
  if (section === 'journal') return <MorningJournal sectionSwitch={sectionSwitch} />

  return <BiometricsPage sectionSwitch={sectionSwitch} />
}
