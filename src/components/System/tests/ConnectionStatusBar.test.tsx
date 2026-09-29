import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionStatusBar } from '@/src/components/Sensors/ConnectionStatusBar'

const base = {
  status: 'connected' as const,
  fps: 12,
  lastError: null,
  sensorCount: 6,
  lastFrameTime: Date.now(),
  paused: false,
  onToggle: () => {},
}

describe('ConnectionStatusBar', () => {
  it('waits for measurements and becomes stale when measurements stop despite an open socket', () => {
    vi.useFakeTimers()
    try {
      const { rerender, unmount } = render(<ConnectionStatusBar {...base} lastFrameTime={null} />)
      expect(screen.getByTestId('stream-status').textContent).toContain('WAITING')
      rerender(<ConnectionStatusBar {...base} lastFrameTime={Date.now()} />)
      expect(screen.getByTestId('stream-status').textContent).toContain('LIVE')
      act(() => vi.advanceTimersByTime(11_000))
      expect(screen.getByTestId('stream-status').textContent).toContain('STALE')
      unmount()
    }
    finally { vi.useRealTimers() }
  })

  it('shows elapsed minutes for a stale measurement and clamps small clock skew', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(200_000)
      const { rerender, unmount } = render(<ConnectionStatusBar {...base} lastFrameTime={100_000} />)
      expect(screen.getByText('sensor age 1m')).toBeTruthy()
      expect(screen.getByTestId('stream-status').textContent).toContain('STALE')
      rerender(<ConnectionStatusBar {...base} lastFrameTime={201_000} />)
      expect(screen.getByText('sensor age 0.0s')).toBeTruthy()
      expect(screen.getByTestId('stream-status').textContent).toContain('LIVE')
      unmount()
    }
    finally { vi.useRealTimers() }
  })

  it('labels each connection state', () => {
    const { rerender } = render(<ConnectionStatusBar {...base} />)
    expect(screen.getByTestId('stream-status').textContent).toContain('LIVE')
    rerender(<ConnectionStatusBar {...base} status="connecting" />)
    expect(screen.getByTestId('stream-status').textContent).toBe('CONNECTING')
    rerender(<ConnectionStatusBar {...base} status="reconnecting" />)
    expect(screen.getByTestId('stream-status').textContent).toBe('RECONNECTING')
    rerender(<ConnectionStatusBar {...base} status="disconnected" lastError="boom" />)
    expect(screen.getByTestId('stream-status').textContent).toBe('OFFLINE')
    expect(screen.getByTitle('boom')).toBeTruthy()
  })

  it('shows fps and sensor count only while connected', () => {
    const { rerender } = render(<ConnectionStatusBar {...base} />)
    expect(screen.getByText('12 fps')).toBeTruthy()
    expect(screen.getByText('6 sensors')).toBeTruthy()
    rerender(<ConnectionStatusBar {...base} status="connecting" />)
    expect(screen.queryByText('12 fps')).toBeNull()
  })

  it('switches to PAUSED with a Start button when paused', () => {
    const onToggle = vi.fn()
    render(<ConnectionStatusBar {...base} paused onToggle={onToggle} />)
    expect(screen.getByTestId('stream-status').textContent).toBe('PAUSED')
    expect(screen.queryByText('12 fps')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
