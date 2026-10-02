'use client'

import type { LucideIcon } from 'lucide-react'
import type { ComponentProps, CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { skyHue, tempHue } from '@/src/lib/tempColors'

/* ─── Card ──────────────────────────────────────────────────────────────
   1px hairline, 12px radius, 16/18 padding, 12 gap, no shadow.
   highlight = green hairline (active item). dashed = paused / "add" slot.
   backdrop = a layer painted behind the content, clipped to the card
   (e.g. <TempBackdrop />). */
export interface CardProps extends ComponentProps<'div'> {
  dashed?: boolean
  flat?: boolean
  highlight?: boolean
  tone?: 'warn' | 'danger'
  backdrop?: ReactNode
}

export function Card({ dashed, flat, highlight, tone, backdrop, className, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-card border px-[18px] py-4',
        backdrop != null && 'relative isolate overflow-hidden',
        dashed ? 'border-dashed' : 'border-solid',
        highlight
          ? 'border-ok-line'
          : tone === 'warn'
            ? 'border-warn-line'
            : tone === 'danger'
              ? 'border-danger-line'
              : dashed ? 'border-line-2' : 'border-line',
        flat ? 'bg-transparent' : 'bg-surface',
        props.onClick && 'cursor-pointer',
        className,
      )}
      {...props}
    >
      {backdrop}
      {children}
    </div>
  )
}

/**
 * Temperature backdrop for a Card: a wash for the time of day across the top
 * (indigo night, rose-amber dawn, pale sky by day, violet dusk) and a glow
 * rising from below tinted by the temperature (blue cool → violet neutral →
 * rose warm). Both transition when their inputs change. `off` swaps both for
 * a flat dark gradient (side powered off).
 */
export function TempBackdrop({ tempF, minutes, off }: {
  /** Set point driving the glow, °F; null hides it. */
  tempF: number | null
  /** Time of day for the wash, minutes past midnight. */
  minutes: number
  off?: boolean
}) {
  const layer = 'pointer-events-none absolute inset-0 -z-10 transition-[background-color,opacity] duration-700'
  return (
    <>
      <div
        aria-hidden
        className={cn('sp-temp-sky', layer, off && 'opacity-0')}
        style={{ '--h': skyHue(minutes) } as CSSProperties}
      />
      <div
        aria-hidden
        className={cn('sp-temp-glow', layer, (off || tempF == null) && 'opacity-0')}
        style={tempF == null ? undefined : ({ '--h': tempHue(tempF) } as CSSProperties)}
      />
      <div aria-hidden className={cn('sp-temp-off', layer, !off && 'opacity-0')} />
    </>
  )
}

export function CardHeader({ title, subtitle, right, icon: Icon, iconClassName, className }: {
  title: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  icon?: LucideIcon
  iconClassName?: string
  className?: string
}) {
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      {Icon && <Icon size={16} className={cn('mt-0.5 shrink-0 text-icon', iconClassName)} />}
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-[15px] font-medium">{title}</span>
        {subtitle && <span className="text-[13px] leading-[1.4] text-fg-2 text-pretty">{subtitle}</span>}
      </div>
      {right && <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  )
}

/** Mono uppercase eyebrow ("TONIGHT", "LEFT · IN BED"). */
export function SectionLabel({ children, right, className, style }: {
  children: ReactNode
  right?: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <div className={cn('sp-label flex items-center gap-2', className)} style={style}>
      {children}
      {right && <span className="ml-auto normal-case tracking-normal">{right}</span>}
    </div>
  )
}

const DOT_TONES = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  muted: 'bg-fg-3',
  cool: 'bg-cool',
  warm: 'bg-warm',
} as const
const DOT_TEXT = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  muted: 'text-fg-3',
  cool: 'text-cool',
  warm: 'text-warm',
} as const
export type Tone = keyof typeof DOT_TONES

export function StatusDot({ tone = 'ok', size = 6, label, mono, className }: {
  tone?: Tone
  size?: number
  label?: ReactNode
  mono?: boolean
  className?: string
}) {
  const dot = (
    <span
      className={cn('block shrink-0 rounded-full', DOT_TONES[tone], !label && className)}
      style={{ width: size, height: size }}
    />
  )
  if (!label) return dot
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap',
        mono ? 'font-mono text-[11px] tracking-[0.06em]' : 'text-xs',
        DOT_TEXT[tone],
        className,
      )}
    >
      {dot}
      {label}
    </span>
  )
}

