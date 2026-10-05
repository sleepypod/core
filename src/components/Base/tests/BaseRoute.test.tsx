import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Base from '@/app/[lang]/base/page'
const provider = vi.hoisted(() => vi.fn())
vi.mock('@/src/providers/TRPCProvider', () => ({ TRPCProvider: ({ children, baseDebug }: { children: ReactNode, baseDebug?: boolean }) => {
  provider(baseDebug)
  return <div data-testid="isolated-provider">{children}</div>
} }))
vi.mock('../BasePage', () => ({ BasePage: () => <h1>Base</h1> }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
describe('base debug route', () => {
  it('creates an isolated provider only for debug=1 and offers a localized exit', async () => {
    render(await Base({ params: Promise.resolve({ lang: 'fr' }), searchParams: Promise.resolve({ debug: '1' }) }))
    expect(provider).toHaveBeenCalledWith(true)
    expect(screen.getByRole('status').textContent).toContain('No base commands are sent to hardware')
    expect(screen.getByRole('link', { name: 'Exit debug' }).getAttribute('href')).toBe('/fr/base')
  })
  it.each([undefined, '0', 'true', ['1', '0']])('leaves direct access in real mode for debug=%s', async (debug) => {
    render(await Base({ params: Promise.resolve({ lang: 'en' }), searchParams: Promise.resolve({ debug }) }))
    expect(screen.getByRole('heading', { name: 'Base' })).toBeTruthy()
    expect(provider).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
