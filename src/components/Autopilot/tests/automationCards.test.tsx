import { requiredTemplate } from './builderFixtures'
import type * as CurveChartModule from '@/src/components/Schedule/CurveChart'
import type * as SideProviderModule from '@/src/providers/SideProvider'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ActivityCard, type ActivityData } from '../ActivityCard'
import { AutomationsList, type ListItem } from '../AutomationsList'
import { TonightCard, type TimelineRule } from '../TonightCard'
import { TEMPLATES } from '../builderModel'
import type { SideTonight } from '../automationsLogic'

const t = (day: number, hour: number) => new Date(2026, 8, day, hour).getTime()
const mock = vi.hoisted(() => ({ minute: null as number | null, schedule: undefined as unknown }))
vi.mock('@/src/components/Schedule/CurveChart', async importOriginal => ({ ...await importOriginal<typeof CurveChartModule>(), useNowMinute: () => mock.minute }))
const single = vi.hoisted(() => ({ sides: null as null | Array<'left' | 'right'> }))
vi.mock('@/src/providers/SideProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof SideProviderModule>()
  return {
    ...actual,
    useShownSides: () => single.sides ?? actual.useShownSides(),
  }
})
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ sideName: (side: string) => side === 'left' ? 'Alex' : 'Sam' }) }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { schedules: { getAll: { useQuery: () => ({ data: mock.schedule }) } } } }))
beforeEach(() => {
  mock.minute = t(28, 23) / 60000
  mock.schedule = undefined
})

it('renders loading and empty automation lists and opens each starter template', () => {
  const onTemplate = vi.fn()
  const props = { items: [], loading: true, onMode: vi.fn(), onOpen: vi.fn(), onTemplate }
  const { rerender } = render(<AutomationsList {...props} />)
  expect(screen.getByText('Loading automations…')).toBeTruthy()
  rerender(<AutomationsList {...props} loading={false} />)
  for (const template of TEMPLATES) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(template.title.replace('+', '\\+')) }))
    expect(onTemplate).toHaveBeenLastCalledWith(template.id)
  }
})

it('opens rows by keyboard and changes modes without opening the editor', () => {
  const builder = requiredTemplate('restless')
  const item: ListItem = { id: 1, name: 'Restless', mode: 'dryrun', side: 'both', builder, backtest: { nights: 5, wouldFire: 2, peak: 250, threshold: 200 } }
  const onOpen = vi.fn(), onMode = vi.fn()
  render(<AutomationsList items={[item]} loading={false} onMode={onMode} onOpen={onOpen} onTemplate={vi.fn()} />)
  expect(screen.getByText('no live movement signal')).toBeTruthy()
  expect(screen.getByTestId('backtest-1').textContent).toContain('2 would fire')
  fireEvent.click(screen.getByRole('radio', { name: 'Dry-run' }))
  expect(onMode).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: 'Active' }))
  expect(onMode).toHaveBeenCalledWith(1, 'active')
  fireEvent.keyDown(screen.getByRole('radio', { name: 'Off' }), { key: 'Enter' })
  expect(onOpen).not.toHaveBeenCalled()
  const row = screen.getByTestId('rule-1')
  fireEvent.keyDown(row, { key: 'Escape' })
  fireEvent.keyDown(row, { key: 'Enter' })
  fireEvent.keyDown(row, { key: ' ' })
  fireEvent.click(row)
  expect(onOpen).toHaveBeenCalledTimes(3)
  expect(onOpen).toHaveBeenLastCalledWith(item)
})

