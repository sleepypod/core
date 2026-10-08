import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CircleCheck } from 'lucide-react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOAST_ANIMATION_MS, TOAST_DURATION_MS, ToastProvider, useToast, type ToastNotice } from '../toast'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const handle: { show: (notice: ToastNotice) => void } = { show: () => {} }
function Grab() {
  const { show } = useToast()
  useEffect(() => {
    handle.show = show
  }, [show])
  return null
}
const show = (notice: ToastNotice) => handle.show(notice)

const toast = (id: string, title = id): ToastNotice => ({ id, kind: 'success', tone: 'ok', icon: CircleCheck, title })
const visible = () => screen.queryByTestId('toast')?.getAttribute('data-toast') ?? null
const advance = (ms: number) => act(() => {
  vi.advanceTimersByTime(ms)
})

function setup() {
  render(<ToastProvider><Grab /></ToastProvider>)
}

describe('ToastProvider', () => {
  it('announces through one polite status region and does nothing outside a provider', () => {
    setup()
    const region = screen.getByTestId('toast-region')
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    cleanup()
    handle.show = () => {}
    render(<Grab />)
    expect(() => show(toast('a'))).not.toThrow()
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('shows one toast at a time; the next waits until the first one ends', () => {
    setup()
    act(() => {
      show(toast('a'))
      show(toast('b'))
    })
    expect(visible()).toBe('a')
    advance(TOAST_DURATION_MS - 1)
    expect(visible()).toBe('a')
    advance(1)
    expect(screen.getByTestId('toast').dataset.leaving).toBe('true')
    advance(TOAST_ANIMATION_MS)
    expect(visible()).toBe('b')
    advance(TOAST_DURATION_MS)
    advance(TOAST_ANIMATION_MS)
    expect(visible()).toBeNull()
  })

  it('replaces the visible toast when the same id is shown again, restarting its time', () => {
    setup()
    act(() => show(toast('a', 'First')))
    advance(3000)
    act(() => show(toast('a', 'Second')))
    expect(screen.getByTestId('toast').textContent).toContain('Second')
    expect(screen.queryByText('First')).toBeNull()
    advance(3000)
    expect(visible()).toBe('a')
    advance(1000)
    advance(TOAST_ANIMATION_MS)
    expect(visible()).toBeNull()
  })

  it('pauses the countdown while hovered or focused', () => {
    setup()
    act(() => show(toast('a')))
    advance(1000)
    fireEvent.mouseEnter(screen.getByTestId('toast'))
    expect(screen.getByTestId('toast-countdown').style.animationPlayState).toBe('paused')
    advance(10_000)
    expect(visible()).toBe('a')
    fireEvent.mouseLeave(screen.getByTestId('toast'))
    expect(screen.getByTestId('toast-countdown').style.animationPlayState).toBe('running')
    advance(TOAST_DURATION_MS - 1000 - 1)
    expect(screen.getByTestId('toast').dataset.leaving).toBeUndefined()
    fireEvent.focus(screen.getByTestId('toast'))
    advance(10_000)
    expect(screen.getByTestId('toast').dataset.leaving).toBeUndefined()
    fireEvent.blur(screen.getByTestId('toast'))
    advance(1)
    advance(TOAST_ANIMATION_MS)
    expect(visible()).toBeNull()
  })
})
