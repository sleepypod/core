'use client'

import { useState } from 'react'
import { Crosshair, RotateCw } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSideNames } from '@/src/hooks/useSideNames'
import { Button, InlineError } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import type { RestartableUnit } from '@/src/lib/dataPath'

type Side = 'left' | 'right'

/**
 * A side reads occupied but has had no vitals or movement for hours. Either
 * nobody is there and the empty-bed capacitance reading has drifted, or
 * someone is and vitals are stuck — only a person at the bed can tell, so
 * ask, and run the fix for the answer:
 *   nobody → take a fresh empty-bed reading (the sleep detector adopts a
 *            newer manual profile within a minute)
 *   someone → restart the piezo processor
 */
export function OccupancyCheck({ sides, unit = 'sleepypod-piezo-processor.service', size = 'md', align = 'end' }: {
  sides: Side[]
  unit?: RestartableUnit
  size?: 'sm' | 'md'
  align?: 'start' | 'end'
}) {
  const { sideName } = useSideNames()
  const utils = trpc.useUtils()
  const calibrate = trpc.calibration.triggerCalibration.useMutation()
  const restart = trpc.health.restartService.useMutation()
  const [answer, setAnswer] = useState<'nobody' | 'someone' | null>(null)
  const who = sides.map(s => sideName(s)).join(' and ')
  const busy = calibrate.isPending || restart.isPending
  // The detector reloads profiles every 60s, the processor needs a minute of data.
  const recheck = () => setTimeout(() => void utils.health.dataPath.invalidate(), 70_000)

  const nobody = async () => {
    setAnswer('nobody')
    for (const side of sides) await calibrate.mutateAsync({ side, sensorType: 'capacitance' })
    recheck()
  }
  const someone = async () => {
    setAnswer('someone')
    await restart.mutateAsync({ unit })
    recheck()
  }

  const result = answer === 'nobody' && calibrate.isSuccess
    ? { ok: true, text: 'Taking a fresh empty-bed reading. Occupancy updates within a minute or two.' }
    : answer === 'someone' && restart.data
      ? { ok: restart.data.ok, text: restart.data.ok ? 'Restarted the piezo processor. Vitals should resume within a few minutes.' : restart.data.message }
      : null

  return (
    <div className={cn('flex flex-col gap-1.5', align === 'end' ? 'items-end text-right' : 'items-start')} data-testid="occupancy-check">
      <span className="text-xs text-fg-2">{`Is anyone on ${who}’s side right now?`}</span>
      <div className="flex flex-wrap gap-2">
        <Button size={size} icon={Crosshair} disabled={busy} onClick={() => void nobody().catch(() => {})}>
          {calibrate.isPending ? 'Calibrating…' : 'No — recalibrate empty bed'}
        </Button>
        <Button size={size} icon={RotateCw} disabled={busy} onClick={() => void someone().catch(() => {})}>
          {restart.isPending ? 'Restarting…' : 'Yes — restart piezo processor'}
        </Button>
      </div>
      {result && <span className={cn('max-w-[420px] text-xs', result.ok ? 'text-ok' : 'font-mono text-warn')}>{result.text}</span>}
      {(calibrate.error ?? restart.error) && <InlineError className="text-xs">{(calibrate.error ?? restart.error)?.message}</InlineError>}
    </div>
  )
}
