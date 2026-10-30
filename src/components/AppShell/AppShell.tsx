'use client'

import type { ReactNode } from 'react'
import { ToastProvider } from '@/src/components/ds'
import { useSwipeNavigation } from '@/src/hooks/useSwipeNavigation'
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { MobileToolbar } from './MobileToolbar'

/**
 * One responsive layout. ≥ 900px: 224px sidebar + content (28/32 padding).
 * < 900px: content (20px padding) + bottom tab bar. <main> is a CSS
 * container so screens can add the 300px context column only when the
 * content area itself is ≥ 960px (`@min-[960px]:`). Toasts (`useToast`)
 * overlay the content column.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { onTouchStart, onTouchEnd } = useSwipeNavigation()
  return (
    <ToastProvider>
      <div className="flex min-h-dvh bg-app text-fg">
        <Sidebar className="hidden min-[900px]:flex" />
        <main
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          className="@container flex min-w-0 flex-1 flex-col gap-3.5 px-5 pb-[calc(var(--phone-nav-height,76px)+20px)] pt-[calc(env(safe-area-inset-top,0px)+20px)] min-[900px]:gap-[18px] min-[900px]:px-8 min-[900px]:py-7"
        >
          <MobileToolbar />
          {process.env.NEXT_PUBLIC_DEMO === '1' && (
            <p role="status" className="relative z-10 rounded-ctl border border-cool/30 bg-surface px-4 py-2 text-sm text-fg-2">
              Demo · Sample data. Controls do not operate your Pod.
            </p>
          )}
          {children}
        </main>
        <TabBar className="min-[900px]:hidden" />
      </div>
    </ToastProvider>
  )
}
