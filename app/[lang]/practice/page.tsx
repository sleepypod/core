import type { Metadata } from 'next'
import { PracticeScreen } from '@/src/components/Practice/PracticeScreen'

export const metadata: Metadata = { title: 'Practice the controls' }

export default function Page() {
  return <PracticeScreen />
}
