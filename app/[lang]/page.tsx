import type { Metadata } from 'next'
import { TempScreen } from '@/src/components/TempScreen/TempScreen'
import { getI18nInstance } from '@/src/lib/i18n/appRouterI18n'
import { initLingui } from '@/src/lib/i18n/initLingui'
import { setI18n } from '@lingui/react/server'

// The layout's title template only applies to child segments, not this page.
export const metadata: Metadata = { title: { absolute: 'Temp · sleepypod' } }

export default async function Page({
  params,
}: {
  params: Promise<{ lang: string }>
}) {
  const lang = (await params).lang
  const i18n = getI18nInstance(lang)
  initLingui(lang)
  setI18n(i18n)

  return <TempScreen />
}
