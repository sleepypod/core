import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import linguiConfig from 'lingui.config'

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('appRouterI18n catalog initialization', () => {
  it('loads every configured catalog and wires its messages into the matching instance', async () => {
    const { allI18nInstances, allMessages } = await import('./appRouterI18n')

    expect(Object.keys(allMessages).sort()).toEqual([...linguiConfig.locales].sort())
    expect(Object.keys(allI18nInstances).sort()).toEqual([...linguiConfig.locales].sort())

    for (const locale of linguiConfig.locales) {
      expect(Object.keys(allMessages[locale] ?? {}).length).toBeGreaterThan(0)
      expect(allI18nInstances[locale]?.locale).toBe(locale)
      expect(allI18nInstances[locale]?.messages).toEqual(allMessages[locale])
    }
  })
})

describe('getI18nInstance', () => {
  it('returns the exact supported-locale instance without warning', async () => {
    const { allI18nInstances, getI18nInstance } = await import('./appRouterI18n')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(getI18nInstance('es')).toBe(allI18nInstances.es)
    expect(warning).not.toHaveBeenCalled()
  })

  it('warns exactly and falls back to English for an unknown locale', async () => {
    const { allI18nInstances, getI18nInstance } = await import('./appRouterI18n')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(getI18nInstance('not-supported')).toBe(allI18nInstances.en)
    expect(warning).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith('No i18n instance found for locale "not-supported"')
  })
})
