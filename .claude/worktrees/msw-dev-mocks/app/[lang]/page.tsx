import { getI18nInstance } from '@/src/lib/i18n/appRouterI18n'
import { initLingui } from '@/src/lib/i18n/initLingui'
import { setI18n } from '@lingui/react/server'

export default async function Page({
  params,
}: {
  params: Promise<{ lang: string }>
}) {
  const lang = (await params).lang
  const i18n = getI18nInstance(lang)
  initLingui(lang)
  setI18n(i18n)

  return (
    <div>

    </div>
  )
}
