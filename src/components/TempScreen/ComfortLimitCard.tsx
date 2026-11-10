'use client'

import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { comfortLimitConfigSchema } from '@/src/temperature/limits'
import type { Side } from '@/src/hardware/types'

/** A confirmed revision anchors each edit; background refreshes never overwrite a draft. */
export function ComfortLimitCard({ side }: { side: Side }) {
  const query = trpc.comfortLimit.get.useQuery({ side }, { refetchInterval: 30_000, retry: false })
  const save = trpc.comfortLimit.configure.useMutation({ networkMode: 'always', retry: false, onSuccess: () => {
    setDraft(null)
    void query.refetch()
  }, onError: () => setDraft(null) })
  const [draft, setDraft] = useState<{ side: Side, source: Side, revision: number, enabled: boolean, minF: string, maxF: string } | null>(null)
  const page = query.data
  const current = draft?.side === side ? draft : null
  const parsed = current && comfortLimitConfigSchema.safeParse({ enabled: current.enabled, minF: Number(current.minF), maxF: Number(current.maxF) })
  const staleDraft = current && page && (current.revision !== page.revision || current.source !== page.sourceSide)
  return (
    <section className="my-4 rounded-card border border-line bg-surface p-4 text-fg" aria-label="Overnight comfort limit">
      <div className="flex items-center gap-2">
        <ShieldCheck size={19} aria-hidden="true" />
        <h2 className="font-semibold">Overnight comfort limit</h2>
      </div>
      {query.isError || save.error || !page
        ? <p role="status" className="mt-2 text-sm text-fg-2">{save.error ? 'The save was not confirmed. Refresh before trying again. No retry was queued.' : query.isError ? 'Limit unavailable. Reconnect and refresh before changing it.' : 'Checking the saved limit…'}</p>
        : (
            <>
              <p className="mt-2 text-sm capitalize">
                {side}
                {' '}
                zone
              </p>
              <p className="mt-2 text-lg font-semibold">{page.config.enabled ? `${page.config.minF}–${page.config.maxF}°F automatic range` : 'No automatic range enabled'}</p>
              <p className="mt-1 text-sm text-fg-2">{page.config.enabled ? 'Schedules, Autopilot and run-once plans stay within this range whenever the bed is on. Manual temperature holds temporarily override it.' : 'Enable a range to bound automatic schedules, Autopilot and run-once plans independently of personal learning.'}</p>
              {page.sourceSide !== side && (
                <p className="mt-2 text-sm">
                  This zone follows the
                  {' '}
                  {page.sourceSide}
                  {' '}
                  sleeper’s range.
                </p>
              )}
              <p className="mt-2 text-sm">{page.wake ? `Next wake warming may leave the range at ${new Intl.DateTimeFormat(undefined, { timeZone: page.wake.timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(page.wake.startsAt)}, toward ${page.wake.targetF}°F. The range resumes after the alarm’s warm hold.` : page.wakeAvailable ? 'No next wake-warming exception is scheduled.' : 'Next wake time is unavailable. Refresh to confirm it.'}</p>
              {!current && (
                <button
                  className="mt-3 rounded-ctl border border-line-2 px-3 py-2 text-sm"
                  onClick={() => {
                    save.reset()
                    setDraft({ side, source: page.sourceSide, revision: page.revision, enabled: page.config.enabled, minF: String(page.config.minF), maxF: String(page.config.maxF) })
                  }}
                >
                  Edit comfort range
                </button>
              )}
            </>
          )}
      {(save.error || query.isError) && (
        <button
          type="button"
          className="mt-3 rounded-ctl border border-line-2 px-3 py-2 text-sm"
          onClick={async () => {
            const refreshed = await query.refetch()
            if (!refreshed.isError) save.reset()
          }}
        >
          Refresh saved limit
        </button>
      )}
      {current && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (parsed?.success && !staleDraft && !query.isError && !save.isPending && !save.error) save.mutate({ side, expectedSourceSide: current.source, expectedRevision: current.revision, config: parsed.data })
          }}
        >
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={current.enabled} onChange={event => setDraft({ ...current, enabled: event.target.checked })} />
            Enable automatic comfort range
          </label>
          <div className="flex flex-wrap gap-3">
            {(['minF', 'maxF'] as const).map(key => (
              <label key={key} className="flex flex-col gap-1 text-sm">
                {key === 'minF' ? 'Minimum (°F)' : 'Maximum (°F)'}
                <input className="w-28 rounded-ctl border border-line-2 bg-transparent px-3 py-2" type="number" min="55" max="110" step="1" value={current[key]} onChange={event => setDraft({ ...current, [key]: event.target.value })} />
              </label>
            ))}
          </div>
          <p className="text-sm text-fg-2">Choose a range up to 10°F wide. Saving applies it to automatic targets on a powered side; it does not turn the bed on or enable personal learning.</p>
          {(!parsed?.success || staleDraft) && <p role="alert" className="text-sm text-danger">{staleDraft ? 'The saved limit or sleeper arrangement changed. Cancel and reopen the editor.' : 'Enter both temperatures between 55 and 110°F, with minimum ≤ maximum and a range no wider than 10°F.'}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="rounded-ctl bg-fg px-3 py-2 text-sm text-inverse disabled:opacity-40" disabled={!parsed?.success || !!staleDraft || query.isError || save.isPending || !!save.error}>Save comfort range</button>
            <button type="button" className="rounded-ctl border border-line-2 px-3 py-2 text-sm" disabled={save.isPending} onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  )
}
