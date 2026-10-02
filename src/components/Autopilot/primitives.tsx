/**
 * Autopilot console primitives — thin adapters over the design-system
 * primitives (`@/src/components/ds`) that keep the console's existing call
 * APIs. Everything is token-driven so light and dark themes both work.
 */
'use client'

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button as DsButton, SegmentedControl, Toggle as DsToggle } from '@/src/components/ds'
import { Icon, type IconName } from './icons'

export function Card({ className = '', children, style }: { className?: string, children: ReactNode, style?: CSSProperties }) {
  return <div className={cn('min-w-0 rounded-card border border-line bg-surface', className)} style={style}>{children}</div>
}

type ButtonVariant = 'default' | 'ghost' | 'outline' | 'accent' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'
const DS_VARIANT = {
  default: 'secondary',
  ghost: 'ghost',
  outline: 'secondary',
  accent: 'primary',
  danger: 'danger',
} as const
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
  return (
    <DsButton
      variant={DS_VARIANT[variant]}
      size={size === 'sm' ? 'sm' : 'md'}
      onClick={onClick}
      disabled={disabled}
      className={cn(size === 'lg' && 'px-4 py-2.5 text-sm', className)}
    >
      {children}
    </DsButton>
  )
}

type BadgeTone = 'zinc' | 'green' | 'amber' | 'red' | 'accent'
const BADGE_TONES: Record<BadgeTone, string> = {
  zinc: 'border-line-2 text-fg-2',
  green: 'border-ok-line text-ok',
  amber: 'border-warn-line text-warn',
  red: 'border-danger-line text-danger',
  accent: 'text-cool',
}
export function Badge({ tone = 'zinc', className = '', children, dot = false }: { tone?: BadgeTone, className?: string, children: ReactNode, dot?: boolean }) {
  const style: CSSProperties | undefined = tone === 'accent'
    ? { borderColor: 'color-mix(in srgb, var(--accent-cool) 35%, transparent)' }
    : undefined
  return (
    <span style={style} className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[11px] leading-[14px] tracking-[0.06em]', BADGE_TONES[tone], className)}>
      {dot && <span className="size-[5px] rounded-full bg-current" />}
      {children}
    </span>
  )
}

export function StatusBadge({ mode }: { mode: 'active' | 'dryrun' | 'paused' }) {
  if (mode === 'active') return <Badge tone="green" dot>ACTIVE</Badge>
  if (mode === 'dryrun') return <Badge tone="amber" dot>DRY-RUN</Badge>
  return <Badge tone="zinc">PAUSED</Badge>
}

export function SideBadge({ side }: { side: 'left' | 'right' | 'both' | null }) {
  const map = { left: 'L', right: 'R', both: 'L+R' } as const
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-tag border border-line-2 px-1.5 py-0.5 font-mono text-[11px] leading-[14px] text-fg-2">
      <Icon.Bed size={12} className="text-fg-3" />
      {map[side ?? 'both']}
    </span>
  )
}

export function Toggle({ checked, onChange, size = 'md', label }: { checked: boolean, onChange: (v: boolean) => void, size?: 'sm' | 'md', tone?: 'accent' | 'red', label?: string }) {
  return <DsToggle on={checked} onChange={onChange} size={size} label={label} />
}

export interface Option { value: string, label: string, icon?: IconName, hint?: string }
type Opt = string | Option
function norm(o: Opt): Option {
  return typeof o === 'string' ? { value: o, label: o } : o
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T, options: readonly (T | { value: T, label: string })[], onChange: (v: T) => void, size?: 'sm' | 'md' }) {
  return <SegmentedControl value={value} options={options} onChange={onChange} size={size} className="self-start" />
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
    ? 'inline-flex items-center gap-1 rounded-ctl border border-line-2 bg-transparent px-2 py-1 text-[13px] text-cool hover:bg-active'
    : 'inline-flex w-full items-center justify-between gap-2 rounded-ctl border border-line-2 bg-field px-3 py-2 text-[13px] text-fg hover:bg-active'
  return (
    <div ref={ref} className={cn('relative', chip && 'inline-block', className)}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={base}
      >
        <span className={cur ? '' : 'text-fg-3'}>{cur ? cur.label : placeholder}</span>
        <Icon.ChevDown size={13} className="text-fg-2" />
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1 max-h-64 w-max min-w-full max-w-[280px] overflow-auto rounded-ctl border border-line-2 bg-surface p-1 shadow-[var(--shadow-dialog)]">
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
                className={cn('flex w-full items-center gap-2 rounded-thumb px-2.5 py-1.5 text-left text-[13px] hover:bg-active', o.value === value ? 'text-fg' : 'text-fg-2')}
              >
                {I ? <I size={14} className="shrink-0 text-fg-3" /> : null}
                <span className="flex-1 whitespace-nowrap">{o.label}</span>
                {o.hint && <span className="font-mono text-[11px] text-fg-3">{o.hint}</span>}
                {o.value === value && <Icon.Check size={13} className="text-cool" />}
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

  // Reset the draft when stepping so stale text can't survive a parent that
  // clamps back to the same numeric value (no render-time re-sync fires then).
  const applyStep = (delta: number) => {
    setDraft(String(value))
    onChange(value + delta)
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-stretch overflow-hidden rounded-ctl border border-line-2 bg-field" style={{ width }}>
        <button type="button" aria-label="Decrease" onClick={() => applyStep(-step)} className="px-1.5 text-fg-2 hover:bg-active hover:text-fg"><Icon.Minus size={13} /></button>
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
          className="min-w-0 flex-1 bg-transparent px-1 py-1 text-center font-mono text-[13px] tabular-nums text-fg focus:outline-none"
        />
        <button type="button" aria-label="Increase" onClick={() => applyStep(step)} className="px-1.5 text-fg-2 hover:bg-active hover:text-fg"><Icon.Plus size={13} /></button>
      </span>
      {suffix && <span className="text-[12px] text-fg-3">{suffix}</span>}
    </span>
  )
}

export function SectionLabel({ kicker, color, icon, desc, right }: { kicker: string, color: string, icon: IconName, desc?: string, right?: ReactNode }) {
  const I = Icon[icon]
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-thumb border border-line-2" style={{ color }}>
          {I && <I size={14} />}
        </span>
        <div className="min-w-0">
          <div className="sp-label" style={{ color }}>{kicker}</div>
          {desc && <div className="text-[12px] text-fg-3">{desc}</div>}
        </div>
      </div>
      {right}
    </div>
  )
}
