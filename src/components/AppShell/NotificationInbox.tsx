'use client'

import { Bell, Check } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Alert, Button, Modal, useToast } from '@/src/components/ds'
import { foregroundDelivery, isUnreadAlert } from '@/src/notifications/foreground'

const queryOptions = {
  refetchInterval: 5000, refetchIntervalInBackground: false, refetchOnWindowFocus: true,
  staleTime: 0, gcTime: 0, retry: false, trpc: { abortOnUnmount: true },
} as const

/** One owner-session inbox; no local storage, hardware writes, or background push. */
export function NotificationInbox() {
  const [open, setOpen] = useState(false)
  const [beforeId, setBeforeId] = useState<number>()
  const [writeError, setWriteError] = useState<string>()
  const latest = trpc.notifications.list.useQuery({}, queryOptions)
  const history = trpc.notifications.list.useQuery({ beforeId }, { ...queryOptions, enabled: open && beforeId !== undefined })
  const acknowledge = trpc.notifications.acknowledge.useMutation({ retry: false })
  const selected = beforeId === undefined ? latest : history
  const page = selected.data
  const cursor = useRef<number | null | undefined>(undefined)
  const trigger = useRef<HTMLButtonElement>(null)
  const bodyId = useId()
  const { show } = useToast()
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!latest.data || latest.isError) return
    const delivered = foregroundDelivery(latest.data, cursor.current)
    cursor.current = delivered.cursor
    if (delivered.items.length && document.visibilityState === 'visible') {
      show({ id: 'automation-inbox', kind: 'info', tone: 'cool', icon: Bell,
        title: delivered.items.length === 1 ? delivered.items[0].title : `${delivered.items.length} new automation alerts`,
        detail: 'Open Alerts to read and acknowledge.',
      })
    }
  }, [latest.data, latest.isError, show])

  // Keep keyboard focus inside the shared sheet/dialog, then return to its trigger.
  useEffect(() => {
    if (!open) return
    const dialog = document.getElementById(bodyId)?.closest('[role="dialog"]')
    const buttons = () => Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])
    buttons()[0]?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const controls = buttons()
      const first = controls[0]
      const last = controls.at(-1)
      if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target?.focus()
      }
    }
    document.addEventListener('keydown', trap)
    const restore = trigger.current
    return () => {
      document.removeEventListener('keydown', trap)
      restore?.focus()
    }
  }, [open, bodyId])

  async function markRead(ids: number[]) {
    setWriteError(undefined)
    try {
      const result = await acknowledge.mutateAsync({ ids })
      if (result.missingIds.length) setWriteError('Some alerts are no longer available. The inbox has been refreshed.')
    }
    catch {
      setWriteError('Could not confirm the read status. Refreshing the inbox; you can safely try again.')
    }
    // Reconcile even when the reply was lost; never optimistically claim success.
    const refreshedLatest = await latest.refetch()
    const refreshedHistory = beforeId !== undefined ? await history.refetch() : undefined
    const confirmed = [refreshedLatest, refreshedHistory].flatMap(result => result && !result.isError ? result.data?.items ?? [] : [])
    if (ids.every(id => confirmed.some(item => item.id === id && item.acknowledgedAt !== null))) setWriteError(undefined)
  }

  const unread = page?.items.filter(item => isUnreadAlert(item, page.generatedAt)) ?? []
  const count = latest.data?.unreadCount ?? 0
  const unavailable = latest.isError || selected.isError
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unavailable ? 'Alerts, connection unavailable' : `Alerts${count ? `, ${count} unread` : ''}`}
        onClick={() => {
          setBeforeId(undefined)
          setWriteError(undefined)
          setOpen(true)
        }}
        className="relative inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-ctl px-2 text-fg-2 hover:bg-active hover:text-fg"
      >
        <Bell size={20} aria-hidden />
        <span className="hidden text-[13px] min-[900px]:inline">Alerts</span>
        {count > 0 && <span aria-hidden className="rounded-full border border-cool/40 bg-cool/10 px-1.5 text-xs text-cool">{count > 99 ? '99+' : count}</span>}
        {unavailable && <span aria-hidden className="size-1.5 rounded-full bg-warn" />}
      </button>
      <Modal
        open={open}
        onClose={close}
        title="Automation alerts"
        icon={Bell}
        width={560}
        className="[&_button[aria-label=Close]]:min-h-11 [&_button[aria-label=Close]]:min-w-11 [&_button[aria-label=Close]]:justify-center [&_button[aria-label=Close]]:inline-flex [&_button[aria-label=Close]]:items-center"
      >
        <div id={bodyId} className="flex min-w-0 flex-col gap-4">
          <p className="text-[13px] text-fg-2">Alerts arrive here while the app is open. Background push is not available. Unread alerts expire after 15 minutes; history is kept for up to 30 days or 1,000 alerts.</p>
          {page?.delivery.foregroundInbox === false && <p role="status" className="text-sm text-fg-2">Connect to your Pod to receive real automation alerts.</p>}
          {unavailable && (
            <Alert action={(
              <Button onClick={() => {
                void latest.refetch()
                if (beforeId !== undefined) void history.refetch()
              }}
              >
                Retry
              </Button>
            )}
            >
              Cannot refresh alerts. Any entries shown are from the last successful check.
            </Alert>
          )}
          {writeError && <Alert>{writeError}</Alert>}
          {!page && !selected.isError && <p role="status" className="text-sm text-fg-2">Loading alerts…</p>}
          {page && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-fg-2">
                  Last checked
                  {' '}
                  {new Date(page.generatedAt).toLocaleTimeString()}
                </span>
                <Button
                  icon={Check}
                  disabled={!unread.length || acknowledge.isPending || unavailable}
                  onClick={() => void markRead(unread.map(item => item.id))}
                >
                  Mark this page read
                </Button>
              </div>
              {!page.items.length && !unavailable && <p className="rounded-card border border-line p-6 text-sm text-fg-2">No automation alerts yet. Preview rules only record proposed actions in Activity.</p>}
              <ul className="flex flex-col divide-y divide-line" aria-label="Alert history">
                {page.items.map(item => (
                  <li key={item.id} className="flex min-w-0 flex-col gap-2 py-4 first:pt-0" data-alert-id={item.id}>
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="min-w-0 break-words text-sm font-medium">{item.title}</h3>
                      <span className="shrink-0 text-xs text-fg-2">{item.acknowledgedAt !== null ? 'Read' : isUnreadAlert(item, page.generatedAt) ? 'Unread' : 'Expired'}</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm text-fg-2">{item.message}</p>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <time dateTime={new Date(item.createdAt).toISOString()} className="text-xs text-fg-3">{new Date(item.createdAt).toLocaleString()}</time>
                      {isUnreadAlert(item, page.generatedAt) && (
                        <Button
                          className="min-h-11"
                          disabled={acknowledge.isPending || unavailable}
                          aria-label={`Mark ${item.title} read`}
                          onClick={() => void markRead([item.id])}
                        >
                          Mark read
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap justify-between gap-2">
                {beforeId !== undefined && <Button className="min-h-11" disabled={acknowledge.isPending} onClick={() => setBeforeId(undefined)}>Latest alerts</Button>}
                {page.nextBeforeId !== null && (
                  <Button
                    className="ml-auto min-h-11"
                    disabled={acknowledge.isPending || unavailable}
                    onClick={() => setBeforeId(page.nextBeforeId ?? undefined)}
                  >
                    Older alerts
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  )
}
