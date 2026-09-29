'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useScheduleActive } from '@/src/hooks/useScheduleActive'
import { activeNavId, langFromPath, NAV_ITEMS } from './navItems'
import { usePodHealth } from './usePodHealth'

/** Phone bottom tab bar (< 900px). Respects the safe-area inset. */
export function TabBar({ className }: { className?: string }) {
  const pathname = usePathname()
  const lang = langFromPath(pathname)
  const active = activeNavId(pathname)
  const { isActive: scheduleActive } = useScheduleActive()
  const { footer } = usePodHealth()

  return (
    <nav
      aria-label="Main"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t border-line bg-app px-2 pb-[calc(10px+env(safe-area-inset-bottom,0px))] pt-2.5 font-mono text-[10px] tracking-[0.04em]',
        className,
      )}
    >
      {NAV_ITEMS.map((n) => {
        const on = n.id === active
        return (
          <Link
            key={n.id}
            href={`/${lang}${n.href === '/' ? '' : n.href}`}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex min-h-11 flex-col items-center gap-1 no-underline hover:no-underline',
              on ? 'text-fg' : 'text-fg-3',
            )}
          >
            <span className="relative">
              <n.icon size={19} />
              {n.id === 'schedule' && scheduleActive && (
                <span className="absolute -right-1 -top-0.5 size-1.5 rounded-full bg-ok" />
              )}
              {/* Pod health, as the sidebar footer shows it on wider screens. */}
              {n.id === 'system' && footer.tone !== 'muted' && (
                <span
                  className={cn('absolute -right-1 -top-0.5 size-1.5 rounded-full', footer.tone === 'warn' ? 'bg-warn' : 'bg-ok')}
                  data-testid="system-health-dot"
                  data-tone={footer.tone}
                />
              )}
            </span>
            {n.label.toUpperCase()}
            {n.id === 'system' && footer.tone === 'warn' && <span className="sr-only">{`, ${footer.summary}`}</span>}
          </Link>
        )
      })}
    </nav>
  )
}
