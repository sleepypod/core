import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BedProfile, profile } from '../controls'
import type { Targets } from '../controls'

const flat: Targets = { left: { head: 0, feet: 0 }, right: { head: 0, feet: 0 } }
const raised: Targets = { left: { head: 40, feet: 20 }, right: { head: 20, feet: 10 } }
const names = { left: 'Jon', right: 'Heidi' }
let now = 0
let nextId = 0
let reduced = false
const frames = new Map<number, FrameRequestCallback>()
const advance = (time: number) => act(() => {
  now = time
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach(callback => callback(now))
})
const bed = (measured: Targets | null, targets = flat) => <BedProfile targets={targets} measured={measured} scope="both" names={names} single="left" />
const points = () => screen.getByTestId('measured-left').getAttribute('points')

beforeEach(() => {
  now = 0
  nextId = 0
  reduced = false
  frames.clear()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() {
      return reduced
    },
  })))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('animated bed profile', () => {
  it('starts at the measured pose without animating from flat', () => {
    render(bed(raised))
    expect(points()).toBe(profile(raised.left).points)
    expect(frames.size).toBe(0)
  })

  it('interpolates the bed and label position while keeping measured numbers exact', () => {
    const view = render(bed(flat))
    view.rerender(bed(raised))
    expect(points()).toBe(profile(flat.left).points)
    const label = screen.getByText('40°')
    const initialTop = label.style.top
    advance(500)
    expect(points()).toBe(profile({ head: 20, feet: 10 }).points)
    expect(label.style.top).not.toBe(initialTop)
    expect(label.textContent).toBe('40°')
    advance(1000)
    expect(points()).toBe(profile(raised.left).points)
    expect(frames.size).toBe(0)
  })

  it('continues from the displayed pose when a new measurement interrupts motion', () => {
    const view = render(bed(flat))
    view.rerender(bed(raised))
    advance(500)
    const midway = points()
    view.rerender(bed(flat))
    expect(points()).toBe(midway)
    advance(1000)
    expect(points()).toBe(profile({ head: 10, feet: 5 }).points)
    advance(1500)
    expect(points()).toBe(profile(flat.left).points)
  })

  it('does not restart motion when an identical status arrives in a new object', () => {
    const view = render(bed(flat))
    view.rerender(bed(raised))
    advance(500)
    view.rerender(bed({ left: { ...raised.left }, right: { ...raised.right } }))
    advance(1000)
    expect(points()).toBe(profile(raised.left).points)
    expect(frames.size).toBe(0)
  })

  it('animates target previews independently without moving the measured bed', () => {
    const view = render(bed(flat))
    view.rerender(bed(flat, raised))
    advance(125)
    expect(screen.getByTestId('target-left').getAttribute('points')).toBe(profile({ head: 20, feet: 10 }).points)
    expect(points()).toBe(profile(flat.left).points)
    advance(250)
    expect(screen.getByTestId('target-left').getAttribute('points')).toBe(profile(raised.left).points)
  })

  it('respects reduced motion, including changes during an animation', () => {
    const view = render(bed(flat))
    view.rerender(bed(raised))
    advance(100)
    reduced = true
    advance(116)
    expect(points()).toBe(profile(raised.left).points)
    expect(frames.size).toBe(0)
    view.rerender(bed(flat))
    advance(132)
    expect(points()).toBe(profile(flat.left).points)
    expect(frames.size).toBe(0)
  })

  it('cancels frames on disconnect and reconnects at the new measured pose', () => {
    const view = render(bed(flat))
    view.rerender(bed(raised))
    advance(500)
    view.rerender(bed(null))
    expect(screen.queryByTestId('measured-left')).toBeNull()
    expect(frames.size).toBe(0)
    view.rerender(bed(raised))
    expect(points()).toBe(profile(raised.left).points)
    view.rerender(bed(flat))
    expect(frames.size).toBe(1)
    view.unmount()
    expect(frames.size).toBe(0)
  })
})
