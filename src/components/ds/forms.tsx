'use client'

import { ChevronDown, Minus, Plus } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* ─── Toggle ─────────────────────────────────────────────────────────────
   Green track when on. Only the knob animates (150ms standard ease). */
export function Toggle({ on, onChange, size = 'sm', label, disabled, className }: {
  on: boolean
  onChange?: (next: boolean) => void
  size?: 'sm' | 'md'
  label?: string
  disabled?: boolean
  className?: string
}) {
  const md = size === 'md'
  const w = md ? 36 : 30
  const h = md ? 22 : 18
  const k = md ? 16 : 14
  const p = (h - k) / 2
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
      className={cn('relative shrink-0 cursor-pointer border-0 p-0 disabled:cursor-default disabled:opacity-45', className)}
      style={{ width: w, height: h, borderRadius: h / 2, background: on ? 'var(--status-ok)' : 'var(--toggle-off-track)' }}
    >
      <span
        className="absolute rounded-full transition-[left] duration-150 ease-standard"
        style={{
          top: p,
          left: on ? w - k - p : p,
          width: k,
          height: k,
          background: on ? 'var(--toggle-on-knob)' : 'var(--toggle-off-knob)',
        }}
      />
    </button>
  )
}

/* ─── SegmentedControl ───────────────────────────────────────────────── */
export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

