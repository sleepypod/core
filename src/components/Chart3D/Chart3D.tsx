'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { hasWebGL, loadThree } from '@/src/components/Base/loadThree'
import { markChart3DUnavailable } from './chart3dData'
import { mountChart3DScene } from './chart3dScene'
import type { Chart3DData, Chart3DScene, Chart3DSpec, Chart3DState, ColorResolver } from './chart3dScene'

/** Resolve CSS colours (tokens included) against `host`, as `rgb(r,g,b)`. */
function colorResolver(host: HTMLElement): ColorResolver {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  host.appendChild(probe)
  return (css) => {
    probe.style.color = ''
    probe.style.color = css
    const computed = getComputedStyle(probe).color
    const nums = computed.match(/-?[\d.]+/g)?.map(Number) ?? []
    if (computed.startsWith('color(srgb') && nums.length >= 3) return `rgb(${nums.slice(0, 3).map(v => Math.round(v * 255)).join(',')})`
    if (computed.startsWith('rgb') && nums.length >= 3) return `rgb(${nums.slice(0, 3).map(Math.round).join(',')})`
    return computed || '#888888'
  }
}

interface Chart3DProps {
  /** Lanes and kinds; keep the object stable (module constant or memo) — a new spec remounts. */
  spec: Chart3DSpec
  state: Chart3DState
  /** Memoise: every new object replays or tweens the data. */
  data?: Chart3DData | null
  /** Width / height. The box is the same size in every state. */
  aspect: number
  /** Accessible summary of what the chart shows. */
  label: string
  /** Centred over the chart in the empty and error states. */
  message?: string
  onRetry?: () => void
  className?: string
}

/**
 * A three.js chart in a fixed-aspect box. The loading wave, data sweep, empty
 * baseline and frozen error wave all draw in the same canvas, so nothing shifts
 * when the request settles. When WebGL or three.js fails, every chart switches
 * back to its flat version (see useChartStyle).
 */
export function Chart3D({ spec, state, data, aspect, label, message, onRetry, className }: Chart3DProps) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<Chart3DScene | null>(null)
  const latest = useRef({ state, data })
  useLayoutEffect(() => {
    latest.current = { state, data }
  })

  useEffect(() => {
    let alive = true
    const fail = () => {
      scene.current?.dispose()
      scene.current = null
      if (alive) markChart3DUnavailable()
    }
    const apply = (s: Chart3DScene) => {
      const { state: st, data: d } = latest.current
      if (st === 'ready' && d) s.setData(d)
      else s.setState(st === 'ready' ? 'empty' : st)
    }
    void (async () => {
      if (!hasWebGL()) return fail()
      const three = await loadThree()
      if (!alive) return
      if (!three || !host.current) return fail()
      try {
        scene.current = mountChart3DScene(three, host.current, spec, colorResolver(host.current), fail)
        apply(scene.current)
      }
      catch {
        fail()
      }
    })()
    const recolor = () => scene.current?.recolor()
    const themeObserver = new MutationObserver(recolor)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', recolor)
    return () => {
      alive = false
      themeObserver.disconnect()
      scheme.removeEventListener('change', recolor)
      scene.current?.dispose()
      scene.current = null
    }
  }, [spec])

  useEffect(() => {
    const s = scene.current
    if (!s) return
    if (state === 'ready' && data) s.setData(data)
    else s.setState(state === 'ready' ? 'empty' : state)
  }, [state, data])

  // Ready with nothing to draw is the empty state, as in the scene.
  const overlay = state === 'empty' || state === 'error' || (state === 'ready' && !data)
  return (
    <div className={cn('relative w-full', className)} style={{ aspectRatio: aspect }} role="img" aria-label={label} aria-busy={state === 'loading'}>
      <div ref={host} className="absolute inset-0" />
      {overlay && message && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-[13px]">
          <span className={state === 'error' ? 'text-danger' : 'text-fg-2'}>{message}</span>
          {state === 'error' && onRetry && (
            <button type="button" onClick={onRetry} className="pointer-events-auto cursor-pointer font-mono text-xs text-fg-2 underline underline-offset-2 hover:text-fg">
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  )
}
