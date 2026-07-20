import { afterEach, describe, expect, it, vi } from 'vitest'
import linguiConfig from 'lingui.config'
import { allI18nInstances, allMessages, getI18nInstance } from './appRouterI18n'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('appRouterI18n catalog initialization', () => {
  it('loads every configured catalog and wires its messages into the matching instance', () => {
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
  it('returns the exact supported-locale instance without warning', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(getI18nInstance('es')).toBe(allI18nInstances.es)
    expect(warning).not.toHaveBeenCalled()
  })

  it('warns exactly and falls back to English for an unknown locale', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(getI18nInstance('not-supported')).toBe(allI18nInstances.en)
    expect(warning).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith('No i18n instance found for locale "not-supported"')
  })
})
