'use client'

import { Card, InlineError, SectionLabel, Skeleton } from '@/src/components/ds'
import { AmbientLightChip } from '@/src/components/TempScreen/AmbientLightChip'
import { formatDisplayTemp, type TempUnit } from '@/src/lib/tempUtils'
import type { Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'

interface EnvironmentInfoProps {
  /** Side whose surface sensors give the bed air reading. */
  side: Side
  /** Temperature unit preference */
  unit?: TempUnit
}

function mean(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v))
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length
}

/**
 * Room card: inside (ambient) temperature, humidity, and bed air temperature
 * (mean of the side's outer/center/inner surface sensors), with the ambient
 * light reading in the label row.
 *
 * Wires into environment.getLatestBedTemp (values already in `unit`).
 */
export const EnvironmentInfoPanel = ({ side, unit = 'F' }: EnvironmentInfoProps) => {
  const { data, isLoading, error } = trpc.environment.getLatestBedTemp.useQuery(
    { unit },
    { refetchInterval: 10_000 },
  )

  if (isLoading) return <Skeleton className="h-[96px]" />

  const bedAir = data
    ? side === 'left'
      ? mean([data.leftOuterTemp, data.leftCenterTemp, data.leftInnerTemp])
      : mean([data.rightOuterTemp, data.rightCenterTemp, data.rightInnerTemp])
    : null

  return (
    <Card className="grid grid-cols-3 content-start gap-2">
      <SectionLabel className="col-span-full" right={<AmbientLightChip />}>Room</SectionLabel>
      {error
        ? <InlineError className="col-span-full">{`Could not load room climate: ${error.message}`}</InlineError>
        : (
            <>
              <Reading value={formatDisplayTemp(data?.ambientTemp, unit, { includeUnit: false, nullDisplay: '—' })} label="Inside" />
              <Reading value={data?.humidity == null ? '—' : `${Math.round(data.humidity)}%`} label="Humidity" />
              <Reading value={formatDisplayTemp(bedAir, unit, { decimals: 1, includeUnit: false, nullDisplay: '—' })} label="Bed air" />
            </>
          )}
    </Card>
  )
}

function Reading({ value, label }: { value: string, label: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate font-mono text-xl font-light">{value}</div>
      <div className="text-xs text-fg-2">{label}</div>
    </div>
  )
}