it('groups activity by night, inserts holds, filters outcomes and requests more nights', () => {
  const onMore = vi.fn()
  const props = { rules: new Map(), fmt: (f: number) => `${f}°`, onMore, loadingMore: false }
  const { rerender } = render(<ActivityCard {...props} data={undefined} />)
  expect(screen.getByText('Loading activity…')).toBeTruthy()
  const data: ActivityData = {
    now: t(28, 23),
    nights: [{ start: t(28, 18), entries: [
      { ruleId: 1, ruleName: 'Cool', outcome: 'fired', code: 'set-temperature', temp: 75, sides: ['left'], start: t(28, 21), end: t(28, 21), count: 1 },
      { ruleId: 2, ruleName: 'Quiet', outcome: 'skipped', code: 'cooldown', temp: null, sides: [], start: t(28, 20), end: t(28, 22), count: 3 },
      { ruleId: 3, ruleName: 'Future', outcome: 'future-outcome', code: 'unknown', temp: null, sides: [], start: t(28, 19), end: t(28, 19), count: 1 },
    ] }, { start: t(27, 18), entries: [] }],
    holds: [
      { side: 'left', temperature: 80, startedAt: t(28, 22), expiresAt: t(29, 1) },
      { side: 'right', temperature: 78, startedAt: t(27, 22), expiresAt: t(28, 1) },
      { side: 'right', temperature: 70, startedAt: t(26, 22), expiresAt: t(27, 1) },
    ],
  }
  rerender(<ActivityCard {...props} data={data} />)
  expect(screen.getByText('cooling down · 3×', { exact: false })).toBeTruthy()
  expect(screen.getByText('Left side')).toBeTruthy()
  expect(screen.getByText('Right side')).toBeTruthy()
  expect(screen.getByText('future-outcome')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Fired' }))
  expect(screen.queryByText('Left side')).toBeNull()
  expect(screen.queryByText('Quiet')).toBeNull()
  expect(screen.getByText('Cool')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Would fire' }))
  expect(screen.getAllByText('Nothing logged.')).toHaveLength(2)
  fireEvent.click(screen.getByRole('tab', { name: 'Skipped' }))
  expect(screen.getByText('Quiet')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
  expect(onMore).toHaveBeenCalledOnce()
  rerender(<ActivityCard {...props} data={data} loadingMore />)
  expect(screen.getByRole('button', { name: 'Loading…' }).hasAttribute('disabled')).toBe(true)
})

it('renders side ownership, schedule blocks, holds, rule windows and filtered fire marks', () => {
  mock.schedule = { temperature: [{ enabled: true, dayOfWeek: 'monday', time: '22:00', temperature: 78 }, { enabled: true, dayOfWeek: 'monday', time: '07:00', temperature: 80 }] }
  const empty: SideTonight = { control: null, hold: null, runOnceUntil: null, lastAutopilot: null }
  const rules: TimelineRule[] = [
    { id: 1, name: 'Dry rule', mode: 'dryrun', side: null, conditions: { kind: 'and', conditions: [] }, missing: [] },
    { id: 2, name: 'No movement', mode: 'active', side: 'left', conditions: { kind: 'and', conditions: [] }, missing: ['movement'] },
    { id: 3, name: 'Off rule', mode: 'off', side: null, conditions: { kind: 'and', conditions: [] }, missing: [] },
    { id: 4, name: 'Outside', mode: 'active', side: 'right', conditions: { kind: 'timeBetween', start: '12:00', end: '13:00' }, missing: [] },
    { id: 5, name: 'Live rule', mode: 'active', side: 'right', conditions: { kind: 'and', conditions: [] }, missing: [] },
  ]
  render(
    <TonightCard
      unit="F"
      rules={rules}
      tonight={{ now: t(28, 23), sides: {
        left: { ...empty, hold: { temperature: 81, startedAt: t(28, 22), expiresAt: t(29, 1) } }, right: empty,
      } }}
      fires={[
        { ruleId: 1, at: t(28, 23), outcome: 'dry_run', sides: ['left'] },
        { ruleId: 5, at: t(29, 1), outcome: 'fired', sides: [] },
        { ruleId: 1, at: t(27, 23), outcome: 'fired', sides: ['right'] },
      ]}
    />
  )
  expect(screen.getByTestId('owner-left').textContent).toContain('Manual hold')
  expect(screen.getByTestId('hold-left').textContent).toBe('81°')
  expect(screen.queryByTestId('hold-right')).toBeNull()
  expect(screen.getByTestId('lane-left-auto').textContent).toContain('no movement signal')
  expect(screen.getByTestId('lane-right-auto').textContent).toContain('Live rule')
  expect(screen.queryByText('Off rule')).toBeNull()
  expect(screen.queryByText('Outside')).toBeNull()
  expect(screen.getAllByTitle('1:00 AM · fired')).toHaveLength(2)
  expect(screen.getByTitle('11:00 PM · would fire')).toBeTruthy()
  expect(screen.getByTestId('tonight-now')).toBeTruthy()

  // Hover: one line across the lanes reading each side's setting at that moment (a hold wins).
  const lanes = screen.getByTestId('tonight-lanes')
  vi.spyOn(lanes, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 1120, height: 100, right: 1120, bottom: 100, toJSON: () => ({}) })
  // 6 PM \u2192 9 AM is 15 h; 11 PM is 5 h in, past the 120px label columns.
  fireEvent.pointerMove(lanes, { clientX: 120 + 1000 * 5 / 15, clientY: 20 })
  expect(screen.getByTestId('chart-hover').textContent).toMatch(/^11:00\sPM \u00b7 Alex 81\u00b0 hold \u00b7 Sam 78\u00b0$/)
  fireEvent.pointerLeave(lanes)
  expect(screen.queryByTestId('chart-hover')).toBeNull()
})

it('shows tonight for the sleeper\'s side only when the other is away', () => {
  single.sides = ['right']
  try {
    render(<TonightCard rules={[]} tonight={undefined} fires={[]} unit="F" />)
    expect(screen.getByTestId('owner-right')).toBeTruthy()
    expect(screen.queryByTestId('owner-left')).toBeNull()
  }
  finally {
    single.sides = null
  }
})

it('waits for the client clock and shows owner loading placeholders', () => {
  mock.minute = null
  const { rerender } = render(<TonightCard rules={[]} tonight={undefined} fires={[]} unit="C" />)
  expect(screen.queryByTestId('tonight-card')).toBeNull()
  mock.minute = t(28, 12) / 60000
  rerender(<TonightCard rules={[]} tonight={undefined} fires={[]} unit="C" />)
  expect(screen.getAllByText('Loading…')).toHaveLength(2)
  expect(screen.queryByTestId('tonight-now')).toBeNull()
})
