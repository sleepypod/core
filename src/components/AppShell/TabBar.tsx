'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { useScheduleActive } from '@/src/hooks/useScheduleActive'
import { activeNavId, langFromPath, PHONE_NAV_ITEMS } from './navItems'

/** Phone bottom tab bar (< 900px). Respects the safe-area inset. */
export function TabBar({ className }: { className?: string }) {
  const items = PHONE_NAV_ITEMS
  const pathname = usePathname()
  const lang = langFromPath(pathname)
  const active = activeNavId(pathname)
  const { isActive: scheduleActive } = useScheduleActive()
  const navigation = useRef<HTMLElement>(null)

  // Large text and safe-area insets change the bar height; keep the stage above it.
  useEffect(() => {
    const element = navigation.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const height = element.getBoundingClientRect().height
      if (height > 0) document.documentElement.style.setProperty('--phone-nav-height', `${height}px`)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--phone-nav-height')
    }
  }, [])

  return (
    <nav
      ref={navigation}
      aria-label="Main"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 flex flex-wrap gap-x-1 border-t border-line bg-app px-2 pb-[calc(10px+env(safe-area-inset-bottom,0px))] pt-2.5 font-mono',
        'text-[0.6875rem] uppercase tracking-[0.06em]',
        className,
      )}
    >
      {items.map((n) => {
        const on = n.id === active
        return (
          <Link
            key={n.id}
            href={`/${lang}${n.href === '/' ? '' : n.href}`}
            data-primary-destination={n.id}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex min-h-11 min-w-max flex-1 basis-[52px] flex-col items-center gap-1 rounded-ctl no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cool hover:no-underline',
              on ? 'text-fg' : 'text-fg-3',
            )}
          >
            <span className="relative">
              <n.icon size={19} aria-hidden />
              {n.id === 'schedule' && scheduleActive && (
                <span className="absolute -right-1 -top-0.5 size-1.5 rounded-full bg-ok" aria-hidden />
              )}
            </span>
            <span className="whitespace-nowrap text-center">{n.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
