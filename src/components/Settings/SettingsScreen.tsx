'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowUpRight, BookOpen, ChevronLeft } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { trpc } from '@/src/utils/trpc'
import type { AppRouter } from '@/src/server/routers/app'
import { useDocumentTitle } from '@/src/hooks/useDocumentTitle'
import { useSideNames } from '@/src/hooks/useSideNames'
import { cn } from '@/lib/utils'
import { Card, IndexRow, InlineError, PageHeader, SectionLabel, SegmentedControl, SettingRow, Skeleton } from '@/src/components/ds'
import { InternetToggleCard } from '@/src/components/status/InternetToggleCard'
import { DOCS_URL } from '@/src/components/AppShell/navItems'
import { UpdateCard } from '@/src/components/status/UpdateCard'
import { SystemInfoCard } from '@/src/components/status/SystemInfoCard'
import { DeviceSettingsForm } from './DeviceSettingsForm'
import { SideSettingsForm } from './SideSettingsForm'
import { TapGestureConfig } from './TapGestureConfig'
import { MqttSettingsForm } from './MqttSettingsForm'
import { HomeKitConfig } from './HomeKitConfig'
import { ArchivePushSettingsForm } from './ArchivePushSettingsForm'
import { AppearanceSettings, TempControlPicker, TempDisplayControl, ThemeControl, UnitsControl } from './AppearanceSettings'
import { SectionColumns } from './SettingsLayout'
import { resolveSection, SECTIONS, type SectionId } from './sections'

type Side = 'left' | 'right'

/**
 * Settings: things you change. Desktop: sections nested in the sidebar, the
 * first one when none is chosen. Phone: an index list, then a pushed section
 * page with a back link. Pod status lives on System → Dashboard.
 */
export function SettingsScreen() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const chosen = resolveSection(searchParams.get('section'), searchParams.get('tab'))
  const active: SectionId = chosen ?? SECTIONS[0].id
  const meta = SECTIONS.find(s => s.id === active) ?? SECTIONS[0]
  useDocumentTitle(chosen && meta.label, 'Settings')

  // Status moved to System → Dashboard; old links follow it there.
  const pathname = usePathname()
  const legacyStatus = searchParams.get('section') === 'status' || searchParams.get('tab') === 'status'
  useEffect(() => {
    if (legacyStatus) router.replace(`/${pathname.split('/')[1] || 'en'}/system`)
  }, [legacyStatus, pathname, router])

  const [selectedSide, setSelectedSide] = useState<Side>('left')
  const { leftName, rightName } = useSideNames()

  const navigate = useCallback(
    (next: SectionId | null, push = false) => {
      const params = new URLSearchParams(searchParams.toString())
      params.delete('tab')
      if (next) params.set('section', next)
      else params.delete('section')
      const qs = params.toString()
      const url = qs ? `?${qs}` : '?'
      if (push) router.push(url, { scroll: false })
      else router.replace(url, { scroll: false })
    },
    [router, searchParams],
  )

  const sideOptions = [
    { value: 'left' as const, label: leftName },
    { value: 'right' as const, label: rightName },
  ]
  const hasSidePicker = active === 'sides' || active === 'gestures'

  return (
    <>
      {!chosen && (
        <SettingsIndex
          className="min-[900px]:hidden"
          onOpen={id => navigate(id, true)}
        />
      )}

      {/* Desktop section navigation is nested under Settings in the app sidebar. */}
      <div className={cn(!chosen && 'max-[899px]:hidden')}>
        <div className="flex min-w-0 flex-col gap-3.5">
          {/* Phone: back link + centered title, side picker full width below */}
          <div className="relative flex min-h-[30px] items-center min-[900px]:hidden">
            <button
              type="button"
              onClick={() => navigate(null)}
              className="relative z-[1] -ml-1.5 flex cursor-pointer items-center gap-0.5 border-0 bg-transparent p-0 text-[15px] text-fg-2 hover:text-fg"
            >
              <ChevronLeft size={20} />
              Settings
            </button>
            <h1 className="absolute inset-x-0 text-center text-[17px] font-medium">{meta.label}</h1>
          </div>
          {hasSidePicker && (
            <SegmentedControl
              full
              className="min-[900px]:hidden"
              ariaLabel="Person"
              value={selectedSide}
              options={sideOptions}
              onChange={setSelectedSide}
            />
          )}

          {/* Desktop: breadcrumb, then section title + description */}
          <div className="hidden flex-col gap-1 min-[900px]:flex">
            <span className="font-mono text-[13px] text-fg-2">Settings /</span>
            <div className="flex min-h-9 items-center gap-3">
              <h1 className="whitespace-nowrap text-[22px] font-medium">{meta.label}</h1>
              <span className="truncate text-[13px] text-fg-2">{meta.description}</span>
              {hasSidePicker && (
                <SegmentedControl
                  className="ml-auto"
                  ariaLabel="Person"
                  value={selectedSide}
                  options={sideOptions}
                  onChange={setSelectedSide}
                />
              )}
            </div>
          </div>

          <SectionBody section={active} side={selectedSide} />
        </div>
      </div>
    </>
  )
}

