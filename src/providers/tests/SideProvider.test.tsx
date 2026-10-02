import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SideProvider, useSide } from '../SideProvider'

const state = vi.hoisted(() => ({
  sides: undefined as undefined | { left: { awayMode: boolean }, right: { awayMode: boolean } },
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: { settings: { getAll: { useQuery: () => ({ data: state.sides ? { sides: state.sides } : undefined }) } } },
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
})
afterEach(cleanup)

describe('SideProvider single-sleeper mode', () => {
  it('reports no single sleeper and keeps the selection when neither side is away', () => {
    localStorage.setItem('sleepypod-selected-side', 'right')
    render(tree())
    expect(ctx.singleSleeperSide).toBeNull()
    expect(ctx.selectedSide).toBe('right')
  })

  it('defaults control screens to both (linked) when one side goes away', () => {
    localStorage.setItem('sleepypod-selected-side', 'right')
    state.sides = away(false, true)
    render(tree())
    expect(ctx.singleSleeperSide).toBe('left')
    expect(ctx.selectedSide).toBe('both')
    expect(ctx.isLinked).toBe(true)
  })

  it('still lets the user pick a side, and a reload keeps that choice', () => {
    state.sides = away(true, false)
    const first = render(tree())
    act(() => ctx.selectSide('left'))
    expect(ctx.selectedSide).toBe('left')
    first.unmount()
    render(tree())
    expect(ctx.selectedSide).toBe('left')
    expect(ctx.singleSleeperSide).toBe('right')
  })

  it('restores the previous selection when away mode is turned off', () => {
    localStorage.setItem('sleepypod-selected-side', 'right')
    state.sides = away(false, true)
    const { rerender } = render(tree())
    expect(ctx.selectedSide).toBe('both')
    state.sides = away(false, false)
    rerender(tree())
    expect(ctx.selectedSide).toBe('right')
    expect(ctx.isLinked).toBe(false)
    expect(localStorage.getItem('sleepypod-single-sleeper-side')).toBeNull()
  })

  it('waits for settings before deciding (no flip-flop on load)', () => {
    localStorage.setItem('sleepypod-selected-side', 'right')
    localStorage.setItem('sleepypod-single-sleeper-side', 'left')
    state.sides = undefined
    render(tree())
    expect(ctx.selectedSide).toBe('right')
    expect(localStorage.getItem('sleepypod-single-sleeper-side')).toBe('left')
  })

  it('is per-side when both sides are away', () => {
    state.sides = away(true, true)
    render(tree())
    expect(ctx.singleSleeperSide).toBeNull()
    expect(ctx.selectedSide).toBe('left')
  })
})
