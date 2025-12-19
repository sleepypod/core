import { setI18n } from '@lingui/react/server'
import { getI18nInstance } from './appRouterI18n'

export interface PageLangParam {
  params: Promise<{ lang: string }>
}

export function initLingui(lang: string) {
  const i18n = getI18nInstance(lang)
  // Ensure the server-side instance is activated for rendering
  try {
    i18n.activate(lang)
  }
  catch (err) {
    console.error('Error activating i18n instance:', err)
  }
  setI18n(i18n)
  return i18n
}
