'use client'

import type { ReactNode } from 'react'
import { useSwipeNavigation } from '@/src/hooks/useSwipeNavigation'
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'

/**
 * One responsive layout. ≥ 900px: 224px sidebar + content (28/32 padding).
 * < 900px: content (20px padding) + bottom tab bar. <main> is a CSS
 * container so screens can add the 300px context column only when the
 * content area itself is ≥ 960px (`@min-[960px]:`).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { onTouchStart, onTouchEnd } = useSwipeNavigation()
  return (
    <div className="flex min-h-dvh bg-app text-fg">
      <Sidebar className="hidden min-[900px]:flex" />
      <main
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        className="@container flex min-w-0 flex-1 flex-col gap-3.5 px-5 pb-[calc(96px+env(safe-area-inset-bottom,0px))] pt-[calc(env(safe-area-inset-top,0px)+20px)] min-[900px]:gap-[18px] min-[900px]:px-8 min-[900px]:py-7"
      >
        {children}
      </main>
      <TabBar className="min-[900px]:hidden" />
    </div>
  )
}
