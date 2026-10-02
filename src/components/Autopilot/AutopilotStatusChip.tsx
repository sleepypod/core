'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { StatusDot } from '@/src/components/ds'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { trpc } from '@/src/utils/trpc'

/**
 * Compact Autopilot state for the Temperature header, linking to the console.
 * Shares automations.status with the console's RUNNING · N ACTIVE header;
 * hidden when no rule is enabled.
 */
export function AutopilotStatusChip({ className }: { className?: string }) {
  const lang = langFromPath(usePathname())
  const { data } = trpc.automations.status.useQuery({}, { refetchInterval: 15000 })
  const enabled = data?.rules.filter(r => r.enabled) ?? []
  if (enabled.length === 0) return null

  const killed = !data?.globalEnabled
  const live = enabled.filter(r => !r.dryRun).length
  const detail = killed ? 'HALTED' : live > 0 ? `${live} ACTIVE` : 'DRY RUN'

  return (
    <Link href={`/${lang}/autopilot`} className={className} data-testid="autopilot-chip">
      <StatusDot
        tone={killed ? 'danger' : live > 0 ? 'ok' : 'muted'}
        mono
        label={`AUTOPILOT · ${detail}`}
      />
    </Link>
  )
}