function SectionBody({ section, side }: { section: SectionId, side: Side }) {
  switch (section) {
    case 'device':
      return <WithSettings>{data => <DeviceSettingsForm device={data.device} />}</WithSettings>
    case 'sides':
      return <WithSettings>{data => <SidesSection data={data} side={side} />}</WithSettings>
    case 'gestures':
      return <TapGestureConfig filterSide={side} />
    case 'appearance':
      return (
        <WithSettings>
          {data => <AppearanceSettings temperatureUnit={data.device.temperatureUnit} />}
        </WithSettings>
      )
    case 'mqtt':
      return <MqttSettingsForm />
    case 'network':
      return <SectionColumns left={<InternetToggleCard />} />
    case 'homekit':
      return <HomeKitConfig />
    case 'backup':
      return <ArchivePushSettingsForm />
    case 'updates':
      return <SectionColumns left={<UpdateCard />} right={<SystemInfoCard />} />
  }
}

type SettingsData = inferRouterOutputs<AppRouter>['settings']['getAll']

/** Loads settings.getAll with the skeleton / inline error in the card slots. */
function WithSettings({ children }: { children: (data: SettingsData) => ReactNode }) {
  const { data, isLoading, error } = trpc.settings.getAll.useQuery({})

  if (isLoading) {
    return (
      <SectionColumns
        left={(
          <>
            <Skeleton className="h-[132px]" />
            <Skeleton className="h-[96px]" />
          </>
        )}
        right={<Skeleton className="h-[160px]" />}
      />
    )
  }

  if (error) {
    return (
      <Card>
        <InlineError>
          {'Failed to load settings: '}
          {error.message}
        </InlineError>
      </Card>
    )
  }

  if (!data) return null
  return <>{children(data)}</>
}

function SidesSection({ data, side }: { data: SettingsData, side: Side }) {
  // Drives the auto-off toggle gate: the feature is only safe where presence
  // can be sensed. Polls so a side that comes online (calibration completes,
  // sensor stream resumes) re-enables the toggle without a manual refresh.
  const { data: occupancy } = trpc.biometrics.getOccupancy.useQuery(undefined, {
    refetchInterval: 10000,
    refetchOnWindowFocus: false,
  })
  const presenceAvailable = occupancy?.[side].available ?? null

  return (
    <SideSettingsForm
      side={side}
      sideData={side === 'left' ? data.sides.left : data.sides.right}
      presenceAvailable={presenceAvailable}
    />
  )
}

/** Phone Settings index: inline appearance, then section rows. */
function SettingsIndex({ onOpen, className }: { onOpen: (id: SectionId) => void, className?: string }) {
  const { leftName, rightName } = useSideNames()
  const settings = trpc.settings.getAll.useQuery({})
  const row = (id: SectionId, value?: ReactNode) => {
    const meta = SECTIONS.find(x => x.id === id) ?? SECTIONS[0]
    return <IndexRow key={id} icon={meta.icon} label={meta.label} value={value} onClick={() => onOpen(id)} />
  }

  return (
    <div className={cn('flex flex-col gap-3.5', className)}>
      <PageHeader title="Settings" />

      <SectionLabel className="mt-1">APPEARANCE</SectionLabel>
      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3.5">
        <span className="text-sm">Temperature control</span>
        <TempControlPicker />
        <SettingRow label="Show as">
          <TempDisplayControl />
        </SettingRow>
        <SettingRow label="Theme">
          <ThemeControl />
        </SettingRow>
        {settings.data && (
          <SettingRow label="Units">
            <UnitsControl unit={settings.data.device.temperatureUnit} />
          </SettingRow>
        )}
      </div>

      <SectionLabel className="mt-1">POD</SectionLabel>
      <div className="rounded-card border border-line bg-surface px-4">
        {row('device')}
        {row('gestures')}
        {row('homekit')}
        {row('mqtt')}
        {row('network')}
        {row('sides', <span className="font-sans">{`${leftName}, ${rightName}`}</span>)}
      </div>

      <SectionLabel className="mt-1">SYSTEM</SectionLabel>
      <div className="rounded-card border border-line bg-surface px-4">
        {row('appearance')}
        {row('backup')}
        {row('updates')}
      </div>

      <SectionLabel className="mt-1">HELP</SectionLabel>
      <div className="rounded-card border border-line bg-surface px-4">
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex w-full items-center gap-3 px-0.5 py-3.5 text-[15px] text-fg no-underline hover:bg-active hover:no-underline"
        >
          <BookOpen size={17} className="text-icon" />
          <span className="flex-1">Docs</span>
          <span className="font-mono text-[13px] text-fg-2">sleepypod.github.io</span>
          <ArrowUpRight size={16} className="text-fg-3" />
        </a>
      </div>
    </div>
  )
}
