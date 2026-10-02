import type { ReactNode } from 'react'

export function SectionTitle({ title, hint, right }: { title: string, hint?: string, right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="text-base font-medium">{title}</span>
      {hint && <span className="font-mono text-xs text-fg-2">{hint}</span>}
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  )
}

/** "Jon · left", or just "Left side" when the side has no custom name. */
export function sideTitle(name: string, side: 'left' | 'right'): string {
  return name.toLowerCase() === side ? `${capitalize(side)} side` : `${name} · ${side}`
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
