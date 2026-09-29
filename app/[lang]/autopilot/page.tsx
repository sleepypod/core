import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AutopilotConsole } from '@/src/components/Autopilot/AutopilotConsole'

export const metadata: Metadata = { title: 'Autopilot' }

export default function AutopilotPage() {
  return (
    <Suspense>
      <AutopilotConsole />
    </Suspense>
  )
}
