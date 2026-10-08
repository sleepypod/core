import type { Metadata } from 'next'
import { SchedulePage } from '@/src/components/Schedule/SchedulePage'
import type { SideSelection } from '@/src/providers/SideProvider'

export const metadata: Metadata = { title: 'Curve · Schedule' }

const SIDES: SideSelection[] = ['left', 'right', 'both']

export default async function ScheduleCurve({ params, searchParams }: {
  params: Promise<{ curve: string }>
  searchParams: Promise<{ side?: string | string[], from?: string | string[] }>
}) {
  const { curve } = await params
  const { side, from } = await searchParams
  return (
    <SchedulePage
      curve={curve}
      curveSide={SIDES.find(s => s === side)}
      fromBoth={from === 'both'}
    />
  )
}
