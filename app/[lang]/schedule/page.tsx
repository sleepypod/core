import type { Metadata } from 'next'
import { SchedulePage } from '@/src/components/Schedule/SchedulePage'
import { BedroomSummary } from '@/src/components/Home/BedroomSummary'

export const metadata: Metadata = { title: 'Schedule' }

export default function Schedule() {
  return (
    <>
      <BedroomSummary />
      <SchedulePage />
    </>
  )
}
