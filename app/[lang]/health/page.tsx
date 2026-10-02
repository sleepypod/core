import type { Metadata } from 'next'
import { HealthcheckDemo } from './HealthcheckDemo'

export const metadata: Metadata = { title: 'Healthcheck' }

export default function Page() {
  return <HealthcheckDemo />
}
