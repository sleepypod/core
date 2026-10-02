import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StatusPanel, type DiagRule, type Diagnostics } from '../StatusPanel'

vi.mock('next/navigation', () => ({ usePathname: () => '/en/autopilot' }))

const now = new Date('2026-09-28T18:00:30')
const startOfDay = new Date('2026-09-28T00:00:00')
const at = (h: number, m: number) => new Date(2026, 8, 28, h, m, 5)

const rule: DiagRule = {
  id: 7,
  name: 'Ambient demo',
  enabled: true,
  dryRun: true,
  side: null,
  priority: 0,
  cooldownMin: 30,
  trigger: { kind: 'tick', everyMin: 1 },
  conditions: {
    kind: 'and',
    conditions: [{ kind: 'compare', op: '>', left: { kind: 'signal', signal: 'ambient.temperature' }, right: { kind: 'literal', value: 75 } }],
  },
  actions: [{ kind: 'notify', message: 'hot' }],
  runs: [
    { t: at(16, 11), outcome: 'dry_run', reason: null, sent: false },
    { t: at(17, 58), outcome: 'skipped', reason: 'condition-false', sent: false },
    { t: at(17, 59), outcome: 'skipped', reason: 'condition-false', sent: false },
    { t: at(18, 0), outcome: 'skipped', reason: 'condition-false', sent: false },
  ],
  signals: { 'ambient.temperature': 72.3 },
}

function data(r: DiagRule = rule): Diagnostics {
  return { now, startOfDay, globalEnabled: true, rules: [r] }
}

describe('StatusPanel diagnostics card', () => {
  it('links to the rule page and switches mode through the segmented control', () => {
    const onMode = vi.fn()
    render(<StatusPanel data={data()} loading={false} onKill={vi.fn()} onMode={onMode} />)
    expect(screen.getByRole('link', { name: 'Ambient demo' }).getAttribute('href')).toBe('/en/autopilot/7')
    fireEvent.click(screen.getByRole('tab', { name: 'Live' }))
    expect(onMode).toHaveBeenCalledWith(7, 'live')
  })

  it('separates last evaluated from fired and shows the live condition reading', () => {
    render(<StatusPanel data={data()} loading={false} onKill={vi.fn()} onMode={vi.fn()} />)
    expect(screen.getByText('just now')).toBeTruthy()
    expect(screen.getByText('false')).toBeTruthy()
    expect(screen.getByText('ambient temp 72.3°F now, needs > 75°F')).toBeTruthy()
    expect(screen.getByText(/· dry-run$/)).toBeTruthy()
    expect(screen.getByText('0 live actions sent')).toBeTruthy()
  })

  it('groups repeats in the run log and filters by outcome', () => {
    render(<StatusPanel data={data()} loading={false} onKill={vi.fn()} onMode={vi.fn()} />)
    expect(screen.getByText('17:58 – 18:00')).toBeTruthy()
    expect(screen.getByText('×3')).toBeTruthy()
    // 16:12–17:57 has no rows while the rule ticks every minute → missing.
    expect(screen.getByText('MISSING')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Would fire/ }))
    expect(screen.queryByText('×3')).toBeNull()
    expect(screen.getByText('WOULD FIRE')).toBeTruthy()
  })

  it('does not flag missing minutes for a disabled rule', () => {
    render(<StatusPanel data={data({ ...rule, enabled: false })} loading={false} onKill={vi.fn()} onMode={vi.fn()} />)
    expect(screen.queryByText('MISSING')).toBeNull()
  })
})

it('handles loading, empty and globally halted diagnostics', () => {
  const onKill = vi.fn()
  const { rerender } = render(<StatusPanel data={undefined} loading onKill={onKill} onMode={vi.fn()} />)
  expect(screen.getByText('Loading status…')).toBeTruthy()
  rerender(<StatusPanel data={{ ...data(), rules: [], globalEnabled: false }} loading={false} onKill={onKill} onMode={vi.fn()} />)
  expect(screen.getByText('No automations yet.')).toBeTruthy()
  expect(screen.getByText('Autopilot halted')).toBeTruthy()
  fireEvent.click(screen.getByRole('switch', { name: 'Autopilot enabled' }))
  expect(onKill).toHaveBeenCalledWith(true)
})

it.each([5, 120, 2880])('shows older evaluations (%s minutes) and live, cooldown and error outcomes', (minutes) => {
  const stamp = new Date(now.getTime() - minutes * 60000)
  const r: DiagRule = { ...rule, dryRun: false, side: 'right', cooldownMin: null, conditions: { kind: 'and', conditions: [] }, runs: [
    { t: stamp, outcome: 'fired', reason: null, sent: true },
    { t: stamp, outcome: 'error', reason: 'action-error', sent: false },
  ] }
  render(<StatusPanel data={data(r)} loading={false} onKill={vi.fn()} onMode={vi.fn()} />)
  expect(screen.getByText('no threshold')).toBeTruthy()
  expect(screen.getAllByText(minutes === 5 ? '5 min ago' : minutes === 120 ? '2 h ago' : '2 d ago').length).toBeGreaterThan(0)
})

it('explains cooldown bands, grouped pairs and missing live signals', () => {
  const r: DiagRule = { ...rule, dryRun: false, signals: {}, runs: [
    { t: at(17, 55), outcome: 'fired', reason: null, sent: false },
    { t: at(17, 56), outcome: 'skipped', reason: 'cooldown', sent: false },
    { t: at(17, 57), outcome: 'skipped', reason: 'cooldown', sent: false },
    { t: at(17, 58), outcome: 'error', reason: null, sent: false },
    { t: at(17, 59), outcome: 'fired', reason: null, sent: true },
  ] }
  render(<StatusPanel data={data(r)} loading={false} onKill={vi.fn()} onMode={vi.fn()} />)
  expect(screen.getByText('17:56, 17:57')).toBeTruthy()
  expect(screen.getByText('condition true, held by the 30 min cooldown')).toBeTruthy()
  expect(screen.getByText('fired · no command needed')).toBeTruthy()
  expect(screen.getByText(/ambient temp unavailable/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Fired/ }))
  expect(screen.queryByText('COOLDOWN')).toBeNull()
})
