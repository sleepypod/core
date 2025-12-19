import 'server-only'

import type { I18n, Messages } from '@lingui/core'
import { setupI18n } from '@lingui/core'
import linguiConfig from 'lingui.config'

const { locales } = linguiConfig

type AllI18nInstances = Record<string, I18n>
type SupportedLocales = string

async function loadCatalog(locale: SupportedLocales): Promise<{
  [k: string]: Messages
}> {
  const { messages } = await import(`./locales/${locale}.po`)
  return {
    [locale]: messages,
  }
}
const catalogs: Array<Record<string, Messages>> = await Promise.all(
  locales.map((l: string) => loadCatalog(l)),
)

// transform array of catalogs into a single object
export const allMessages: Record<string, Messages> = catalogs.reduce(
  (acc: Record<string, Messages>, oneCatalog: Record<string, Messages>) => {
    return { ...acc, ...oneCatalog }
  },
  {},
)

export const allI18nInstances: AllI18nInstances = (() => {
  const map: Record<string, I18n> = {}
  for (const locale of locales) {
    const messages = allMessages[locale] ?? {}
    const i18n = setupI18n({
      locale,
      messages: { [locale]: messages },
    })
    map[locale] = i18n
  }

  return map
})()

export const getI18nInstance = (locale: SupportedLocales): I18n => {
  if (!allI18nInstances[locale]) {
    console.warn(`No i18n instance found for locale "${locale}"`)
  }
  return allI18nInstances[locale] || allI18nInstances['en']
}