export function SegmentedControl<T extends string>({ options, value, onChange, full, size = 'md', className, ariaLabel }: {
  options: ReadonlyArray<SegmentOption<T> | T>
  value: T
  onChange?: (v: T) => void
  full?: boolean
  size?: 'sm' | 'md'
  className?: string
  ariaLabel?: string
}) {
  const opts = options.map(o => (typeof o === 'string' ? { value: o, label: o } : o)) as SegmentOption<T>[]
  const fs = size === 'sm' ? 'text-xs' : full ? 'text-sm' : 'text-[13px]'
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'shrink-0 border border-line',
        full ? 'grid rounded-card p-1' : 'flex rounded-seg p-[3px]',
        fs,
        className,
      )}
      style={full ? { gridTemplateColumns: `repeat(${opts.length}, minmax(0, 1fr))` } : undefined}
    >
      {opts.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            disabled={o.disabled}
            onClick={() => onChange?.(o.value)}
            className={cn(
              'flex min-w-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap border-0 transition-colors disabled:cursor-default disabled:opacity-45',
              full ? 'rounded-seg py-[9px]' : 'rounded-thumb px-3 py-[5px]',
              on ? 'bg-active text-fg' : 'bg-transparent text-fg-2 hover:text-fg',
              on && full && 'font-medium',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/* ─── SelectValue ─────────────────────────────────────────────────────────
   A native <select> dressed as the mono value chip. */
export function SelectValue<T extends string | number>({ value, options, onChange, label, className, disabled }: {
  value: T
  options: ReadonlyArray<{ value: T, label: ReactNode }>
  onChange?: (v: T) => void
  label?: string
  className?: string
  disabled?: boolean
}) {
  return (
    <span className={cn('relative inline-flex shrink-0 items-center', className)}>
      <select
        aria-label={label}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value
          const match = options.find(o => String(o.value) === raw)
          if (match) onChange?.(match.value)
        }}
        className="cursor-pointer appearance-none rounded-ctl border border-line-2 bg-transparent py-1.5 pl-2.5 pr-7 font-mono text-[13px] text-fg outline-none disabled:cursor-default disabled:opacity-45"
      >
        {options.map(o => (
          <option key={String(o.value)} value={String(o.value)}>
            {typeof o.label === 'string' || typeof o.label === 'number' ? o.label : String(o.value)}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2 text-fg-2" />
    </span>
  )
}

/** Read-only chip that looks like SelectValue — for buttons that open a picker. */
export function ValueChip({ children, chevron = true, className, ...props }: ComponentProps<'button'> & { chevron?: boolean }) {
  return (
    <button
      type="button"
      className={cn('inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-ctl border border-line-2 bg-transparent px-2.5 py-1.5 font-mono text-[13px] text-fg', className)}
      {...props}
    >
      {children}
      {chevron && <ChevronDown size={14} className="text-fg-2" />}
    </button>
  )
}

/* ─── TextField ──────────────────────────────────────────────────────── */
export interface TextFieldProps extends Omit<ComponentProps<'input'>, 'onChange'> {
  label?: ReactNode
  mono?: boolean
  onChange?: (value: string) => void
  hint?: ReactNode
}

export function TextField({ label, mono = true, onChange, hint, className, readOnly, ...props }: TextFieldProps) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label && <span className="text-xs text-fg-2">{label}</span>}
      <input
        {...props}
        readOnly={readOnly ?? !onChange}
        onChange={e => onChange?.(e.target.value)}
        className={cn(
          'min-w-0 rounded-ctl border border-line-2 bg-field px-3 py-[9px] text-fg outline-none placeholder:text-fg-3 focus:border-fg-3 disabled:opacity-45',
          mono ? 'font-mono text-[13px]' : 'font-sans text-sm',
        )}
      />
      {hint && <span className="text-xs text-fg-2">{hint}</span>}
    </label>
  )
}

/* ─── Slider ─────────────────────────────────────────────────────────── */
export function Slider({ value, onChange, onCommit, min = 0, max = 100, step = 1, label, disabled, className }: {
  value: number
  onChange?: (v: number) => void
  /** Fires on pointer/key release — use for expensive writes. */
  onCommit?: (v: number) => void
  min?: number
  max?: number
  step?: number
  label?: string
  disabled?: boolean
  className?: string
}) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100
  return (
    <div data-no-swipe className={cn('relative h-[18px] min-w-20 flex-1', disabled && 'opacity-45', className)}>
      <div className="absolute inset-x-0 top-[7px] h-1 rounded-sm bg-line-2" />
      <div className="absolute left-0 top-[7px] h-1 rounded-sm bg-fg" style={{ width: `${pct}%` }} />
      <div
        className="absolute top-0 box-border size-[18px] rounded-full border-[3px] border-surface bg-fg"
        style={{ left: `calc(${pct}% - 9px)` }}
      />
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={e => onChange?.(Number(e.target.value))}
        onPointerUp={e => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={e => onCommit?.(Number((e.target as HTMLInputElement).value))}
        className="absolute inset-0 m-0 !min-h-0 w-full cursor-pointer opacity-0"
      />
    </div>
  )
}

/* ─── Stepper ────────────────────────────────────────────────────────── */
export function Stepper({ value, onChange, step = 1, min = 55, max = 110, format, label, disabled, className }: {
  value: number
  onChange?: (v: number) => void
  step?: number
  min?: number
  max?: number
  format?: (v: number) => ReactNode
  label?: string
  disabled?: boolean
  className?: string
}) {
  const fmt = format ?? ((v: number) => `${v}°`)
  const btn = 'flex size-8 cursor-pointer items-center justify-center border-0 bg-transparent text-fg-2 hover:text-fg disabled:cursor-default disabled:opacity-45'
  return (
    <div className={cn('flex shrink-0 items-center rounded-ctl border border-line-2', className)} aria-label={label} role="group">
      <button type="button" aria-label={label ? `Decrease ${label}` : 'Decrease'} className={btn} disabled={disabled || value <= min} onClick={() => onChange?.(Math.max(min, value - step))}>
        <Minus size={14} />
      </button>
      <span className="min-w-10 text-center font-mono text-sm">{fmt(value)}</span>
      <button type="button" aria-label={label ? `Increase ${label}` : 'Increase'} className={btn} disabled={disabled || value >= max} onClick={() => onChange?.(Math.min(max, value + step))}>
        <Plus size={14} />
      </button>
    </div>
  )
}

/* ─── DayPicker ──────────────────────────────────────────────────────────
   Values are day indexes 0..6 in the order given by `days` (default Mon-first). */
const DEFAULT_DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export function DayPicker({ value, onChange, days = DEFAULT_DAYS, labels, className }: {
  value: number[]
  onChange?: (v: number[]) => void
  days?: string[]
  /** Accessible names for each day. */
  labels?: string[]
  className?: string
}) {
  const toggle = (i: number) =>
    onChange?.(value.includes(i) ? value.filter(d => d !== i) : [...value, i].sort((a, b) => a - b))
  return (
    <div className={cn('grid grid-cols-7 gap-1.5', className)}>
      {days.map((d, i) => {
        const on = value.includes(i)
        return (
          <button
            key={i}
            type="button"
            aria-pressed={on}
            aria-label={labels?.[i]}
            onClick={() => toggle(i)}
            className={cn(
              'flex h-[38px] cursor-pointer items-center justify-center rounded-ctl border text-[13px] transition-colors',
              on ? 'border-transparent bg-fg font-medium text-inverse' : 'border-line-2 bg-transparent text-fg-2 hover:bg-active',
            )}
          >
            {d}
          </button>
        )
      })}
    </div>
  )
}

/* ─── Pill ───────────────────────────────────────────────────────────── */
export function Pill({ selected, className, children, ...props }: ComponentProps<'button'> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={!!selected}
      className={cn(
        'cursor-pointer whitespace-nowrap rounded-full border bg-transparent px-3 py-1.5 text-[13px] transition-colors',
        selected ? 'border-fg text-fg' : 'border-line-2 text-fg-2 hover:text-fg',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
