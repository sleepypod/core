import type { Metadata } from 'next'
import { BasePage } from '@/src/components/Base/BasePage'

export const metadata: Metadata = { title: 'Adjustable base' }
export default function Base() {
  return <BasePage />
}