export function Badge({ variant = 'dev', children, className }: {
  variant?: 'dev' | 'active' | 'paused'
  children?: ReactNode
  className?: string
}) {
  if (variant === 'active') {
    return (
      <span className={cn('inline-flex items-center gap-1.5 rounded-full border border-ok-line px-2 py-0.5 font-mono text-[11px] tracking-[0.06em] text-ok', className)}>
        <span className="size-[5px] rounded-full bg-ok" />
        {children ?? 'ACTIVE'}
      </span>
    )
  }
  if (variant === 'paused') {
    return <span className={cn('font-mono text-[10px] tracking-[0.06em] text-warn', className)}>{children ?? 'PAUSED'}</span>
  }
  return (
    <span className={cn('rounded-tag border border-line-2 px-1 font-mono text-[9px] leading-[14px] text-fg-2', className)}>
      {children ?? 'DEV'}
    </span>
  )
}

export function KeyValue({ label, value, className, valueClassName, size = 14 }: {
  label: ReactNode
  value: ReactNode
  className?: string
  valueClassName?: string
  size?: number
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-xs text-fg-2">{label}</div>
      <div className={cn('truncate font-mono', valueClassName)} style={{ fontSize: size }}>{value}</div>
    </div>
  )
}

export function Metric({ label, value, ok, icon: Icon, iconClassName, className }: {
  label: ReactNode
  value: ReactNode
  ok?: boolean
  icon?: LucideIcon
  iconClassName?: string
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 rounded-[10px] border border-line bg-surface px-3.5 py-3', className)}>
      {Icon && <Icon size={14} className={cn('text-icon', iconClassName)} />}
      <span className={cn('whitespace-nowrap font-mono font-light', Icon ? 'order-1 text-[22px]' : 'order-1 text-lg')}>{value}</span>
      <span className={cn('flex items-center gap-1.5 whitespace-nowrap text-xs text-fg-2', Icon ? 'order-2' : 'order-first')}>
        {ok !== undefined && <span className={cn('size-1.5 rounded-full', ok ? 'bg-ok' : 'bg-warn')} />}
        {label}
      </span>
    </div>
  )
}

/* ─── Buttons ──────────────────────────────────────────────────────────── */

const BUTTON_VARIANTS = {
  primary: 'bg-fg text-inverse border-transparent font-medium',
  secondary: 'bg-transparent text-fg border-line-2 hover:bg-active',
  danger: 'bg-transparent text-danger border-danger-line hover:bg-active',
  ghost: 'bg-transparent text-fg-2 border-transparent hover:bg-active',
  dashed: 'bg-transparent text-fg-2 border-dashed border-line-2 hover:bg-active',
} as const

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: keyof typeof BUTTON_VARIANTS
  size?: 'sm' | 'md'
  icon?: LucideIcon
  full?: boolean
}

export function Button({ variant = 'secondary', size = 'md', icon: Icon, full, className, children, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border transition-colors disabled:cursor-default disabled:opacity-45',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-[13px]',
        BUTTON_VARIANTS[variant],
        full && 'w-full',
        className,
      )}
      {...props}
    >
      {Icon && <Icon size={14} />}
      {children}
    </button>
  )
}

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: LucideIcon
  size?: number
  /** CSS color for the outline + glyph (e.g. 'var(--accent-cool)'). */
  accent?: string
  label: string
}

/** Round outlined icon button (−, power, +). */
export function IconButton({ icon: Icon, size = 48, accent, label, className, style, type = 'button', ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      className={cn(
        'flex shrink-0 cursor-pointer items-center justify-center rounded-full border bg-transparent p-0 transition-colors hover:bg-active disabled:cursor-default disabled:opacity-45',
        !accent && 'border-line-2 text-icon',
        className,
      )}
      style={{ width: size, height: size, ...(accent ? { borderColor: accent, color: accent } : null), ...style }}
      {...props}
    >
      <Icon size={Math.round(size * 0.38)} />
    </button>
  )
}

/** Small borderless square icon button used in card headers (play, edit, delete). */
export function GhostIcon({ icon: Icon, label, size = 16, className, type = 'button', ...props }: Omit<ComponentProps<'button'>, 'children'> & { icon: LucideIcon, label: string, size?: number }) {
  return (
    <button
      type={type}
      aria-label={label}
      className={cn('flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-ctl text-fg-2 transition-colors hover:bg-active hover:text-fg disabled:opacity-45', className)}
      {...props}
    >
      <Icon size={size} />
    </button>
  )
}

/** Skeleton block at card radius (keeps the existing animate-pulse loading pattern). */
export function Skeleton({ className, ...rest }: { className?: string } & HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-card border border-line bg-surface', className)} {...rest} />
}

/** Inline red error in a card slot. */
export function InlineError({ children, className }: { children: ReactNode, className?: string }) {
  return <p className={cn('text-[13px] text-danger', className)}>{children}</p>
}
