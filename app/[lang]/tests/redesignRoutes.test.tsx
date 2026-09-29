import { fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ redirect: vi.fn(), rule: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('next/font/google', () => ({ IBM_Plex_Mono: () => ({ variable: 'mono' }), IBM_Plex_Sans: () => ({ variable: 'sans' }) }))
vi.mock('next/script', () => ({ default: ({ children }: { children: ReactNode }) => <script>{children}</script> }))
vi.mock('@/src/lib/i18n/appRouterI18n', () => ({ allMessages: { en: {} }, getI18nInstance: () => ({}) }))
vi.mock('@lingui/react/server', () => ({ setI18n: vi.fn() }))
vi.mock('@/src/providers/LinguiClientProvider', () => ({ LinguiClientProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/src/providers/SideProvider', () => ({ SideProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/src/providers/TRPCProvider', () => ({ TRPCProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/src/providers/WeekNavigatorProvider', () => ({ WeekNavigatorProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/src/components/AppShell/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }))
vi.mock('@/src/components/Autopilot/AutopilotConsole', () => ({ AutopilotConsole: () => <div>Automations page</div> }))
vi.mock('@/src/components/Autopilot/RulePage', () => ({ RulePage: (props: unknown) => {
  mocks.rule(props)
  return <div>Rule page</div>
} }))
vi.mock('@/src/components/Sleep/SleepSections', () => ({ SleepSections: () => <div>Sleep page</div> }))
vi.mock('@/src/components/System/SystemScreen', () => ({ SystemScreen: () => <div>System page</div> }))

it('renders redesigned entry pages and passes rule route parameters', async () => {
  const { default: Autopilot } = await import('../autopilot/page')
  const { default: Sleep } = await import('../sleep/page')
  const { default: System } = await import('../system/page')
  const { default: Rule } = await import('../autopilot/[id]/page')
  render(
    <>
      <Autopilot />
      <Sleep />
      <System />
      {await Rule({ params: Promise.resolve({ id: 'new' }), searchParams: Promise.resolve({ template: 'restless' }) })}
    </>
  )
  expect(screen.getByText('Automations page')).toBeTruthy()
  expect(screen.getByText('Sleep page')).toBeTruthy()
  expect(screen.getByText('System page')).toBeTruthy()
  expect(mocks.rule).toHaveBeenCalledWith(expect.objectContaining({ id: 'new', template: 'restless' }))
})

it.each([
  ['data', '/de/sleep'], ['debug', '/de/system'],
  ['sensors', '/de/system'], ['status', '/de/system'],
])('redirects the legacy %s route in the selected language', async (route, url) => {
  const modules = { data: () => import('../data/page'), debug: () => import('../debug/page'), sensors: () => import('../sensors/page'), status: () => import('../status/page') }
  const { default: Page } = await modules[route as keyof typeof modules]()
  await Page({ params: Promise.resolve({ lang: 'de' }) })
  expect(mocks.redirect).toHaveBeenLastCalledWith(url)
})

it('sets fonts, locale and pre-paint theme initialization in the app layout', async () => {
  const { default: Layout, generateStaticParams } = await import('../layout')
  expect(generateStaticParams()).toEqual([{ lang: 'en' }, { lang: 'es' }, { lang: 'pseudo' }])
  const html = renderToStaticMarkup(await Layout({ params: Promise.resolve({ lang: 'en' }), children: <h1>Pod</h1> }))
  expect(html).toContain('class="dark sans mono"')
  expect(html).toContain('sleepypod-pref-theme')
  expect(html).toContain('<main><h1>Pod</h1></main>')
})

it('retries a failed System page and includes an optional error digest', async () => {
  const { default: ErrorPage } = await import('../system/error')
  const reset = vi.fn()
  const { rerender } = render(<ErrorPage error={new Error('Offline')} reset={reset} />)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(reset).toHaveBeenCalledOnce()
  rerender(<ErrorPage error={Object.assign(new Error('Offline'), { digest: 'abc' })} reset={reset} />)
  expect(screen.getByText('(abc)')).toBeTruthy()
})
