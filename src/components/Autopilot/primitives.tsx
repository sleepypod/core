/**
 * Autopilot console primitives — a small, self-contained set ported from the
 * design bundle. Kept local (not the app's src/ui/* primitives) because this is
 * a desktop console surface with its own visual language: a live-swappable
 * accent via the `--accent` CSS var, hairline borders, near-black panels.
 */
'use client'

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './icons'

export function Card({ className = '', children, style }: { className?: string, children: ReactNode, style?: CSSProperties }) {
  return <div className={`rounded-xl border border-zinc-800/80 bg-zinc-900/40 ${className}`} style={style}>{children}</div>
}

type ButtonVariant = 'default' | 'ghost' | 'outline' | 'accent' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'
export function Button({
  variant = 'default', size = 'md', className = '', children, onClick, disabled,
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
}) {
  const sizes: Record<ButtonSize, string> = {
    sm: 'h-7 px-2.5 text-[12px] gap-1',
    md: 'h-9 px-3.5 text-[13px] gap-1.5',
    lg: 'h-10 px-4 text-[14px] gap-2',
  }
  const variants: Record<ButtonVariant, string> = {
    default: 'bg-zinc-800/80 hover:bg-zinc-700/80 text-zinc-100 border border-zinc-700/60',
    ghost: 'bg-transparent hover:bg-zinc-800/60 text-zinc-300',
    outline: 'bg-transparent hover:bg-zinc-800/40 text-zinc-200 border border-zinc-700/70',
    accent: 'text-white border border-transparent',
    danger: 'bg-transparent hover:bg-red-500/10 text-red-400 border border-red-500/30',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={variant === 'accent' ? { background: 'var(--accent)' } : undefined}
      className={`inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none ${sizes[size]} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

type BadgeTone = 'zinc' | 'green' | 'amber' | 'red' | 'accent'
export function Badge({ tone = 'zinc', className = '', children, dot = false }: { tone?: BadgeTone, className?: string, children: ReactNode, dot?: boolean }) {
  const tones: Record<BadgeTone, string> = {
    zinc: 'bg-zinc-800/70 text-zinc-300 border-zinc-700/60',
    green: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
    amber: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
    red: 'bg-red-500/10 text-red-400 border-red-500/25',
    accent: 'border-transparent',
  }
  const style: CSSProperties | undefined = tone === 'accent'
    ? { background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' }
    : undefined
  return (
    <span style={style} className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${tones[tone]} ${className}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />}
      {children}
    </span>
  )
}

export function StatusBadge({ mode }: { mode: 'active' | 'dryrun' | 'paused' }) {
  if (mode === 'active') return <Badge tone="green" dot>Active</Badge>
  if (mode === 'dryrun') return <Badge tone="amber" dot>Dry-run</Badge>
  return <Badge tone="zinc">Paused</Badge>
}

export function SideBadge({ side }: { side: 'left' | 'right' | 'both' | null }) {
  const map = { left: 'L', right: 'R', both: 'L+R' } as const
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-zinc-700/60 bg-zinc-800/50 px-1.5 py-0.5 text-[11px] font-medium text-zinc-300">
      <Icon.Bed size={12} className="text-zinc-500" />
      {map[side ?? 'both']}
    </span>
  )
}

export function Toggle({ checked, onChange, size = 'md', tone = 'accent' }: { checked: boolean, onChange: (v: boolean) => void, size?: 'sm' | 'md', tone?: 'accent' | 'red' }) {
  const dims = size === 'sm' ? { w: 32, h: 18, k: 12 } : { w: 40, h: 22, k: 16 }
  const onBg = tone === 'red' ? '#ef4444' : 'var(--accent)'
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      className="relative shrink-0 rounded-full transition-colors"
      style={{ width: dims.w, height: dims.h, background: checked ? onBg : '#3f3f46' }}
    >
      <span className="absolute top-1/2 rounded-full bg-white transition-all" style={{ width: dims.k, height: dims.k, transform: 'translateY(-50%)', left: checked ? dims.w - dims.k - 3 : 3 }} />
    </button>
  )
}

export interface Option { value: string, label: string, icon?: IconName, hint?: string }
type Opt = string | Option
function norm(o: Opt): Option {
  return typeof o === 'string' ? { value: o, label: o } : o
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T, options: readonly (T | { value: T, label: string })[], onChange: (v: T) => void, size?: 'sm' | 'md' }) {
  const pad = size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3 py-1.5 text-[13px]'
  return (
    <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5">
      {options.map((o) => {
        const val = (typeof o === 'string' ? o : o.value) as T
        const lab = typeof o === 'string' ? o : o.label
        const on = val === value
        return (
          <button
            key={val}
            type="button"
            onClick={() => onChange(val)}
            style={on ? { background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)' } : undefined}
            className={`rounded-md font-medium transition-colors ${pad} ${on ? '' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            {lab}
          </button>
        )
      })}
    </div>
  )
}

