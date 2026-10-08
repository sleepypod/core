import { describe, expect, it } from 'vitest'
import { CAMERA, DEFAULT_CAMERA, cameraGoal, cameraPose, clampDistance, easeCamera, nightLight, spreadRows, viewOffset, viewScale } from '../stageCamera'

describe('camera goals', () => {
  it('has a home view, a closer view per side and a wider linked view, all sliding the bed left of the panel', () => {
    expect(cameraGoal(null, false)).toEqual(DEFAULT_CAMERA)
    expect(cameraGoal(null, true)).toEqual(DEFAULT_CAMERA)
    expect(cameraGoal('left', false)).toMatchObject({ phi: 0.35, r: 6.8, h: 2.8, oz: 0.35, lateral: 1.05 })
    expect(cameraGoal('right', false)).toMatchObject({ phi: 2.75, r: 6.8, h: 2.8, oz: -0.35, lateral: 1.05 })
    expect(cameraGoal('left', true)).toMatchObject({ phi: 0.62, r: 8, h: 3.3, lateral: 1.05 })
  })
  it('returns fresh objects so a drag never edits the shared default', () => {
    const goal = cameraGoal(null, false)
    goal.phi = 9
    expect(DEFAULT_CAMERA.phi).toBe(0.62)
  })
})

describe('easing', () => {
  it('moves 7% per frame and reports when it has arrived', () => {
    const current = { ...DEFAULT_CAMERA }
    const goal = cameraGoal('left', false)
    expect(easeCamera(current, goal)).toBe(true)
    expect(current.r).toBeCloseTo(9.5 + (6.8 - 9.5) * CAMERA.ease)
    let frames = 1
    while (easeCamera(current, goal) && frames < 500) frames++
    expect(frames).toBeLessThan(200)
    expect(current).toEqual(goal)
  })
  it('snaps with reduced motion', () => {
    const current = { ...DEFAULT_CAMERA }
    expect(easeCamera(current, cameraGoal('right', false), true)).toBe(false)
    expect(current).toEqual(cameraGoal('right', false))
  })
})

describe('pose', () => {
  it('orbits around the look target at the given height and distance', () => {
    const pose = cameraPose(DEFAULT_CAMERA)
    expect(pose.target).toEqual([0, CAMERA.lookY, 0])
    expect(Math.hypot(pose.position[0], pose.position[2])).toBeCloseTo(9.5)
    expect(pose.position[1]).toBe(3.9)
  })
  it('takes each side close-up from that sleeper\'s side of the bed', () => {
    expect(cameraPose(cameraGoal('left', false)).position[2]).toBeGreaterThan(0)
    expect(cameraPose(cameraGoal('right', false)).position[2]).toBeLessThan(0)
  })
  it('slides the look target along the camera right so the bed moves left on screen', () => {
    const pose = cameraPose({ ...DEFAULT_CAMERA, phi: 0, lateral: 1 })
    // At phi = 0 the camera sits on +z looking toward −z; its right is +x.
    expect(pose.target[0]).toBeCloseTo(1)
    expect(pose.target[2]).toBeCloseTo(0)
  })
  it('eases the azimuth the short way round', () => {
    const current = { ...DEFAULT_CAMERA, phi: 0.1 }
    easeCamera(current, { ...DEFAULT_CAMERA, phi: 2 * Math.PI - 0.1 })
    expect(current.phi).toBeLessThan(0.1)
  })
  it('scales distance and height together for the viewport', () => {
    const pose = cameraPose(DEFAULT_CAMERA, 1.2)
    expect(Math.hypot(pose.position[0], pose.position[2])).toBeCloseTo(9.5 * 1.2)
    expect(pose.position[1]).toBeCloseTo(3.9 * 1.2)
  })
})

describe('viewport fit', () => {
  it('pulls back on short bands and tall viewports, never closer than 1', () => {
    expect(viewScale(1600, 1000)).toBe(1.45)
    expect(viewScale(2400, 1500)).toBeCloseTo(1500 / 1120)
    expect(viewScale(800, 1200)).toBeCloseTo(1.45 * 1.3)
    expect(viewScale(2000, 2000)).toBeCloseTo(1.2346 * 1.3, 3)
    expect(viewScale(0, 0)).toBe(1)
  })
  it('centres the bed in the band, never counting the band shorter than 200px', () => {
    expect(viewOffset(1000)).toEqual({ x: 0, y: 40 })
    expect(viewOffset(500)).toEqual({ x: 0, y: 0 })
    expect(viewScale(800, 500)).toBeCloseTo(1.45)
  })
  it('dims the room in the small hours and warms it toward dawn', () => {
    expect(nightLight(null)).toEqual({ key: 1, hemisphere: 1, warmth: 0 })
    expect(nightLight(2.5).key).toBeCloseTo(0.4)
    expect(nightLight(21).key).toBeGreaterThan(0.9)
    expect(nightLight(21).warmth).toBe(0)
    expect(nightLight(8).warmth).toBeGreaterThan(0.7)
  })
  it('keeps zoom inside 5..13', () => {
    expect(clampDistance(1)).toBe(5)
    expect(clampDistance(30)).toBe(13)
    expect(clampDistance(9)).toBe(9)
  })
})

describe('spreadRows', () => {
  it('pushes crowded rows apart in rank order and leaves spaced rows alone', () => {
    expect(spreadRows([100, 104, 101, 300, 160, 165], 14)).toEqual([100, 128, 114, 300, 160, 174])
    expect(spreadRows([10, 50, 90], 14)).toEqual([10, 50, 90])
    expect(spreadRows([], 14)).toEqual([])
  })
})
