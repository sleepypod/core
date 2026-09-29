import type { Metadata } from 'next'
import { SchedulePage } from '@/src/components/Schedule/SchedulePage'

export const metadata: Metadata = { title: 'Schedule' }

export default function Schedule() {
  return <SchedulePage />
}
