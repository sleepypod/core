'use client'

import { useSyncExternalStore } from 'react'
import { Minus, Plus } from 'lucide-react'
import { useAnimatedPositions } from './useAnimatedPositions'
import { BASE_LIMITS, BASE_PRESETS, BASE_SIDES, scopeSides } from '@/src/hardware/base/types'
import type { BasePosition, BaseScope, BaseSide } from '@/src/hardware/base/types'

export type Angles = Pick<BasePosition, 'head' | 'feet'>
export type Targets = Record<BaseSide, Angles>
export type Names = Record<BaseSide, string>
export const samePosition = (a: Angles, b: Angles) => a.head === b.head && a.feet === b.feet
export const labelStyle = 'font-mono text-[11px] uppercase tracking-[0.12em]'
export const panelStyle = 'flex min-w-0 flex-col gap-4 rounded-xl border border-line bg-surface px-5 py-[18px]'
export const buttonStyle = 'rounded-lg border border-line-2 px-3 py-2 text-sm hover:bg-active disabled:opacity-45'
const memory = new Map<string, string>()
const subscribe = (callback: () => void) => {
  window.addEventListener('storage', callback)
  window.addEventListener('base-preference', callback)
  return () => {
    window.removeEventListener('storage', callback)
    window.removeEventListener('base-preference', callback)
  }
}
export function usePreference<T extends string>(key: string, fallback: T, options: readonly T[]) {
  const storageKey = `sleepypod.base.${key}`
  const value = useSyncExternalStore(subscribe, () => {
    let stored = memory.get(storageKey)
    try {
      stored = localStorage.getItem(storageKey) ?? undefined
    }
    catch { /* Private browsing can deny storage. Keep a session preference. */ }
    return options.includes(stored as T) ? stored as T : fallback
  }, () => fallback)
  const set = (next: T) => {
    memory.set(storageKey, next)
    try {
      localStorage.setItem(storageKey, next)
    }
    catch { /* The in-memory preference still works. */ }
    window.dispatchEvent(new Event('base-preference'))
  }
  return [value, set] as const
}

export function profile(position: Angles) {
  const rad = Math.PI / 180
  const head = { x: 230 - 190 * Math.cos(position.head * rad), y: 170 - 190 * Math.sin(position.head * rad) }
  const knee = { x: 320 + 120 * Math.cos(position.feet * rad), y: 170 - 120 * Math.sin(position.feet * rad) }
  const foot = { x: knee.x + 120 * Math.cos(position.feet * rad * 0.55), y: knee.y + 120 * Math.sin(position.feet * rad * 0.55) }
  return { head, foot, points: `${head.x},${head.y} 230,170 320,170 ${knee.x},${knee.y} ${foot.x},${foot.y}` }
}

interface BedProfileProps { targets: Targets, measured: Targets | null, scope: BaseScope, names: Names, single?: BaseSide }

export function BedProfile(props: BedProfileProps) {
  // A reconnect starts at the first real measurement, never an old cached pose.
  return <AnimatedBedProfile key={props.measured ? 'measured' : 'unavailable'} {...props} />
}

