'use client'

import { useState } from 'react'
import { HardDrive, Trash2 } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, Skeleton, Toggle } from '@/src/components/ds'
import { ConfirmDialog } from '@/src/components/Schedule/ConfirmDialog'
import { formatBytes } from '@/src/components/status/SystemInfoCard'

type Storage = inferRouterOutputs<AppRouter>['system']['getStorage']
type SegmentKey = Storage['segments'][number]['key']

const SEGMENTS: Record<SegmentKey, { label: string, color: string }> = {
  rawArchive: { label: 'Raw sensor archive', color: 'var(--chart-1)' },
  app: { label: 'sleepypod app', color: 'var(--chart-3)' },
  database: { label: 'Databases', color: 'var(--chart-4)' },
  swap: { label: 'Swap', color: 'var(--chart-5)' },
  reclaimable: { label: 'Reclaimable leftovers', color: 'var(--status-warn)' },
  other: { label: 'Other', color: 'var(--text-3)' },
}

/** "/persistent/sleepypod-releases/abc" → "sleepypod-releases/abc". */
function shortPath(p: string): string {
  return p.replace(/^\/persistent\//, '')
}

/**
 * System → Storage: what fills /persistent, how much raw history that leaves
 * once the pruner trims to its target, and a one-button cleanup of
 * sleepypod's own leftovers.
 */
export function StorageTab() {
  const utils = trpc.useUtils()
  const storage = trpc.system.getStorage.useQuery({}, { refetchInterval: 60_000 })
  const [includeBackups, setIncludeBackups] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const free = trpc.system.freeStorage.useMutation({
    onSettled: () => {
      setConfirming(false)
      void utils.system.getStorage.invalidate()
    },
  })

  // isPending (not isLoading) so the error card never flashes before the first fetch starts.
  if (storage.isPending) {
    return (
      <>
        <Card data-testid="storage-skeleton">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-3 rounded-full" />
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 @min-[640px]:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-4" />)}
          </div>
          <Skeleton className="h-8" />
        </Card>
        <Card>
          <Skeleton className="h-5 w-1/4" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </Card>
      </>
    )
  }
  if (storage.error || !storage.data) {
    return <Card tone="danger"><InlineError>{storage.error?.message ?? 'Storage info unavailable'}</InlineError></Card>
  }

  const d = storage.data
  const total = d.persistent.totalBytes
  const items = d.reclaimable.items.filter(i => includeBackups || i.kind !== 'backup')
  const selectedBytes = items.reduce((s, i) => s + i.bytes, 0)
  const backupCount = d.reclaimable.items.filter(i => i.kind === 'backup').length

  return (
    <>
      <Card>
        <CardHeader
          icon={HardDrive}
          title="/persistent"
          subtitle={total ? `${formatBytes(d.persistent.usedBytes)} of ${formatBytes(total)} used · ${formatBytes(d.persistent.availableBytes)} free` : 'Not available on this machine'}
        />
        <div className="relative">
          <div role="img" aria-label="Storage usage by category" className="flex h-3 overflow-hidden rounded-full bg-active">
            {total > 0 && d.segments.map(s => (
              s.bytes > 0 && (
                <div key={s.key} data-testid={`seg-${s.key}`} style={{ width: `${(s.bytes / total) * 100}%`, background: SEGMENTS[s.key].color }} />
              )
            ))}
          </div>
          {/* Where the pruner starts deleting raw history. */}
          <div
            className="absolute -top-1 -bottom-1 w-px bg-fg"
            style={{ left: `${d.prunerTargetPercent}%` }}
            title={`Pruner target ${d.prunerTargetPercent}%`}
          />
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 @min-[640px]:grid-cols-3">
          {d.segments.map(s => (
            <div key={s.key} className="flex items-center gap-2 text-[13px]">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: SEGMENTS[s.key].color }} />
              <span className="truncate text-fg-2">{SEGMENTS[s.key].label}</span>
              <span className="ml-auto font-mono text-xs">{formatBytes(s.bytes)}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-fg-2 text-pretty">
          {d.rawHistory.days != null
            ? (
                <>
                  <span className="font-mono text-fg">
                    {d.rawHistory.days}
                    {' days'}
                  </span>
                  {' of raw history '}
                  {`(${d.rawHistory.fileCount.toLocaleString()} archives)`}
                </>
              )
            : 'No raw archive yet'}
          {' · the pruner keeps /persistent under '}
          <span className="font-mono text-fg">
            {d.prunerTargetPercent}
            %
          </span>
          {' by deleting the oldest raw archives, so every leftover below costs raw history.'}
        </p>
      </Card>

      <Card>
        <CardHeader
          icon={Trash2}
          title="Reclaimable"
          subtitle={d.reclaimable.available
            ? items.length ? `${items.length} item${items.length === 1 ? '' : 's'} sleepypod left behind` : 'Nothing to clean up'
            : 'Cleanup tool not installed — update the pod to enable it'}
          right={d.reclaimable.available && items.length > 0 && (
            <Button variant="primary" size="sm" onClick={() => setConfirming(true)} disabled={free.isPending}>
              {`Free up ${formatBytes(selectedBytes)}`}
            </Button>
          )}
        />
        {items.length > 0 && (
          <div className="flex flex-col divide-y divide-line">
            {items.map(i => (
              <div key={i.path} className="flex items-center gap-3 py-2">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-xs">{shortPath(i.path)}</span>
                  <span className="text-xs text-fg-2">{i.reason}</span>
                </div>
                <span className="ml-auto shrink-0 font-mono text-xs">{formatBytes(i.bytes)}</span>
              </div>
            ))}
          </div>
        )}
        {backupCount > 0 && (
          <label className="flex items-center gap-2.5 text-[13px] text-fg-2">
            <Toggle on={includeBackups} onChange={setIncludeBackups} label="Include old database backups" />
            {`Include ${backupCount} old database backup${backupCount === 1 ? '' : 's'} (the newest of each is always kept)`}
          </label>
        )}
        {free.data && (
          <p role="status" className="text-xs text-ok">
            {`Freed ${formatBytes(free.data.freedBytes)} from ${free.data.removed} item${free.data.removed === 1 ? '' : 's'}.`}
          </p>
        )}
        {free.error && <InlineError>{free.error.message}</InlineError>}
      </Card>

      <ConfirmDialog
        open={confirming}
        title={`Free up ${formatBytes(selectedBytes)}?`}
        message={(
          <>
            {`This permanently deletes ${items.length} item${items.length === 1 ? '' : 's'} from /persistent. `}
            The running app, live databases, raw archive, swap and HomeKit pairing are never touched.
            {includeBackups ? ' Old database backups are included.' : ''}
          </>
        )}
        confirmLabel="Delete"
        variant="danger"
        busy={free.isPending}
        onConfirm={() => free.mutate({ includeDbBackups: includeBackups })}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}
