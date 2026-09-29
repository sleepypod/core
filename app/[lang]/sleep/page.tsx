import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SleepSections } from '@/src/components/Sleep/SleepSections'

export const metadata: Metadata = { title: 'Sleep' }

export default function SleepPage() {
  return (
    <Suspense>
      <SleepSections />
    </Suspense>
  )
}