export function Select({ value, options, onChange, placeholder = 'Select…', className = '', chip = false }: { value: string, options: Opt[], onChange: (v: string) => void, placeholder?: string, className?: string, chip?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const opts = options.map(norm)
  const cur = opts.find(o => o.value === value)
  const base = chip
    ? 'inline-flex items-center gap-1 rounded-md border border-zinc-700/70 bg-zinc-800/60 px-2 py-1 text-[13px] text-zinc-100 hover:border-zinc-600'
    : 'inline-flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 py-2 text-[13px] text-zinc-100 hover:border-zinc-600'
  return (
    <div ref={ref} className={`relative ${chip ? 'inline-block' : ''} ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={base}
        style={chip ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 10%, transparent)' } : undefined}
      >
        <span className={cur ? '' : 'text-zinc-500'}>{cur ? cur.label : placeholder}</span>
        <Icon.ChevDown size={13} className="opacity-60" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-max min-w-full max-w-[280px] max-h-64 overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-2xl shadow-black/60" style={{ left: 0 }}>
          {opts.map((o) => {
            const I = o.icon ? Icon[o.icon] : null
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-zinc-800 ${o.value === value ? 'text-white' : 'text-zinc-300'}`}
              >
                {I ? <I size={14} className="shrink-0 text-zinc-500" /> : null}
                <span className="flex-1 whitespace-nowrap">{o.label}</span>
                {o.hint && <span className="text-[11px] text-zinc-500 mono">{o.hint}</span>}
                {o.value === value && <Icon.Check size={13} style={{ color: 'var(--accent)' }} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function NumberField({ value, onChange, step = 1, suffix = '', width = 84 }: { value: number, onChange: (v: number) => void, step?: number, suffix?: string, width?: number }) {
  // Draft string keeps the field freely typeable (empty/partial entries) while
  // the numeric value flows up only once it parses; the +/- buttons reuse it.
  // Re-sync the draft during render whenever the external value changes.
  const [draft, setDraft] = useState(String(value))
  const [syncedValue, setSyncedValue] = useState(value)
  if (value !== syncedValue) {
    setSyncedValue(value)
    setDraft(String(value))
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-stretch rounded-lg border border-zinc-700/70 bg-zinc-900/70 overflow-hidden" style={{ width }}>
        <button type="button" onClick={() => onChange(value - step)} className="px-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"><Icon.Minus size={13} /></button>
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            const n = Number(e.target.value)
            if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n)
          }}
          onBlur={() => setDraft(String(value))}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          className="min-w-0 flex-1 bg-transparent px-1 text-center mono text-[13px] text-zinc-100 tabular-nums focus:outline-none"
        />
        <button type="button" onClick={() => onChange(value + step)} className="px-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"><Icon.Plus size={13} /></button>
      </span>
      {suffix && <span className="text-[12px] text-zinc-500">{suffix}</span>}
    </span>
  )
}

export function SectionLabel({ kicker, color, icon, desc, right }: { kicker: string, color: string, icon: IconName, desc?: string, right?: ReactNode }) {
  const I = Icon[icon]
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2.5">
        <span className="grid h-6 w-6 place-items-center rounded-md" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
          {I && <I size={14} />}
        </span>
        <div>
          <div className="text-[12px] font-semibold tracking-[0.14em] uppercase" style={{ color }}>{kicker}</div>
          {desc && <div className="text-[11px] text-zinc-500 -mt-0.5">{desc}</div>}
        </div>
      </div>
      {right}
    </div>
  )
}
