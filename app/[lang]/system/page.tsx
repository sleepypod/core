import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SystemScreen } from '@/src/components/System/SystemScreen'

export const metadata: Metadata = { title: 'System' }

export default function SystemPage() {
  return (
    <Suspense>
      <SystemScreen />
    </Suspense>
  )
}
