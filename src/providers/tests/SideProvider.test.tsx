import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SideProvider, useSide, useShownSides } from '../SideProvider'

const state = vi.hoisted(() => ({
  device: { bedMode: 'two', unusedZoneMode: 'off' } as { bedMode: 'two' | 'solo-left' | 'solo-right', unusedZoneMode: 'off' | 'follow' | 'independent' },
  sides: undefined as undefined | { left: { awayMode: boolean }, right: { awayMode: boolean } },
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: { settings: { getAll: { useQuery: () => ({ data: state.sides ? { sides: state.sides, device: state.device } : undefined }) } } },
}))

type Ctx = ReturnType<typeof useSide>
let ctx: Ctx
const capture = (value: Ctx) => {
  ctx = value
}
function Probe({ onRender }: { onRender: (value: Ctx) => void }) {
  onRender(useSide())
  return null
}
const tree = () => <SideProvider><Probe onRender={capture} /></SideProvider>
const away = (left: boolean, right: boolean) => ({ left: { awayMode: left }, right: { awayMode: right } })

beforeEach(() => {
  localStorage.clear()
  document.cookie = 'sleepypod-side=; path=/; max-age=0' // cookie is the fallback store
  state.sides = away(false, false)
  state.device = { bedMode: 'two', unusedZoneMode: 'off' }
})
afterEach(cleanup)

describe('SideProvider sleeper setup', () => {
  it('keeps temperature selection and linking unchanged through solo, away and return', () => {
    localStorage.setItem('sleepypod-selected-side', 'right')
    const { rerender } = render(tree())
    state.device.bedMode = 'solo-left'
    rerender(tree())
    expect(ctx.singleSleeperSide).toBe('left')
    expect(ctx.selectedSide).toBe('right')
    expect(ctx.isLinked).toBe(false)
    act(() => ctx.toggleLink())
    state.sides = away(true, false)
    rerender(tree())
    expect(ctx.singleSleeperSide).toBeNull()
    expect(ctx.isLinked).toBe(true)
    state.sides = away(false, false)
    rerender(tree())
    expect(ctx.singleSleeperSide).toBe('left')
    expect(ctx.selectedSide).toBe('both')
    expect(ctx.isLinked).toBe(true)
  })

  it('keeps both schedule editors available for independent zones with one biometric sleeper', () => {
    state.device = { bedMode: 'solo-right', unusedZoneMode: 'independent' }
    render(tree())
    expect(ctx.singleSleeperSide).toBe('right')
    expect(ctx.singleScheduleSide).toBeNull()
  })

  it('focuses the source schedule when the other zone follows it', () => {
    state.device = { bedMode: 'solo-right', unusedZoneMode: 'follow' }
    render(tree())
    expect(ctx.singleScheduleSide).toBe('right')
  })

  it('keeps the selected side on reload while a partner is away', () => {
    state.sides = away(true, false)
    const first = render(tree())
    act(() => ctx.selectSide('left'))
    first.unmount()
    render(tree())
    expect(ctx.selectedSide).toBe('left')
    expect(ctx.singleSleeperSide).toBe('right')
  })

  it.each(['left', 'right'] as const)('shows only the %s sleeper through the display hook', (side) => {
    state.sides = away(side === 'right', side === 'left')
    const { result } = renderHook(() => useShownSides(), { wrapper: SideProvider })
    expect(result.current).toEqual([side])
  })
})
