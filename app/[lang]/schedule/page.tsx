import type { Metadata } from 'next'
import { SchedulePage } from '@/src/components/Schedule/SchedulePage'
import { BedroomSummary } from '@/src/components/Home/BedroomSummary'

export const metadata: Metadata = { title: 'Schedule' }

export default async function Schedule({ searchParams }: { searchParams: Promise<{ side?: string | string[] }> }) {
  const { side } = await searchParams
  const initialSide = side === 'left' || side === 'right' || side === 'both' ? side : undefined
  return (
    <>
      <BedroomSummary />
      <SchedulePage initialSide={initialSide} />
    </>
  )
}
