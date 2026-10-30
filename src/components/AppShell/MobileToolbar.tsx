'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { langFromPath } from './navItems'
import { usePodHealth } from './usePodHealth'
import { NotificationInbox } from './NotificationInbox'

/** Secondary destinations stay within reach without crowding the three phone tabs. */
export function SettingsLink({ className, summary }: { className?: string, summary?: string }) {
  const lang = langFromPath(usePathname())
  return (
    <Link
      href={`/${lang}/settings`}
      aria-label={summary ? `Settings, ${summary}` : 'Settings'}
      className={cn('relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-ctl text-inherit no-underline hover:bg-active min-[900px]:hidden', className)}
    >
      <Settings size={21} aria-hidden />
      {summary && <span data-testid="system-health-dot" className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-warn" />}
    </Link>
  )
}

export function MobileToolbar() {
  const { footer } = usePodHealth()
  return (
    <div data-mobile-toolbar className="flex items-center justify-between min-[900px]:justify-end">
      <span className="min-w-0 truncate font-mono text-sm text-fg-2 min-[900px]:hidden">sleepypod</span>
      <div className="flex shrink-0 items-center gap-1">
        <NotificationInbox />
        <SettingsLink summary={footer.tone === 'warn' ? footer.summary : undefined} />
      </div>
    </div>
  )
}
