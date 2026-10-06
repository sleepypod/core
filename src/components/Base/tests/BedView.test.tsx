import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BedViewProps } from '../BedView'

const mock = vi.hoisted(() => ({
  webgl: true,
  three: null as unknown,
  resolve: null as null | ((value: unknown) => void),
  renderer: null as null | { onReady: () => void, onFail: () => void },
}))
vi.mock('../loadThree', () => ({
  hasWebGL: () => mock.webgl,
  loadThree: () => new Promise((resolve) => {
    mock.resolve = resolve
  }),
}))
vi.mock('next/dynamic', () => ({
  default: () => function BedView3D(props: { onReady: () => void, onFail: () => void }) {
    mock.renderer = props
    return <div data-testid="bed-view-3d" />
  },
}))

const { BedView } = await import('../BedView')
const props: BedViewProps = {
  left: { head: 30, feet: 15 },
  right: { head: 1, feet: 5 },
  leftTarget: { head: 30, feet: 15 },
  rightTarget: { head: 40, feet: 0 },
  moving: { left: false, right: true },
  names: { left: 'Jon', right: 'Heidi' },
}

beforeEach(() => {
  mock.webgl = true
  mock.resolve = null
  mock.renderer = null
  localStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BedView', () => {
  it('never flashes the 2D fallback while loading the library or waiting for the first 3D frame', async () => {
    render(<BedView {...props} />)
    expect(screen.queryByTestId('bed-view-2d')).toBeNull()
    expect(screen.getByRole('status', { name: 'Loading bed view' })).toBeTruthy()
    expect(screen.queryByTestId('bed-view-3d')).toBeNull()
    await act(async () => mock.resolve?.({ WebGLRenderer: function WebGLRenderer() {} }))
    expect(screen.getByTestId('bed-view-3d')).toBeTruthy()
    expect(screen.queryByTestId('bed-view-2d')).toBeNull()
    expect(screen.getByRole('status', { name: 'Loading bed view' })).toBeTruthy()
    act(() => mock.renderer?.onReady())
    expect(screen.queryByTestId('bed-view-2d')).toBeNull()
    expect(screen.queryByRole('status', { name: 'Loading bed view' })).toBeNull()
    act(() => mock.renderer?.onFail())
    expect(screen.getByTestId('bed-view-2d')).toBeTruthy()
    expect(screen.queryByTestId('bed-view-3d')).toBeNull()
    expect(screen.queryByRole('status', { name: 'Loading bed view' })).toBeNull()
  })

  it('stays 2D when WebGL is missing or every three.js source fails', async () => {
    mock.webgl = false
    const view = render(<BedView {...props} />)
    await act(async () => {})
    expect(mock.resolve).toBeNull()
    expect(screen.getByTestId('bed-view-2d')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Loading bed view' })).toBeNull()
    view.unmount()
    mock.webgl = true
    render(<BedView {...props} />)
    await act(async () => mock.resolve?.(null))
    expect(screen.queryByTestId('bed-view-3d')).toBeNull()
    expect(screen.getByTestId('bed-view-2d')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Loading bed view' })).toBeNull()
  })

  it('never loads three.js with the simple bed view setting on', async () => {
    localStorage.setItem('sleepypod.base.simpleBedView', 'true')
    render(<BedView {...props} />)
    await act(async () => {})
    expect(mock.resolve).toBeNull()
    expect(screen.getByTestId('bed-view-2d')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Loading bed view' })).toBeNull()
  })

  it('reads out exact angles and motion as text; the drawing is decorative', () => {
    localStorage.setItem('sleepypod.base.simpleBedView', 'true')
    render(<BedView {...props} />)
    expect(screen.getByTestId('bed-readout').textContent).toBe('Jon 30° / 15° · Heidi 1° / 5°')
    expect(screen.getByText('MOVING')).toBeTruthy()
    expect(screen.getByTestId('bed-view-2d').getAttribute('aria-hidden')).toBe('true')
  })

  it('draws the back half and a target ghost only where they apply', () => {
    localStorage.setItem('sleepypod.base.simpleBedView', 'true')
    const view = render(<BedView {...props} />)
    expect(screen.getByTestId('bed-right')).toBeTruthy()
    expect(screen.queryByTestId('ghost-left')).toBeNull()
    expect(screen.getByTestId('ghost-right').getAttribute('stroke-dasharray')).toBe('6 5')
    view.rerender(<BedView {...props} split={false} />)
    expect(screen.queryByTestId('bed-right')).toBeNull()
    expect(screen.getByTestId('bed-readout').textContent).toBe('Jon · Heidi 30° / 15°')
    view.rerender(<BedView {...props} single="right" moving={{}} />)
    expect(screen.getAllByTestId('bed-right')).toHaveLength(1)
    expect(screen.queryByTestId('bed-left')).toBeNull()
    expect(screen.getByTestId('bed-readout').textContent).toBe('Heidi 1° / 5°')
    expect(screen.getByText('IDLE')).toBeTruthy()
  })

  it('draws the focused side in front of the 2D view', () => {
    localStorage.setItem('sleepypod.base.simpleBedView', 'true')
    const front = () => screen.getByTestId('bed-view-2d').lastElementChild?.getAttribute('data-testid')
    const view = render(<BedView {...props} />)
    expect(front()).toBe('bed-left')
    view.rerender(<BedView {...props} focus="right" />)
    expect(front()).toBe('bed-right')
    expect(screen.getByTestId('bed-left')).toBeTruthy()
    view.rerender(<BedView {...props} focus="right" split={false} />)
    expect(front()).toBe('bed-left')
  })

  it('shows placeholders while the position is unavailable', () => {
    render(<BedView {...props} left={null} right={null} />)
    expect(screen.getByTestId('bed-readout').textContent).toBe('Jon — / — · Heidi — / —')
  })
})
