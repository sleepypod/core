'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Button, InlineError, Modal, Skeleton, StatusDot } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import type { Segment } from './calibration-model'

export type RestoreTarget = 'previous' | 'defaults'

/** Saved › Requested › Processor, each with a dot and a mono value. */
export function LifecycleStrip({ saved, requested, processor }: { saved: Segment, requested: Segment, processor: Segment }) {
  const { t } = useLingui()
  const segments = [
    { key: 'saved', label: t`Saved`, segment: saved },
    { key: 'requested', label: t`Requested`, segment: requested },
    { key: 'processor', label: t`Processor`, segment: processor },
  ]
  return (
    <div role="group" aria-label={t`Profile lifecycle`} className="flex max-w-full items-center overflow-x-auto rounded-seg border border-line bg-surface px-1.5 py-1">
      {segments.map(({ key, label, segment }, i) => (
        <div key={key} className="flex items-center">
          {i > 0 && <ChevronRight size={13} className="shrink-0 text-fg-3" aria-hidden />}
          <div className="flex items-center gap-2 px-3 py-[5px]" data-segment={key}>
            <StatusDot tone={segment.tone} />
            <span className="whitespace-nowrap text-fg-2">{label}</span>
            <span className="whitespace-nowrap font-mono text-xs">{segment.value}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

export function RestoreMenu({ hasPrevious, disabled, onSelect, className }: {
  hasPrevious: boolean
  disabled?: boolean
  onSelect: (target: RestoreTarget) => void
  className?: string
}) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  const pick = (target: RestoreTarget) => {
    setOpen(false)
    onSelect(target)
  }
  return (
    <div ref={root} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className="cursor-pointer whitespace-nowrap rounded-ctl border border-line-2 bg-transparent px-3 py-1.5 font-mono text-xs text-fg hover:bg-active disabled:cursor-default disabled:opacity-45"
      >
        {t`Restore… ▾`}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-20 flex min-w-44 flex-col rounded-ctl border border-line-2 bg-surface p-1 text-[13px] shadow-[var(--shadow-dialog)]">
          <button type="button" role="menuitem" disabled={!hasPrevious} onClick={() => pick('previous')} className="cursor-pointer rounded-thumb border-0 bg-transparent px-2.5 py-2 text-left text-fg hover:bg-active disabled:cursor-default disabled:opacity-45">
            {t`Previous`}
          </button>
          <button type="button" role="menuitem" onClick={() => pick('defaults')} className="cursor-pointer rounded-thumb border-0 bg-transparent px-2.5 py-2 text-left text-fg hover:bg-active">
            {t`System defaults`}
          </button>
        </div>
      )}
    </div>
  )
}

const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('')
const show = (value: unknown) => typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' ? String(value) : value === undefined ? '—' : JSON.stringify(value)

/**
 * Restore review: what changes, then one request. Restoring saves the target
 * as the profile and requests it; the current saved profile becomes previous.
 */
export function RestoreDialog({ side, target, binding, onClose, onDone }: {
  side: 'left' | 'right'
  target: RestoreTarget
  binding: { generation: number, desiredRevisionId: string | null, previousRevisionId: string | null }
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useLingui()
  const diff = trpc.biometricTuning.diffProfileRevision.useMutation()
  const rollback = trpc.biometricTuning.rollbackProfile.useMutation()
  const reset = trpc.biometricTuning.resetProfile.useMutation()
  const key = useRef(randomKey())
  const revisionId = target === 'previous' ? binding.previousRevisionId : null
  const { mutate } = diff
  useEffect(() => {
    mutate({ side, revisionId, againstRevisionId: binding.desiredRevisionId })
  }, [mutate, side, revisionId, binding.desiredRevisionId])

  const busy = rollback.isPending || reset.isPending
  const error = diff.error ?? rollback.error ?? reset.error
  async function confirm() {
    if (!diff.data) return
    const common = { side, expectedGeneration: binding.generation, expectedResolvedHash: diff.data.afterHash, boundary: 'next_session' as const,
      requester: 'web-calibration', idempotencyKey: key.current, allowUnvalidated: true as const }
    if (target === 'previous') await rollback.mutateAsync({ ...common, revisionId })
    else await reset.mutateAsync(common)
    onDone()
  }

  const changes = diff.data?.changes ?? []
  const numeric = changes.filter(c => !c.path.startsWith('sleep_stages'))
  const stages = changes.length - numeric.length
  const title = target === 'previous' ? t`Restore the previous profile` : t`Restore system defaults`
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={(
        <>
          <Button variant="primary" disabled={!diff.data || busy} onClick={() => void confirm().catch(() => {})}>{busy ? t`Requesting…` : t`Restore and request`}</Button>
          <Button variant="ghost" onClick={onClose}>{t`Cancel`}</Button>
        </>
      )}
    >
      <p className="text-[13px] leading-[1.5] text-fg-2">
        {t`Saves it as the profile and requests it; the current saved profile becomes previous. The processor keeps running what it has until it acknowledges the request.`}
      </p>
      {!diff.data && !diff.error
        ? <Skeleton className="h-16" />
        : diff.data && (
          changes.length === 0
            ? <p className="text-[13px]">{t`Identical to the saved profile; restoring only re-requests it.`}</p>
            : (
                <ul className="flex flex-col gap-1.5 font-mono text-xs">
                  {numeric.map(c => (
                    <li key={c.path} className="flex justify-between gap-3">
                      <span className="text-fg-2">{c.path}</span>
                      <span>
                        {show(c.before)}
                        {' → '}
                        {show(c.after)}
                      </span>
                    </li>
                  ))}
                  {stages > 0 && <li className="text-fg-2">{t`${stages} sleep-stage values`}</li>}
                </ul>
              )
        )}
      {error ? <InlineError>{error.message}</InlineError> : null}
    </Modal>
  )
}
