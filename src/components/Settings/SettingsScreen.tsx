'use client'

import { useCallback, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Settings, User, RotateCcw, Wifi, Hand, Radio, Cog } from 'lucide-react'
import clsx from 'clsx'
import { trpc } from '@/src/utils/trpc'
import { useSideNames } from '@/src/hooks/useSideNames'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/src/ui/tabs'
import { DeviceSettingsForm } from './DeviceSettingsForm'
import { SideSettingsForm } from './SideSettingsForm'
import { TapGestureConfig } from './TapGestureConfig'
import { HapticsTestCard } from './HapticsTestCard'
import { MqttSettingsForm } from './MqttSettingsForm'

const TAB_IDS = ['device', 'sides', 'gestures', 'mqtt'] as const
type TabId = typeof TAB_IDS[number]

function isTabId(v: string | null): v is TabId {
  return v !== null && (TAB_IDS as readonly string[]).includes(v)
}

/**
 * Settings screen with URL-synced tabs: Device | Sides | Gestures | MQTT.
 * Deep-links via ?tab=mqtt; falls back to 'device'.
 */
export function SettingsScreen() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab: TabId = isTabId(tabParam) ? tabParam : 'device'

  const { data, isLoading, error } = trpc.settings.getAll.useQuery({})

  const setActiveTab = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('tab', next)
      router.replace(`?${params.toString()}`, { scroll: false })
    },
    [router, searchParams],
  )

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 px-1">
          <Settings size={18} className="text-zinc-500" />
          <h1 className="text-lg font-semibold text-white">Settings</h1>
        </div>
        {[1, 2, 3].map(i => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-zinc-900" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-4">
        <p className="text-sm text-red-400">
          Failed to load settings:
          {error.message}
        </p>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 px-1">
        <Settings size={18} className="text-zinc-400" />
        <h1 className="text-lg font-semibold text-white">Settings</h1>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-4">
        <TabsList className="grid h-auto w-full grid-cols-4 gap-1 rounded-xl bg-zinc-900 p-1">
          <TabsTrigger value="device" className="flex h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-zinc-400 data-active:bg-zinc-800 data-active:text-white">
            <Cog size={14} />
            Device
          </TabsTrigger>
          <TabsTrigger value="sides" className="flex h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-zinc-400 data-active:bg-zinc-800 data-active:text-white">
            <User size={14} />
            Sides
          </TabsTrigger>
          <TabsTrigger value="gestures" className="flex h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-zinc-400 data-active:bg-zinc-800 data-active:text-white">
            <Hand size={14} />
            Gestures
          </TabsTrigger>
          <TabsTrigger value="mqtt" className="flex h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-zinc-400 data-active:bg-zinc-800 data-active:text-white">
            <Radio size={14} />
            MQTT
          </TabsTrigger>
        </TabsList>

        <TabsContent value="device">
          <DeviceTab device={data.device} />
        </TabsContent>

        <TabsContent value="sides">
          <SidesTab data={data} />
        </TabsContent>

        <TabsContent value="gestures">
          <TapGestureConfig />
        </TabsContent>

        <TabsContent value="mqtt">
          <MqttSettingsForm />
        </TabsContent>
      </Tabs>
    </div>
  )
}

interface DeviceTabProps {
  device: Parameters<typeof DeviceSettingsForm>[0]['device']
}

function DeviceTab({ device }: DeviceTabProps) {
  const rebootMutation = trpc.system.triggerUpdate.useMutation()
  return (
    <section className="space-y-4">
      <DeviceSettingsForm device={device} />

      <div className="flex gap-2">
        <button
          onClick={() => window.location.reload()}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-zinc-900 px-3 py-3 text-sm font-medium text-zinc-400 transition-colors active:bg-zinc-800"
        >
          <Wifi size={14} />
          Reconnect
        </button>
        <button
          onClick={() => {
            if (confirm('Restart the sleepypod service? The pod will be briefly unavailable.')) {
              rebootMutation.mutate({})
            }
          }}
          disabled={rebootMutation.isPending}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-zinc-900 px-3 py-3 text-sm font-medium text-zinc-400 transition-colors active:bg-zinc-800 disabled:opacity-50"
        >
          <RotateCcw size={14} />
          {rebootMutation.isPending ? 'Restarting...' : 'Restart'}
        </button>
      </div>
      {rebootMutation.isSuccess && (
        <p className="text-center text-xs text-emerald-400">Service restarting — reconnecting...</p>
      )}

      <HapticsTestCard />
    </section>
  )
}

interface SettingsData {
  device: Parameters<typeof DeviceSettingsForm>[0]['device']
  sides: {
    left: Parameters<typeof SideSettingsForm>[0]['sideData']
    right: Parameters<typeof SideSettingsForm>[0]['sideData']
  }
}

function SidesTab({ data }: { data: SettingsData }) {
  const [selectedSide, setSelectedSide] = useState<'left' | 'right'>('left')
  const { leftName, rightName } = useSideNames()

  return (
    <section className="space-y-4">
      <div className="flex rounded-xl bg-zinc-900 p-1">
        {([
          { key: 'left' as const, label: leftName },
          { key: 'right' as const, label: rightName },
        ]).map(t => (
          <button
            key={t.key}
            onClick={() => setSelectedSide(t.key)}
            className={clsx(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-medium transition-colors',
              selectedSide === t.key
                ? 'bg-zinc-800 text-white'
                : 'text-zinc-500',
            )}
          >
            <User size={14} />
            {t.label}
          </button>
        ))}
      </div>

      <SideSettingsForm
        side={selectedSide}
        sideData={selectedSide === 'left' ? data.sides.left : data.sides.right}
      />
    </section>
  )
}
