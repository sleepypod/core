'use client'

import { useState } from 'react'
import { Crosshair } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSideNames } from '@/src/hooks/useSideNames'
import { Button, InlineError } from '@/src/components/ds'
import { cn } from '@/lib/utils'

type Side = 'left' | 'right'

/**
 * "Bed is empty — recalibrate": takes a fresh empty-bed capacitance reading
 * for a side whose presence reading is stuck. The sleep detector adopts a
 * newer manual profile within a minute. Asks first, because calibrating with
 * someone in bed would learn them as "empty".
 */
export function RecalibrateEmptyBed({ sides, size = 'md', align = 'end' }: { sides: Side[], size?: 'sm' | 'md', align?: 'start' | 'end' }) {
  const { sideName } = useSideNames()
  const [confirming, setConfirming] = useState(false)
  const utils = trpc.useUtils()
  const trigger = trpc.calibration.triggerCalibration.useMutation()
  const [done, setDone] = useState(false)
  const who = sides.map(s => sideName(s)).join(' and ')

  const run = async () => {
    setConfirming(false)
    for (const side of sides) await trigger.mutateAsync({ side, sensorType: 'capacitance' })
    setDone(true)
    // The detector reloads profiles every 60s; check again after that.
    setTimeout(() => void utils.health.dataPath.invalidate(), 70_000)
  }

  return (
    <div className={cn('flex flex-col gap-1.5', align === 'end' ? 'items-end text-right' : 'items-start')} data-testid="recalibrate-empty-bed">
      {confirming
        ? (
            <>
              <span className="max-w-[340px] text-xs text-fg-2 text-pretty">{`Make sure nobody is on ${who}’s side. Calibrating with someone in bed would learn them as empty.`}</span>
              <div className="flex gap-2">
                <Button size={size} variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
                <Button size={size} variant="primary" icon={Crosshair} onClick={() => void run().catch(() => {})}>Recalibrate</Button>
              </div>
            </>
          )
        : (
            <Button size={size} variant="primary" icon={Crosshair} disabled={trigger.isPending} onClick={() => setConfirming(true)}>
              {trigger.isPending ? 'Calibrating…' : `Bed is empty — recalibrate ${who}`}
            </Button>
          )}
      {done && !trigger.error && <span className="text-xs text-ok">Calibrating. The occupancy reading updates within a minute or two.</span>}
      {trigger.error && <InlineError className="text-xs">{trigger.error.message}</InlineError>}
    </div>
  )
}
