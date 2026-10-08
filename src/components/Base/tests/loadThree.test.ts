import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { THREE_SOURCES, THREE_TIMEOUT_MS, hasWebGL, importThree } from '../loadThree'

const three = { WebGLRenderer: function WebGLRenderer() {} }

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('loadThree', () => {
  it('tries the pinned CDNs before the vendored copy', () => {
    expect(THREE_SOURCES).toEqual([
      'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js',
      'https://unpkg.com/three@0.170.0/build/three.module.min.js',
      '/vendor/three.module.min.js',
    ])
  })

  it('falls through failed and non-three sources in order', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ default: 'not three' })
      .mockResolvedValueOnce(three)
    await expect(importThree(load)).resolves.toBe(three)
    expect(load.mock.calls.map(([url]) => url)).toEqual([...THREE_SOURCES])
  })

  it('gives each source 4 s before moving on, and resolves null when all fail', async () => {
    vi.useFakeTimers()
    const load = vi.fn((url: string) => url.startsWith('/') ? Promise.reject(new Error('404')) : new Promise(() => {}))
    const result = importThree(load)
    await vi.advanceTimersByTimeAsync(THREE_TIMEOUT_MS - 1)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(THREE_TIMEOUT_MS * 2)
    await expect(result).resolves.toBeNull()
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('reports WebGL only when a context can be created', () => {
    expect(hasWebGL()).toBe(false)
    vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {})
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(hasWebGL()).toBe(false)
    getContext.mockImplementation(((kind: string) => kind === 'webgl' ? {} : null) as never)
    expect(hasWebGL()).toBe(true)
    getContext.mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(hasWebGL()).toBe(false)
    getContext.mockRestore()
  })

  it('ships a vendored copy that matches the pinned version', () => {
    const vendored = readFileSync(join(process.cwd(), 'public/vendor/three.module.min.js'), 'utf8')
    expect(vendored.slice(0, 400)).toContain('const t="170"')
  })
})
