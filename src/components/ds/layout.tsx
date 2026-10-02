'use client'

import type { LucideIcon } from 'lucide-react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* ─── SettingRow ─────────────────────────────────────────────────────────
   Label + optional sub-copy on the left, control on the right, hairline on top. */
export function SettingRow({ label, sub, children, divider = true, className }: {
  label: ReactNode
  sub?: ReactNode
  children?: ReactNode
  divider?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-3', divider && 'border-t border-line pt-3', className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2.5 text-sm">{label}</span>
        {sub && <span className="text-xs leading-[1.4] text-fg-2 text-pretty">{sub}</span>}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-2.5">{children}</div>}
    </div>
  )
}

/* ─── PageHeader ─────────────────────────────────────────────────────── */
export function PageHeader({ title, back, onBack, middle, right, className }: {
  title: ReactNode
  back?: ReactNode
  onBack?: () => void
  middle?: ReactNode
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-h-[30px] shrink-0 flex-wrap items-center gap-2 min-[900px]:min-h-9 min-[900px]:gap-4', className)}>
      {back && (
        <button
          type="button"
          onClick={onBack}
          className="-ml-1.5 flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[15px] text-fg-2 hover:text-fg min-[900px]:ml-0 min-[900px]:text-sm"
        >
          <ChevronLeft size={18} />
          {back}
        </button>
      )}
      <h1 className="whitespace-nowrap text-xl font-medium min-[900px]:text-[22px]">{title}</h1>
      {middle}
      {right && <div className="ml-auto flex flex-wrap items-center gap-2.5">{right}</div>}
    </div>
  )
}

/* ─── SubNav ─────────────────────────────────────────────────────────────
   Desktop 180px section list (Settings, Diagnostics). */
export interface SubNavItem<T extends string> {
  id: T
  label: ReactNode
  icon?: LucideIcon
  /** CSS color of a trailing status dot. */
  dot?: string
  badge?: ReactNode
}

export function SubNav<T extends string>({ title, items, active, onSelect, width = 180, className }: {
  title?: ReactNode
  items: ReadonlyArray<SubNavItem<T>>
  active: T
  onSelect: (id: T) => void
  width?: number
  className?: string
}) {
  return (
    <nav className={cn('flex shrink-0 flex-col gap-0.5 text-sm', className)} style={{ width }}>
      {title && <div className="mb-[18px] text-[22px] font-medium">{title}</div>}
      {items.map((it) => {
        const on = it.id === active
        const Icon = it.icon
        return (
          <button
            key={it.id}
            type="button"
            aria-current={on ? 'page' : undefined}
            onClick={() => onSelect(it.id)}
            className={cn(
              'flex cursor-pointer items-center gap-2.5 rounded-ctl border-0 px-2.5 py-2 text-left text-sm transition-colors',
              on ? 'bg-active text-fg' : 'bg-transparent text-fg-2 hover:bg-active',
            )}
          >
            {Icon && <Icon size={15} />}
            {it.label}
            {it.badge}
            {it.dot && <span className="ml-auto size-1.5 rounded-full" style={{ background: it.dot }} />}
          </button>
        )
      })}
    </nav>
  )
}

/** Phone index list row (Settings index → pushed page). */
export function IndexRow({ icon: Icon, label, value, onClick, dot }: {
  icon?: LucideIcon
  label: ReactNode
  value?: ReactNode
  onClick: () => void
  dot?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-3 border-0 border-t border-line bg-transparent px-0.5 py-3.5 text-left text-[15px] first:border-t-0 hover:bg-active"
    >
      {Icon && <Icon size={17} className="text-icon" />}
      <span className="flex-1">{label}</span>
      {dot && <span className="size-1.5 rounded-full" style={{ background: dot }} />}
      {value && <span className="font-mono text-[13px] text-fg-2">{value}</span>}
      <ChevronRight size={16} className="text-fg-3" />
    </button>
  )
}
