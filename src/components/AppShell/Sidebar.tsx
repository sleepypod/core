'use client'

import { ArrowUpRight, BookOpen, ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { Badge, StatusDot } from '@/src/components/ds/core'
import { resolveSection, SECTIONS } from '@/src/components/Settings/sections'
import { resolveSystemTab, SYSTEM_TABS } from '@/src/components/System/systemTabs'
import { AUTOPILOT_VIEWS, resolveAutopilotView } from '@/src/components/Autopilot/autopilotViews'
import { resolveSleepSection, SLEEP_SECTIONS } from '@/src/components/Sleep/sleepViews'
import { trpc } from '@/src/utils/trpc'
import { buildLine } from './footerStatus'
import { useBaseAvailable } from './useBaseAvailable'
import { usePodHealth } from './usePodHealth'
import { activeNavId, DOCS_URL, langFromPath, NAV_ITEMS, type NavId } from './navItems'

const noopSubscribe = () => () => {}

const POD_NAMES: Record<string, string> = { H00: 'Pod 3', I00: 'Pod 4', J00: 'Pod 5' }

/** Desktop navigation rail (≥ 900px). */
export function Sidebar({ className }: { className?: string }) {
  const hasBase = useBaseAvailable()
  const items = NAV_ITEMS.filter(item => item.id !== 'base' || hasBase)
  const pathname = usePathname()
  const lang = langFromPath(pathname)
  const active = activeNavId(pathname)

  const version = trpc.system.getVersion.useQuery({}, { staleTime: 60_000 })
  const { footer, podVersion } = usePodHealth()

  const podName = podVersion ? POD_NAMES[podVersion] ?? podVersion : 'Pod'
  const statusDot = footer.tone === 'muted' ? undefined : footer.tone
  const host = useSyncExternalStore(noopSubscribe, () => window.location.hostname, () => '')
  const build = buildLine(version.data)

  return (
    <nav
      aria-label="Main"
      className={cn('sticky top-0 flex h-dvh w-[224px] shrink-0 flex-col gap-7 border-r border-line px-3.5 py-6', className)}
    >
      <div className="relative flex items-center gap-2.5 px-2.5">
        <Link href={`/${lang}`} className="flex min-w-0 items-center gap-2 font-mono text-sm text-fg no-underline hover:no-underline">
          {/* eslint-disable-next-line @next/next/no-img-element -- static 128px asset, no optimizer needed on the pod */}
          <img src="/logo.png" alt="" width={22} height={22} className="size-[22px] rounded-[6px]" />
          sleepypod
        </Link>
        <BuildTag version={version.data?.version ?? null} host={host} branch={build?.branch ?? null} commit={build?.commit ?? null} />
      </div>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {items.map((n) => {
          const on = n.id === active
          const group = n.id === 'autopilot' || n.id === 'sleep' || n.id === 'settings' || n.id === 'system'
          const Chevron = on ? ChevronDown : ChevronRight
          return (
            <div key={n.id} className="flex flex-col gap-0.5">
              <Link
                href={`/${lang}${n.href === '/' ? '' : n.href}`}
                aria-current={on && !group ? 'page' : undefined}
                aria-expanded={group ? on : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-ctl px-2.5 py-[9px] text-sm no-underline transition-colors hover:no-underline',
                  on ? (group ? 'text-fg hover:bg-active' : 'bg-active text-fg') : 'text-fg-2 hover:bg-active',
                )}
              >
                <n.icon size={16} />
                {n.label}
                {group && <Chevron size={14} className="ml-auto text-fg-3" />}
              </Link>
              {group && on && (
                <Suspense fallback={null}>
                  <SubTree group={n.id as 'autopilot' | 'sleep' | 'settings' | 'system'} lang={lang} statusDot={statusDot} />
                </Suspense>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-auto flex flex-col gap-1 border-t border-line pt-2">
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 rounded-ctl px-2.5 py-2 text-sm text-fg-2 no-underline transition-colors hover:bg-active hover:text-fg hover:no-underline"
        >
          <BookOpen size={16} />
          Docs
          <ArrowUpRight size={14} className="ml-auto text-fg-3" />
        </a>
        <Link
          href={`/${lang}/system`}
          className="group flex flex-col gap-2 rounded-ctl px-2.5 py-2 text-sm no-underline transition-colors hover:bg-active hover:no-underline"
        >
          <div className="flex items-center gap-2">
            <StatusDot tone={footer.tone} />
            <span className="text-fg">{podName}</span>
            <span className={footer.tone === 'warn' ? 'text-warn' : 'text-fg-3'}>{footer.summary}</span>
            <ChevronRight size={14} className="ml-auto shrink-0 text-fg-3 group-hover:text-fg-2" />
          </div>
          {footer.issues.length > 0 && (
            <ul className="flex flex-col gap-1.5" data-testid="footer-issues">
              {footer.issues.map(issue => (
                <li key={issue} className="flex gap-2 text-[13px] leading-snug text-fg-2">
                  <TriangleAlert size={13} className="mt-[3px] shrink-0 text-warn" aria-hidden />
                  {issue}
                </li>
              ))}
            </ul>
          )}
          <span className="sr-only">Open System dashboard</span>
        </Link>
      </div>
    </nav>
  )
}

/**
 * Sections nested under their parent (Autopilot, Sleep, Settings, System), indented along a
 * hairline without icons. Only the current group is expanded.
 */
function SubTree({ group, lang, statusDot }: {
  group: Extract<NavId, 'autopilot' | 'sleep' | 'settings' | 'system'>
  lang: string
  statusDot?: 'ok' | 'warn'
}) {
  const searchParams = useSearchParams()
  let items: Array<{ id: string, label: string, href: string, dot?: 'ok' | 'warn' }>
  let current: string
  if (group === 'settings') {
    items = SECTIONS.map(sec => ({
      id: sec.id,
      label: sec.label,
      href: `/${lang}/settings?section=${sec.id}`,
    }))
    current = resolveSection(searchParams.get('section'), searchParams.get('tab')) ?? SECTIONS[0].id
  }
  else if (group === 'system') {
    items = SYSTEM_TABS.map(t => ({
      id: t.id,
      label: t.label,
      href: t.id === 'dashboard' ? `/${lang}/system` : `/${lang}/system?tab=${t.id}`,
      dot: t.id === 'dashboard' ? statusDot : undefined,
    }))
    current = resolveSystemTab(searchParams.get('tab'), searchParams.get('section'))
  }
  else if (group === 'sleep') {
    items = SLEEP_SECTIONS.map(sec => ({
      id: sec.id,
      label: sec.label,
      href: sec.id === 'nights' ? `/${lang}/sleep` : `/${lang}/sleep?view=${sec.id}`,
    }))
    current = resolveSleepSection(searchParams.get('view'))
  }
  else {
    items = AUTOPILOT_VIEWS.map(v => ({
      id: v.id,
      label: v.label,
      href: v.id === 'automations' ? `/${lang}/autopilot` : `/${lang}/autopilot?view=${v.id}`,
    }))
    current = resolveAutopilotView(searchParams.get('view'))
  }

  return (
    <div className="mb-1 ml-[17px] flex flex-col gap-0.5 border-l border-line pl-2">
      {items.map((it) => {
        const on = it.id === current
        return (
          <Link
            key={it.id}
            href={it.href}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-ctl px-2.5 py-[7px] text-sm no-underline transition-colors hover:no-underline',
              on ? 'bg-active text-fg' : 'text-fg-2 hover:bg-active',
            )}
          >
            {it.label}
            {it.dot && <StatusDot tone={it.dot} className="ml-auto" />}
          </Link>
        )
      })}
    </div>
  )
}

/**
 * Tagged release → the version in a neutral chip. Anything else (dev, feature
 * branches, local builds) → an amber DEV chip. Either one opens the build
 * details (host, branch, commit) so they stay out of the footer.
 */
function BuildTag({ version, host, branch, commit }: {
  version: string | null
  host: string
  branch: string | null
  commit: string | null
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!version && !branch && !commit) return null
  const rows = ([['Version', version], ['Host', host], ['Branch', branch], ['Commit', commit]] as Array<[string, string | null]>)
    .filter((r): r is [string, string] => !!r[1])
  return (
    <div ref={ref} className="ml-auto flex shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label="Build details"
        onClick={() => setOpen(o => !o)}
        className="flex rounded-tag"
      >
        {version
          ? <Badge className="text-[10px]">{version}</Badge>
          : <Badge className="border-warn-line bg-warn-bg text-[10px] tracking-[0.06em] text-warn">DEV</Badge>}
      </button>
      {open && (
        <dl
          data-testid="build-details"
          className="absolute inset-x-0 top-full z-20 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-ctl border border-line bg-surface p-3 text-xs shadow-dialog"
        >
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-3">{k}</dt>
              <dd className="font-mono break-words text-fg-2">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