function AnimatedBedProfile({ targets, measured, scope, names, single }: BedProfileProps) {
  const animatedTargets = useAnimatedPositions(targets, 250)
  const animatedMeasured = useAnimatedPositions(measured ?? targets, 1000)
  const selected = scopeSides(scope)
  const shown = single ? [single] : BASE_SIDES
  const equal = measured && samePosition(measured.left, measured.right) && samePosition(animatedMeasured.left, animatedMeasured.right)
  const labels = single ? [single] : equal ? ['left'] as const : BASE_SIDES
  return (
    <div>
      <div className="relative mt-10">
        <svg viewBox="0 0 600 240" role="img" aria-label="Measured base position and selected target" className="block w-full overflow-visible">
          <path d="M70 196 H530 M120 196 V222 M480 196 V222" fill="none" stroke="#26262a" strokeWidth="4" strokeLinecap="round" />
          {shown.filter(side => selected.includes(side)).map(side => <polyline key={`target-${side}`} data-testid={`target-${side}`} points={profile(animatedTargets[side]).points} fill="none" stroke="#1f1f23" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />)}
          {measured && [...shown].sort((a, b) => Number(selected.includes(a)) - Number(selected.includes(b))).map(side => <polyline key={side} data-testid={`measured-${side}`} points={profile(animatedMeasured[side]).points} fill="none" stroke={selected.includes(side) ? '#d8d8dc' : '#3a3a40'} strokeWidth={selected.includes(side) ? 22 : 14} strokeLinecap="round" strokeLinejoin="round" />)}
        </svg>
        {measured && labels.map((side) => {
          const pos = profile(animatedMeasured[side])
          // Nearby head angles need separate label lanes even when feet differ.
          const close = !single && !equal && Math.abs(animatedMeasured.left.head - animatedMeasured.right.head) < 12
          return (
            <span key={side} className="pointer-events-none absolute -translate-y-full max-w-[85%] truncate font-mono text-xs uppercase" style={{ left: `${pos.head.x / 6}%`, top: `calc(${(pos.head.y - 11) / 2.4}% - ${close && side === 'right' ? 30 : 10}px)`, color: selected.includes(side) || equal ? '#ececec' : '#5d5d63' }}>
              {single ? '' : equal ? `${names.left} · ${names.right} ` : `${names[side]} `}
              {measured[side].head}
              °
            </span>
          )
        })}
        {single && measured && (
          <span className="pointer-events-none absolute -translate-x-1/2 -translate-y-full font-mono text-xs" style={{ left: `${profile(animatedMeasured[single]).foot.x / 6}%`, top: `calc(${(profile(animatedMeasured[single]).foot.y - 11) / 2.4}% - 10px)` }}>
            {measured[single].feet}
            °
          </span>
        )}
      </div>
      {!single && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10px] text-fg-2">
          {[['SELECTED', '#d8d8dc'], ['OTHER SIDE', '#3a3a40'], ['TARGET', '#1f1f23']].map(([label, color]) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className="h-1 w-3 rounded" style={{ background: color }} />
              {label}
            </span>
          ))}
          {measured && (
            <span className="ml-auto">
              {names.left[0]}
              {' '}
              {measured.left.head}
              °/
              {measured.left.feet}
              ° ·
              {' '}
              {names.right[0]}
              {' '}
              {measured.right.head}
              °/
              {measured.right.feet}
              °
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function Steppers({ target, onChange, name }: { target: Angles, onChange: (target: Angles) => void, name: string }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-t border-line pt-4 @min-[340px]:grid-cols-2">
      {(['head', 'feet'] as const).map(field => (
        <div key={field} className="flex flex-col items-center gap-2">
          <span className={`${labelStyle} text-fg-2`}>{field}</span>
          <div className="flex items-center gap-1.5">
            <button type="button" aria-label={`Lower ${name} ${field}`} disabled={target[field] <= 0} onClick={() => onChange({ ...target, [field]: target[field] - 1 })} className="flex size-10 shrink-0 items-center justify-center rounded-full bg-active disabled:opacity-45"><Minus size={16} /></button>
            <output aria-label={`${name} ${field} target`} className="min-w-12 text-center font-mono text-[32px] leading-none font-light">
              {target[field]}
              °
            </output>
            <button type="button" aria-label={`Raise ${name} ${field}`} disabled={target[field] >= BASE_LIMITS[field]} onClick={() => onChange({ ...target, [field]: target[field] + 1 })} className="flex size-10 shrink-0 items-center justify-center rounded-full bg-active disabled:opacity-45"><Plus size={16} /></button>
          </div>
        </div>
      ))}
    </div>
  )
}

export function Speed({ value, onChange }: { value: number, onChange: (value: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-fg-2">Speed</span>
      <div className="flex rounded-lg border border-line-2 p-[3px]" role="group" aria-label="Movement speed">
        {[25, 50, 75, 100].map(speed => (
          <button type="button" key={speed} aria-pressed={value === speed} disabled={speed < BASE_LIMITS.minSpeed} title={speed < BASE_LIMITS.minSpeed ? 'This base requires at least 30% speed' : undefined} onClick={() => onChange(speed)} className={`rounded-md px-2 py-1.5 font-mono text-xs disabled:opacity-45 ${value === speed ? 'bg-active text-fg' : 'text-fg-2'}`}>
            {speed}
            %
          </button>
        ))}
      </div>
    </div>
  )
}

export function Presets({ targets, measured, scope, names, onSelect, grid = false }: { targets: Targets, measured: Targets | null, scope: BaseScope, names: Names, onSelect: (value: Angles) => void, grid?: boolean }) {
  const sides = scopeSides(scope)
  return (
    <div className={grid ? 'grid grid-cols-4 gap-1.5' : 'flex flex-col gap-1.5'}>
      {Object.entries(BASE_PRESETS).map(([name, value]) => {
        const selected = sides.every(side => samePosition(targets[side], value))
        const matched = measured ? BASE_SIDES.filter(side => samePosition(measured[side], value)) : []
        const atPreset = sides.every(side => matched.includes(side))
        return (
          <button type="button" key={name} aria-label={`${name} ${value.head}° / ${value.feet}°`} aria-pressed={selected} onClick={() => onSelect(value)} className={`flex min-w-0 items-center gap-2 rounded-[10px] border py-2.5 hover:bg-active ${grid ? 'flex-col px-1' : 'px-3'} ${atPreset ? 'border-[#1f3a2a]' : 'border-line'}`} style={{ outline: selected ? '1px solid #ececec' : undefined, outlineOffset: selected ? -1 : undefined }}>
            <svg viewBox="0 0 600 240" aria-hidden className="h-[18px] w-11 shrink-0"><polyline points={profile(value).points} fill="none" stroke="#b0b0b6" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="text-sm capitalize">{name}</span>
            {!grid && matched.length > 0 && <span className={`${labelStyle} truncate text-[#50c878]`}>{matched.length === 2 ? 'Both' : names[matched[0]]}</span>}
            <span className={`whitespace-nowrap font-mono text-xs text-fg-2 ${grid ? '' : 'ml-auto'}`}>
              {value.head}
              ° /
              {' '}
              {value.feet}
              °
            </span>
          </button>
        )
      })}
    </div>
  )
}
