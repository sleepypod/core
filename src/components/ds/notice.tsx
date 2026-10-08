'use client'

import type { LucideIcon } from 'lucide-react'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* ─── Notices ─────────────────────────────────────────────────────────────
   Three kinds, and the kind picks the surface:
   - progress: inline banner while something is still going on (priming,
     alarm snoozed). No dismiss; it goes away when the state ends.
   - action: inline banner that needs the user (pump stall, alarm active).
     Resolved by its action, or an X once seen.
   - success / info: a toast that only confirms something finished. See toast.tsx.
   Toasts never carry actions; if the user has to act it is an action banner. */
export type NoticeTone = 'cool' | 'ok' | 'warn' | 'danger'
export type NoticeKind = 'progress' | 'action' | 'success' | 'info'

export interface Notice {
  /** Stable, e.g. 'pump-stall:left', 'priming'. */
  id: string
  kind: NoticeKind
  tone: NoticeTone
  icon: LucideIcon
  title: ReactNode
  /** Secondary text, fg-2. */
  detail?: ReactNode
  /** Right-aligned mono, e.g. '3 MIN LEFT'. */
  meta?: ReactNode
  /** 0–1, draws the 3px bar (progress kind only). */
  progress?: number
  /** ds Buttons, size="sm". */
  actions?: ReactNode
  /** Renders the X (action kind only). */
  onDismiss?: () => void
  /** Accessible name for the X. */
  dismissLabel?: string
  /** Locks the X while the notice's own action is in flight. */
  dismissDisabled?: boolean
  /** Sides whose controls this notice disables. */
  blocksSides?: Array<'left' | 'right'>
}

const BANNER_BOX: Record<NoticeTone, string> = {
  cool: 'border-line',
  ok: 'border-ok-line',
  warn: 'border-warn-line bg-warn-bg',
  danger: 'border-danger-line',
}

/** Icon colour per tone, shared with toasts. */
export const NOTICE_TEXT: Record<NoticeTone, string> = {
  cool: 'text-cool',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
}

/** Progress and countdown bar fill per tone. */
export const NOTICE_BAR: Record<NoticeTone, string> = {
  cool: 'bg-cool',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
}

const PRIORITY: Record<NoticeTone, number> = { danger: 0, warn: 1, cool: 2, ok: 3 }

/** Banners in priority order: danger, then warn, then cool. Stable within a tone. */
export function sortNotices(notices: Notice[]): Notice[] {
  return notices
    .map((notice, index) => ({ notice, index }))
    .sort((a, b) => PRIORITY[a.notice.tone] - PRIORITY[b.notice.tone] || a.index - b.index)
    .map(({ notice }) => notice)
}

/** One banner: icon, title over detail, mono meta, actions, X, and the progress bar. */
export function NoticeBanner({ notice, className }: { notice: Notice, className?: string }) {
  const { icon: Icon, tone, kind, progress } = notice
  const text = NOTICE_TEXT[tone]
  const showBar = kind === 'progress' && progress !== undefined
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-notice={notice.id}
      className={cn('overflow-hidden rounded-ctl border', BANNER_BOX[tone], className)}
    >
      <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5 text-[13px]">
        <Icon size={14} className={cn('shrink-0', text)} />
        <div className="min-w-0 flex-1">
          <p className={text}>{notice.title}</p>
          {notice.detail && <p className="text-xs text-fg-2">{notice.detail}</p>}
        </div>
        {notice.meta != null && <span className="shrink-0 font-mono text-xs text-fg">{notice.meta}</span>}
        {notice.actions && <div className="flex shrink-0 items-center gap-2">{notice.actions}</div>}
        {kind === 'action' && notice.onDismiss && (
          <button
            type="button"
            aria-label={notice.dismissLabel ?? 'Dismiss'}
            onClick={notice.onDismiss}
            disabled={notice.dismissDisabled}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-ctl border-0 bg-transparent text-fg-2 hover:bg-active hover:text-fg disabled:opacity-45"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {showBar && (
        <div className="h-[3px] bg-line" data-testid="notice-progress">
          <div className={cn('h-full transition-[width] duration-500', NOTICE_BAR[tone])} style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }} />
        </div>
      )}
    </div>
  )
}

/** Banners sorted by priority with an 8px gap; nothing when the list is empty. */
export function NoticeStack({ notices, className }: { notices: Notice[], className?: string }) {
  if (notices.length === 0) return null
  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="notice-stack">
      {sortNotices(notices).map(notice => <NoticeBanner key={notice.id} notice={notice} />)}
    </div>
  )
}
