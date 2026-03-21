'use client'

import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Activity, BarChart3, Calendar, Radio, Settings, Thermometer } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

const tabs = [
  { id: 'temp', icon: Thermometer, label: msg`Temp`, href: '/' },
  { id: 'schedule', icon: Calendar, label: msg`Schedule`, href: '/schedule' },
  { id: 'data', icon: BarChart3, label: msg`Data`, href: '/data' },
  { id: 'sensors', icon: Radio, label: msg`Sensors`, href: '/sensors' },
  { id: 'status', icon: Activity, label: msg`Status`, href: '/status' },
]

/**
 * Global bottom navigation component with routing.
 * Highlights the active tab based on the current pathname.
 */
export const BottomNav = () => {
  const { i18n } = useLingui()
  const pathname = usePathname()

  // Extract the path segment after /[lang]/ to determine active tab
  const getIsActive = (href: string) => {
    if (!pathname) return false
    // Remove the language prefix (e.g., /en/schedule -> /schedule)
    const segments = pathname.split('/')
    const pathWithoutLang = '/' + segments.slice(2).join('/')
    if (href === '/') return pathWithoutLang === '/' || pathWithoutLang === ''
    return pathWithoutLang.startsWith(href)
  }

  // Get the language prefix from the current pathname
  const lang = pathname?.split('/')[1] ?? 'en'

  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 border-t border-zinc-900 bg-black/90 px-2 py-2 sm:px-4 sm:py-3">
      <div className="mx-auto flex max-w-md justify-between">
        {tabs.map(tab => {
          const isActive = getIsActive(tab.href)
          return (
            <Link
              key={tab.id}
              href={`/${lang}${tab.href}`}
              className="group flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 sm:gap-1"
            >
              <tab.icon
                size={18}
                className={clsx(
                  'shrink-0',
                  isActive ? 'text-sky-400' : 'text-zinc-600'
                )}
              />
              <span
                className={clsx(
                  'truncate text-[8px] font-bold uppercase leading-tight sm:text-[9px]',
                  isActive ? 'text-white' : 'text-zinc-600'
                )}
              >
                {i18n._(tab.label)}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
