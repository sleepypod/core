'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Square, RefreshCw } from 'lucide-react'
import { Button, Card, PageHeader } from '@/src/components/ds'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { BASE_PRESETS, basePositionSchema } from '@/src/hardware/base/types'
import type { BasePosition } from '@/src/hardware/base/types'
import { trpc } from '@/src/utils/trpc'
import { BaseSchedules } from './BaseSchedules'

function BedPreview({ head, feet }: { head: number, feet: number }) {
  const radians = Math.PI / 180
  const headX = 150 - Math.cos(head * radians) * 115
  const headY = 135 - Math.sin(head * radians) * 115
  const kneeX = 210 + Math.cos(feet * radians) * 60
  const kneeY = 135 - Math.sin(feet * radians) * 60
  return (
    <svg viewBox="0 0 360 190" role="img" aria-label={`Target preview: head ${head} degrees, feet ${feet} degrees`} className="mx-auto w-full max-w-lg text-fg">
      <path d="M25 160 H335 M60 160 V178 M300 160 V178" fill="none" stroke="currentColor" strokeWidth="3" opacity=".2" />
      <path d={`M${headX} ${headY} L150 135 H210 L${kneeX} ${kneeY} L330 135`} fill="none" stroke="currentColor" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="150" cy="135" r="4" className="fill-surface" />
      <circle cx="210" cy="135" r="4" className="fill-surface" />
    </svg>
  )
}

export function BasePage() {
  const lang = langFromPath(usePathname())
  const query = trpc.base.getStatus.useQuery({}, { refetchInterval: 2000 })
  const [target, setTarget] = useState<BasePosition>({ head: 0, feet: 0, feedRate: 50 })
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const refresh = () => {
    void query.refetch()
  }
  const onError = (error: { message: string }) => {
    setFailure(error.message)
    setNotice('')
    refresh()
  }
  const position = trpc.base.setPosition.useMutation({ onSuccess: () => {
    setNotice('Position commands sent. Measured angles update as the bed moves.')
    refresh()
  }, onError })
  const preset = trpc.base.setPreset.useMutation({ onSuccess: () => {
    setNotice('Preset commands sent. Measured angles update as the bed moves.')
    refresh()
  }, onError })
  const stop = trpc.base.stop.useMutation({ onSuccess: () => {
    setNotice('Stop command sent. Check that the bed has stopped.')
    refresh()
  }, onError })
  const reconnect = trpc.base.reconnect.useMutation({ onSuccess: refresh, onError })
  const status = query.data
  const pending = position.isPending || preset.isPending
  const stale = status?.stale !== false || query.isError
  const connected = status?.state === 'connected'
  const unavailable = !connected || stale || pending || stop.isPending || status?.busy || reconnect.isPending
  const resetNotice = () => {
    setFailure('')
    setNotice('')
  }
  const stateLabel = query.isLoading
    ? 'Checking connection…'
    : query.isError
      ? 'Status unavailable'
      : connected
        ? stale ? 'Position updates unavailable' : 'Connected'
        : status?.state === 'connecting'
          ? 'Connecting…'
          : status?.state === 'unconfigured' ? 'Base not configured' : 'Disconnected'

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Adjustable base" right={<Link href={`/${lang}`} className="text-sm text-fg-2">Temperature</Link>} />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium" role="status">{stateLabel}</p>
            <p className="mt-1 text-sm text-fg-2">Whole-bed control · head and feet move on both sides.</p>
          </div>
          <Button
            icon={RefreshCw}
            disabled={reconnect.isPending || pending || stop.isPending || status?.busy}
            onClick={() => {
              resetNotice()
              reconnect.mutate({})
            }}
          >
            Reconnect
          </Button>
        </div>
        {status?.splitBase && <p className="text-sm text-fg-2">Split base detected. Independent side positioning is not supported.</p>}
        {(status?.error || query.error) && <p className="text-sm text-warn">{query.error?.message ?? status?.error}</p>}
        {status?.state === 'unconfigured' && <p className="text-sm text-fg-2">Complete the base setup in the stock app, then select Reconnect here.</p>}
      </Card>
      <div className="grid items-start gap-4 @min-[800px]:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium">Position</h2>
            <span className="text-xs text-fg-2">{stale ? 'No live measurement' : status?.moving === null ? 'Motion unknown' : status?.moving ? 'Movement detected' : 'Position steady'}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {(['left', 'right'] as const).map(side => (
              <div key={side} className="rounded-ctl bg-active p-3">
                <p className="mb-1 capitalize text-fg-2">
                  {side}
                  {' '}
                  · measured
                </p>
                <p className="font-mono">{!stale && status?.position ? `${status.position[side].head}° head · ${status.position[side].feet}° feet` : '—'}</p>
              </div>
            ))}
          </div>
          <BedPreview head={target.head} feet={target.feet} />
          <p className="-mt-3 text-center text-xs text-fg-2">Selected target preview</p>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              resetNotice()
              position.mutate(target)
            }}
            className="flex flex-col gap-4"
          >
            {(['head', 'feet', 'feedRate'] as const).map(field => (
              <label key={field} className="flex flex-col gap-2 text-sm">
                <span className="flex justify-between">
                  <span>{field === 'feedRate' ? 'Movement speed' : field === 'head' ? 'Head angle' : 'Feet angle'}</span>
                  <span className="font-mono">
                    {target[field]}
                    {field === 'feedRate' ? '%' : '°'}
                  </span>
                </span>
                <input type="range" min={field === 'feedRate' ? 30 : 0} max={field === 'head' ? 60 : field === 'feet' ? 45 : 100} step={1} value={target[field]} disabled={pending || stop.isPending} onChange={event => setTarget({ ...target, [field]: Number(event.target.value) })} className="w-full accent-fg" />
              </label>
            ))}
            <Button type="submit" full variant="primary" disabled={!!unavailable || !basePositionSchema.safeParse(target).success}>{pending ? 'Sending position…' : 'Apply position'}</Button>
          </form>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(BASE_PRESETS).map(([name, value]) => (
              <Button
                key={name}
                aria-label={`${name} ${value.head}° / ${value.feet}°`}
                disabled={!!unavailable}
                onClick={() => {
                  resetNotice()
                  setTarget(value)
                  preset.mutate({ preset: name as keyof typeof BASE_PRESETS })
                }}
              >
                <span className="capitalize">{name}</span>
                <span className="font-mono text-xs text-fg-2">
                  {value.head}
                  ° /
                  {' '}
                  {value.feet}
                  °
                </span>
              </Button>
            ))}
          </div>
        </Card>
        <BaseSchedules target={target} onSelectTarget={setTarget} />
      </div>
      <div className="sticky bottom-[calc(90px+env(safe-area-inset-bottom,0px))] z-20 flex flex-col gap-2 rounded-card border border-line bg-surface p-3 min-[900px]:bottom-4">
        {failure && <p role="alert" className="text-sm text-danger">{failure}</p>}
        {notice && <p role="status" className="text-sm text-fg-2">{notice}</p>}
        <Button
          icon={Square}
          variant="danger"
          full
          disabled={stop.isPending || !connected}
          onClick={() => {
            resetNotice()
            stop.mutate({})
          }}
        >
          {stop.isPending ? 'Sending stop…' : 'Stop movement'}
        </Button>
      </div>
    </div>
  )
}
