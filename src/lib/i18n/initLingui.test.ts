import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getI18nInstance: vi.fn(),
  setI18n: vi.fn(),
  i18n: { activate: vi.fn() },
}))

vi.mock('@lingui/react/server', () => ({ setI18n: mocks.setI18n }))
vi.mock('./appRouterI18n', () => ({ getI18nInstance: mocks.getI18nInstance }))

const { initLingui } = await import('./initLingui')

beforeEach(() => {
  mocks.i18n.activate.mockReset()
  mocks.getI18nInstance.mockReset().mockReturnValue(mocks.i18n)
  mocks.setI18n.mockReset()
  vi.restoreAllMocks()
})

describe('initLingui', () => {
  it('gets, activates, registers, and returns the requested instance', () => {
    expect(initLingui('es')).toBe(mocks.i18n)
    expect(mocks.getI18nInstance).toHaveBeenCalledWith('es')
    expect(mocks.i18n.activate).toHaveBeenCalledWith('es')
    expect(mocks.setI18n).toHaveBeenCalledWith(mocks.i18n)
  })

  it('logs activation errors but still registers and returns the instance', () => {
    const error = new Error('catalog activation failed')
    mocks.i18n.activate.mockImplementationOnce(() => {
      throw error
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(initLingui('en')).toBe(mocks.i18n)
    expect(log).toHaveBeenCalledWith('Error activating i18n instance:', error)
    expect(mocks.setI18n).toHaveBeenCalledWith(mocks.i18n)
  })
})
