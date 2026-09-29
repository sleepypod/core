'use client'

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useDocumentTitle } from '@/src/hooks/useDocumentTitle'
import { useSensorStream } from '@/src/hooks/useSensorStream'
import { PageHeader, Pill } from '@/src/components/ds'
import { PullToRefresh } from '@/src/components/PullToRefresh/PullToRefresh'
import { ConnectionStatusBar } from '@/src/components/Sensors/ConnectionStatusBar'
import { SensorsScreen } from '@/src/components/Sensors/SensorsScreen'
import type { DiagSection } from '@/src/components/diagnostics/DiagnosticsConsole'
import { resolveSystemTab, SYSTEM_TABS, type SystemTab } from './systemTabs'

function TabLoading() {
  return <div role="status" className="h-64 animate-pulse rounded-card border border-line bg-surface" />
}

const DiagnosticsConsole = dynamic(
  () => import('@/src/components/diagnostics/DiagnosticsConsole').then(m => m.DiagnosticsConsole),
  { ssr: false, loading: TabLoading },
)
const StorageTab = dynamic(
  () => import('./StorageTab').then(m => m.StorageTab),
  { ssr: false, loading: TabLoading },
)
const DatabasesTab = dynamic(
  () => import('./DatabasesTab').then(m => m.DatabasesTab),
  { ssr: false, loading: TabLoading },
)
const HapticsTestCard = dynamic(
  () => import('@/src/components/diagnostics/HapticsTestCard').then(m => m.HapticsTestCard),
  { ssr: false, loading: TabLoading },
)
const SystemLogViewer = dynamic(
  () => import('@/src/components/status/SystemLogViewer').then(m => m.SystemLogViewer),
  { loading: TabLoading },
)

export { resolveSystemTab, type SystemTab } from './systemTabs'

const DIAGNOSTIC_TABS = new Set<SystemTab>(['dashboard', 'calibration', 'health', 'scheduler', 'thermal'])

/** System: Dashboard plus the pod's sensor, log and diagnostic pages. */
export function SystemScreen() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const tab = resolveSystemTab(searchParams.get('tab'), searchParams.get('section'))
  useDocumentTitle(SYSTEM_TABS.find(t => t.id === tab)?.label, 'System')

  // Biometrics moved to Sleep; old System/Diagnostics links follow it there.
  const legacyBiometrics = searchParams.get('tab') === 'biometrics' || searchParams.get('section') === 'biometrics'
  useEffect(() => {
    if (legacyBiometrics) router.replace(`/${pathname.split('/')[1] || 'en'}/sleep?view=biometrics`)
  }, [legacyBiometrics, pathname, router])

  // Pipeline moved into Health as the Live stream stage.
  const legacyPipeline = searchParams.get('tab') === 'pipeline'
  useEffect(() => {
    if (legacyPipeline) router.replace(`${pathname}?tab=health&node=live-stream`, { scroll: false })
  }, [legacyPipeline, pathname, router])

  const [streamEnabled, setStreamEnabled] = useState(true)
  const stream = useSensorStream({ enabled: streamEnabled })
  const sensorCount = Object.keys(stream.latestFrames).length

  const selectTab = useCallback((next: SystemTab) => {
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'dashboard') params.delete('tab')
    else params.set('tab', next)
    params.delete('section')
    params.delete('unit')
    params.delete('view')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  /** Pull-to-refresh: toggle stream off/on to force a reconnect. */
  const handleRefresh = useCallback(async () => {
    setStreamEnabled(false)
    await new Promise(resolve => setTimeout(resolve, 300))
    setStreamEnabled(true)
  }, [])

  return (
    <PullToRefresh onRefresh={handleRefresh} enabled={streamEnabled}>
      <div className="flex flex-col gap-3.5 min-[900px]:gap-[18px]">
        <span className="-mb-2 hidden font-mono text-[13px] text-fg-2 min-[900px]:block">System /</span>
        <PageHeader
          title={(
            <>
              <span className="min-[900px]:hidden">System</span>
              <span className="hidden min-[900px]:inline">{SYSTEM_TABS.find(t => t.id === tab)?.label ?? 'Dashboard'}</span>
            </>
          )}
          className="gap-y-3.5"
          middle={(
            <div
              role="tablist"
              aria-label="System sections"
              className="no-scrollbar order-last -mx-5 flex basis-full gap-1.5 overflow-x-auto px-5 min-[900px]:hidden"
            >
              {SYSTEM_TABS.map(t => (
                <Pill key={t.id} role="tab" aria-selected={t.id === tab} selected={t.id === tab} onClick={() => selectTab(t.id)}>
                  {t.label}
                </Pill>
              ))}
            </div>
          )}
          right={(
            <ConnectionStatusBar
              status={stream.status}
              fps={stream.fps}
              lastError={stream.lastError}
              sensorCount={sensorCount}
              lastFrameTime={stream.lastSensorTime}
              paused={!streamEnabled}
              onToggle={() => setStreamEnabled(v => !v)}
            />
          )}
        />

        {tab === 'sensors' && <SensorsScreen streamEnabled={streamEnabled} />}
        {DIAGNOSTIC_TABS.has(tab) && <DiagnosticsConsole section={tab as DiagSection} onJump={selectTab} />}
        {tab === 'logs' && <SystemLogViewer />}
        {tab === 'storage' && <StorageTab />}
        {tab === 'databases' && <DatabasesTab />}
        {tab === 'hardware' && <HapticsTestCard />}
      </div>
    </PullToRefresh>
  )
}
