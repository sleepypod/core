/**
 * StageTimeline scrubbing: a primary press or a held drag previews the hour under the
 * pointer, a secondary click or a hover does not, and an empty lane says so once the
 * schedules have loaded.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StageTimeline } from '../StageTimeline'
import { stageCurves, stageWindow } from '../stageTimelineLogic'

const NOW = new Date(2026, 8, 28, 21, 0)
const win = stageWindow(NOW)
const empty = stageCurves({ left: [], right: [] }, win)
const names = { left: 'Jon', right: 'Heidi' }

let rect = { left: 0, top: 0, width: 1000, height: 84, right: 1000, bottom: 84, x: 0, y: 0, toJSON: () => ({}) }

beforeEach(() => {
  rect = { ...rect, width: 1000 }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const timeline = (props: { loading?: boolean, onScrub?: (t: number) => void } = {}) => render(
  <StageTimeline win={win} now={NOW.getTime()} curves={empty} names={names} unit="F" display="degrees" previewAt={null} onScrub={props.onScrub ?? vi.fn()} loading={props.loading} />,
)

describe('StageTimeline', () => {
  it('previews on a primary press and while dragging, not on a secondary click or a hover', () => {
    const onScrub = vi.fn()
    timeline({ onScrub })
    const lane = screen.getByTestId('stage-lane')
    fireEvent.pointerDown(lane, { clientX: 0, button: 2, pointerType: 'mouse', pointerId: 1 })
    fireEvent.pointerMove(lane, { clientX: 500, buttons: 0, pointerId: 1 })
    expect(onScrub).not.toHaveBeenCalled()
    fireEvent.pointerDown(lane, { clientX: 0, button: 0, pointerType: 'touch', pointerId: 1 })
    expect(onScrub).toHaveBeenLastCalledWith(win.start)
    fireEvent.pointerMove(lane, { clientX: 1000, buttons: 1, pointerId: 1 })
    expect(onScrub).toHaveBeenLastCalledWith(win.end)
    expect(onScrub).toHaveBeenCalledTimes(2)
  })

  it('ignores a scrub on a lane that has no width yet', () => {
    const onScrub = vi.fn()
    rect = { ...rect, width: 0 }
    timeline({ onScrub })
    fireEvent.pointerDown(screen.getByTestId('stage-lane'), { clientX: 10, button: 0, pointerType: 'mouse', pointerId: 1 })
    expect(onScrub).not.toHaveBeenCalled()
  })

  it('says there is no schedule only once loading has finished', () => {
    timeline({ loading: true })
    expect(screen.queryByText('no schedule')).toBeNull()
    expect(screen.queryByTestId('stage-next')).toBeNull()
    cleanup()
    timeline()
    expect(screen.getByText('no schedule')).toBeTruthy()
  })
})
