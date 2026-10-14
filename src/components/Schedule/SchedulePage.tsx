'use client'

import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, InlineError, PageHeader, SectionLabel, SegmentedControl, Skeleton, StatusDot } from '@/src/components/ds'
import { useSchedule } from '@/src/hooks/useSchedule'
import { useScheduleActive } from '@/src/hooks/useScheduleActive'
import { useSide } from '@/src/providers/SideProvider'
import type { Side, SideSelection } from '@/src/providers/SideProvider'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useCurveTemplates, type SavedCurve } from '@/src/hooks/useCurveTemplates'
import { activeCurveOn, type CurveDays, type DayMove, hasDays, planClaims } from '@/src/lib/scheduleLibrary'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatSetpointF } from '@/src/lib/tempUtils'
import { groupDaysBySharedCurve } from '@/src/lib/scheduleGrouping'
import type { ScheduleGroup } from '@/src/lib/scheduleGrouping'
import { getCurrentDay, type DayOfWeek } from '@/src/lib/scheduleTime'
import { BothNightView, PersonCurveList } from './BothNightView'
import { bedTrace, lastNightLabel, lastNightMidnight, lastNightRange } from './bedTrace'
import { nextSetPoint, type TempRow } from './bothNight'
import { CurveCard } from './CurveCard'
import { useNowMinute } from './CurveChart'
import { CurveEditor } from './CurveEditor'
import { curveDaysLabel, describeMoves, SavedCurveCard, templateSetPoints } from './SavedCurveCard'
import { ConfirmDialog } from './ConfirmDialog'
import { ScheduleToggle } from './ScheduleToggle'
import { SchedulerConfirmation } from './SchedulerConfirmation'
import { AlarmSection } from './AlarmSection'
import { curveSlug, formatDayRange, parseCurveSlug, sameDays } from './scheduleFormat'

interface EditingCurve {
  days: DayOfWeek[]
  endAction?: 'turn_off' | 'maintain'
  setPoints: Array<{ time: string, temperature: number }>
  notes?: string
  /** Set when editing a curve in the library. */
  id?: number
  name?: string
  active?: boolean
  curveDays?: CurveDays
}

interface SchedulePageProps {
  /**
   * /schedule/<curve>: 'new', a library curve's id ('12'), or the days of a
   * schedule ('mon-tue-wed', which opens the library curve running them);
   * opens the editor.
   */
  curve?: string
  /** ?side= on a curve link: the side (or both) the curve belongs to. */
  curveSide?: SideSelection
  /** ?from=both: the editor was opened from the Both view and returns to it. */
  fromBoth?: boolean
}

/**
 * Schedule screen: the curve running today as a large chart, the other
 * curves (groups of days sharing a temperature schedule) below, and alarms
 * in the context column. Creating/editing a curve swaps in `CurveEditor`
 * at its own URL (/schedule/new, /schedule/mon-tue-wed?side=left), so a
 * curve can be linked to directly.
 */
export function SchedulePage({ curve, curveSide, fromBoth = false }: SchedulePageProps = {}) {
  // Focus one source only when the unused zone has no independent schedule.
  const { primarySide, selectedSide: chosenSide, selectSide, singleScheduleSide } = useSide()
  const side = singleScheduleSide ?? primarySide
  const selectedSide = singleScheduleSide ?? chosenSide
  const {
    confirmMessage,
    isPowerEnabled,
    isGlobalEnabled,
    isApplying,
    isMutating,
    toggleGlobalSchedules,
    deleteCurve,
    setSelectedDays,
    isLoading: hookLoading,
  } = useSchedule()

  const { data: settings, isLoading: settingsLoading } = trpc.settings.getAll.useQuery({})
  const { nextEvent } = useScheduleActive()
  const { leftName, rightName } = useSideNames()
  const { data, isLoading, error } = trpc.schedules.getAll.useQuery({ side })
  const { data: notesData, isLoading: notesLoading } = trpc.schedules.getNotes.useQuery({ side })
  // A curve's days normally share one note; show the first one set.
  const notesFor = (days: DayOfWeek[]) => days.map(d => notesData?.find(n => n.dayOfWeek === d)?.notes).find(Boolean)
  const both = selectedSide === 'both'
  const otherSide: Side = side === 'left' ? 'right' : 'left'
  const other = trpc.schedules.getAll.useQuery({ side: otherSide }, { enabled: both })
  const bothPower = { [side]: data?.power, [otherSide]: other.data?.power }
  const bothTemps = { [side]: data?.temperature, [otherSide]: other.data?.temperature } as Record<Side, TempRow[] | undefined>
  const names: Record<Side, string> = { left: leftName, right: rightName }
  const nowMinute = useNowMinute()
  const saved = useCurveTemplates()
  const [pendingSavedDelete, setPendingSavedDelete] = useState<SavedCurve | null>(null)
  const [pendingToggle, setPendingToggle] = useState<{ curve: SavedCurve, moves: DayMove[] } | null>(null)
  const [libraryError, setLibraryError] = useState<string | null>(null)

  // Last night's measured bed temperature for the featured chart.
  const now = nowMinute === null ? null : new Date(nowMinute * 60_000)
  const history = trpc.health.thermalHistory.useQuery(
    { range: now ? lastNightRange(now) : '24h' },
    { enabled: !both && now !== null, staleTime: 60_000, refetchInterval: 5 * 60_000 },
  )
  const bed = now
    ? { samples: bedTrace(history.data?.points, side, lastNightMidnight(now)), label: lastNightLabel(now) }
    : undefined

  const router = useRouter()
  const pathname = usePathname()
  const schedulePath = `/${pathname?.split('/')[1] || 'en'}/schedule`
  // A curve link names its side; select it before the editor reads that side's rows.
  const wantSide = curve && !singleScheduleSide ? curveSide : undefined
  useEffect(() => {
    if (wantSide && chosenSide !== wantSide) selectSide(wantSide)
  }, [wantSide, chosenSide, selectSide])
  // Opened from Both: leaving the editor (close, save or browser Back) returns
  // to Both. On unmount, so the side sync above can't undo it mid-navigation.
  useEffect(() => {
    if (!curve || !fromBoth) return
    return () => selectSide('both')
  }, [curve, fromBoth, selectSide])
  // The curve the editor opened on: a refetch that regroups the days (another
  // client edited them) must not unmount the editor and lose its draft.
  const [openedCurve, setOpenedCurve] = useState<{ key: string, editor: EditingCurve } | null>(null)

  const [pendingDelete, setPendingDelete] = useState<{ days: DayOfWeek[], label: string } | null>(null)
  // Deleting one person's curve from the Both view narrows to that side
  // (edits in Both write to both sides), then returns to Both afterwards.
  const [returnToBoth, setReturnToBoth] = useState(false)
  const restoreBoth = () => {
    if (returnToBoth) selectSide('both')
    setReturnToBoth(false)
  }

  // Recompute each render — React Compiler's lint (react-hooks/
  // preserve-manual-memoization) objects to the previous useMemo here
  // because it can't match the manual memo to its own plan. The
  // computation is cheap relative to the tRPC fetch that precedes it.
  const groups: ScheduleGroup[] = data?.temperature
    ? groupDaysBySharedCurve(data.temperature, data.power)
    : []

  // Curves to render: ones with set points OR explicitly paused
  const visibleGroups = groups.filter(g => g.setPoints.length > 0 || g.allDisabled)
  const hasAnyCurves = visibleGroups.length > 0
    || (both && (other.data?.temperature.length ?? 0) > 0)

  // The "active" curve = the one whose days include today; gets the
  // next-event annotation since that's what's actually running.
  const activeCurveKey = useMemo(() => {
    if (!isPowerEnabled) return null
    const today = getCurrentDay()
    return visibleGroups.find(g => g.days.includes(today) && g.setPoints.length > 0)?.key ?? null
  }, [visibleGroups, isPowerEnabled])

  // Large chart card: today's curve, else the first curve with set points.
  const featured = visibleGroups.find(g => g.key === activeCurveKey)
    ?? visibleGroups.find(g => g.setPoints.length > 0 && !g.allDisabled)
    ?? null
  // The library curve running a schedule's days on a side, if any.
  const ownerOf = (s: Side, group: ScheduleGroup) => activeCurveOn(saved.templates, s, group.days[0])
  const featuredOwner = featured ? ownerOf(side, featured) : undefined
  // Schedules not in the library (rows written one at a time through the API).
  const others = visibleGroups.filter(g => g !== featured && !ownerOf(side, g))
  const viewSides: Side[] = both ? ['left', 'right'] : [side]
  // Library curves for this view: ones with days on a shown side, or no days at all.
  const libraryCurves = saved.templates
    .filter(t => !hasDays(t.days) || viewSides.some(s => t.days[s].length > 0))
    .sort((a, b) => Number(b.active) - Number(a.active))

  const curveHref = useCallback((slug: string, linkSide: SideSelection | null, from?: 'both') => {
    const params = new URLSearchParams()
    if (linkSide) params.set('side', linkSide)
    if (from) params.set('from', from)
    const qs = params.toString()
    return `${schedulePath}/${slug}${qs ? `?${qs}` : ''}`
  }, [schedulePath])

  const handleEdit = useCallback((group: ScheduleGroup) => {
    setSelectedDays(new Set(group.days))
    const owner = activeCurveOn(saved.templates, side, group.days[0])
    router.push(curveHref(owner ? String(owner.id) : curveSlug(group.days), singleScheduleSide ? null : side))
  }, [router, curveHref, setSelectedDays, singleScheduleSide, side, saved.templates])

  const handleCreate = useCallback(() => {
    router.push(curveHref('new', singleScheduleSide ? null : selectedSide))
  }, [router, curveHref, singleScheduleSide, selectedSide])

  // A curve running one side only opens on that side, so saving it from the Both view can't copy it to the other.
  const openCurve = useCallback((t: SavedCurve) => {
    const only = t.days.left.length > 0 && t.days.right.length === 0
      ? 'left'
      : t.days.right.length > 0 && t.days.left.length === 0
        ? 'right'
        : selectedSide
    router.push(curveHref(String(t.id), singleScheduleSide ? null : only, both && only !== 'both' ? 'both' : undefined))
  }, [router, curveHref, singleScheduleSide, selectedSide, both])

  const runToggle = async (t: SavedCurve, next: boolean) => {
    setLibraryError(null)
    try {
      await saved.setActive(t.id, next)
    }
    catch (err) {
      setLibraryError(err instanceof Error ? err.message : `Failed to turn ${next ? 'on' : 'off'} ${t.name}`)
    }
    finally {
      setPendingToggle(null)
    }
  }

  // Turning a curve on moves days other active curves run on; ask first. A
  // curve without days opens in the editor to pick them.
  const toggleCurve = (t: SavedCurve, next: boolean) => {
    if (next && !hasDays(t.days)) {
      openCurve(t)
      return
    }
    const moves = next ? planClaims(saved.templates, t.id, t.days, true).moves : []
    if (moves.length > 0) setPendingToggle({ curve: t, moves })
    else void runToggle(t, next)
  }

  const handleDelete = useCallback((group: ScheduleGroup) => {
    setPendingDelete({ days: group.days, label: deleteLabel(group.days) })
  }, [setPendingDelete])

  const confirmDelete = async () => {
    if (!pendingDelete) return
    try {
      await deleteCurve(pendingDelete.days)
    }
    finally {
      setPendingDelete(null)
      restoreBoth()
    }
  }

  const editFor = (s: Side, group: ScheduleGroup) => {
    const owner = ownerOf(s, group)
    router.push(curveHref(owner ? String(owner.id) : curveSlug(group.days), s, 'both'))
  }

  const deleteFor = (s: Side, group: ScheduleGroup) => {
    setReturnToBoth(true)
    selectSide(s)
    setPendingDelete({ days: group.days, label: `${names[s]}'s ${deleteLabel(group.days)}` })
  }

  if (curve) {
    const closeEditor = () => router.push(schedulePath)
    const curveId = /^\d+$/.test(curve) ? Number(curve) : null
    const linkedDays = curve === 'new' || curveId !== null ? null : parseCurveSlug(curve)
    const group = linkedDays ? visibleGroups.find(g => sameDays(g.days, linkedDays)) : undefined
    const owned = curveId !== null
      ? saved.templates.find(t => t.id === curveId)
      : linkedDays?.[0] ? activeCurveOn(saved.templates, side, linkedDays[0]) : undefined
    const sideReady = !wantSide || chosenSide === wantSide
    // The editor keeps its first notes, so an existing curve waits for them; saving an unloaded note would clear it.
    if (!sideReady || (curve === 'new' ? settingsLoading || saved.isLoading : saved.isLoading || (isLoading && !data) || notesLoading)) {
      return <Skeleton className="h-[520px]" />
    }
    const editorKey = `${curve}:${side}`
    const found: EditingCurve | null = curve === 'new'
      ? { days: [], setPoints: [], endAction: settings?.device.defaultScheduleEndAction ?? 'turn_off' }
      : owned
        ? {
            id: owned.id,
            name: owned.name,
            active: owned.active,
            curveDays: owned.days,
            days: [...new Set(viewSides.flatMap(s => owned.days[s]))],
            setPoints: templateSetPoints(owned),
            endAction: owned.endAction,
            notes: owned.notes,
          }
        : group ? { days: group.days, setPoints: group.setPoints, endAction: group.endAction, notes: notesFor(group.days) } : null
    if (found && openedCurve?.key !== editorKey) setOpenedCurve({ key: editorKey, editor: found })
    const editor = openedCurve?.key === editorKey ? openedCurve.editor : found
    if (!editor) {
      return (
        <>
          <PageHeader back="Schedule" onBack={closeEditor} title="Curve not found" />
          <Card>
            <InlineError>
              {error
                ? `Failed to load schedules: ${error.message}`
                : curveId !== null
                  ? 'That curve is no longer in the library. It may have been deleted.'
                  : linkedDays
                    ? `No curve runs on exactly ${formatDayRange(linkedDays)}. It may have been changed or deleted.`
                    : `"${curve}" isn't a curve.`}
            </InlineError>
          </Card>
        </>
      )
    }
    return (
      <CurveEditor
        key={editorKey}
        onClose={closeEditor}
        initialEndAction={editor.endAction}
        initialDays={editor.days}
        initialSetPoints={editor.setPoints}
        initialNotes={editor.notes}
        curveId={editor.id}
        initialName={editor.name}
        initialActive={editor.active}
        curveDays={editor.curveDays}
      />
    )
  }

  const sideOptions: Array<{ value: SideSelection, label: string }> = [
    { value: 'left', label: leftName },
    { value: 'right', label: rightName },
    { value: 'both', label: 'Both' },
  ]
  const sideLabel = selectedSide === 'both' ? `${leftName} and ${rightName}` : selectedSide === 'left' ? leftName : rightName

  // Both view: the soonest set point across the two sides, and whose it is.
  let next: { name: string, at: Date, time: string, temperature: number } | null = null
  if (both && now) {
    for (const s of ['left', 'right'] as const) {
      const n = nextSetPoint(bothTemps[s], now)
      if (n && (!next || n.at < next.at)) next = { name: names[s], ...n }
    }
  }

  return (
    <>
      <PageHeader
        title="Schedule"
        middle={singleScheduleSide
          ? undefined
          : (
              <div className="hidden min-[900px]:block">
                <SegmentedControl ariaLabel="Side" options={sideOptions} value={selectedSide} onChange={selectSide} />
              </div>
            )}
        right={(
          <>
            <ScheduleToggle
              enabled={isGlobalEnabled}
              onToggle={() => void toggleGlobalSchedules()}
              isLoading={isMutating || hookLoading}
            />
            <Button icon={Plus} onClick={handleCreate} className="hidden min-[900px]:inline-flex">
              New curve
            </Button>
          </>
        )}
      />

      {!singleScheduleSide && (
        <SegmentedControl
          full
          ariaLabel="Side"
          className="min-[900px]:hidden"
          options={sideOptions}
          value={selectedSide}
          onChange={selectSide}
        />
      )}

      <SchedulerConfirmation
        message={confirmMessage}
        isLoading={isApplying}
        variant={confirmMessage?.includes('Failed') ? 'error' : 'success'}
      />

      <div className="grid gap-3.5 min-[900px]:gap-4 @min-[960px]:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-3.5 min-[900px]:gap-4">
          {error && (
            <Card>
              <InlineError>
                Failed to load schedules:
                {' '}
                {error.message}
              </InlineError>
            </Card>
          )}

          {isLoading && !data && <Skeleton className="h-[140px] min-[900px]:h-[380px]" />}

          {!isLoading && !error && !hasAnyCurves && libraryCurves.length === 0 && (
            <Card dashed className="items-center py-8 text-center">
              <span className="text-[15px] font-medium">No schedule yet</span>
              <span className="text-[13px] text-fg-2">
                Create a sleep curve to automatically control bed temperature
              </span>
              <Button variant="primary" icon={Plus} onClick={handleCreate}>
                Create sleep curve
              </Button>
            </Card>
          )}

          {both && hasAnyCurves && (
            <>
              <BothNightView temps={bothTemps} power={bothPower} names={names} />
              <PersonCurveList temps={bothTemps} power={bothPower} names={names} onEdit={editFor} onDelete={deleteFor} />
            </>
          )}

          {!both && featured && (
            <CurveCard
              featured
              group={featured}
              onEdit={() => handleEdit(featured)}
              onDelete={() => handleDelete(featured)}
              isActive={featured.key === activeCurveKey}
              nextEvent={featured.key === activeCurveKey ? nextEvent : null}
              bed={bed}
              notes={notesFor(featured.days)}
              name={featuredOwner?.name}
            />
          )}

          {!both && others.length > 0 && (
            <div className="grid gap-3.5 min-[900px]:grid-cols-3 min-[900px]:gap-3">
              {others.map(group => (
                <CurveCard
                  key={group.key}
                  group={group}
                  notes={notesFor(group.days)}
                  onEdit={() => handleEdit(group)}
                  onDelete={() => handleDelete(group)}
                  unsaved
                />
              ))}
            </div>
          )}

          {(hasAnyCurves || libraryCurves.length > 0) && (
            <>
              <SectionLabel className="mt-1">Curves</SectionLabel>
              {libraryError && <InlineError>{libraryError}</InlineError>}
              <div className="grid gap-3.5 min-[900px]:grid-cols-3 min-[900px]:gap-3">
                {libraryCurves.map(t => (
                  <SavedCurveCard
                    key={t.id}
                    template={t}
                    daysLabel={curveDaysLabel(t, viewSides, names)}
                    busy={saved.isChanging}
                    onOpen={() => openCurve(t)}
                    onToggle={next => toggleCurve(t, next)}
                    onDelete={() => setPendingSavedDelete(t)}
                  />
                ))}
                <Button
                  variant="dashed"
                  icon={Plus}
                  onClick={handleCreate}
                  className="h-11 rounded-card text-sm min-[900px]:h-auto min-[900px]:min-h-[108px] min-[900px]:text-[13px]"
                >
                  Create curve
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <AlarmSection side={side} selectedSide={selectedSide} />
          <SchedulerStatus sideLabel={sideLabel} next={next} />
        </div>
      </div>

      <ConfirmDialog
        open={pendingSavedDelete !== null}
        title="Delete curve?"
        message={pendingSavedDelete?.active
          ? `"${pendingSavedDelete.name}" will be removed and stop running on ${curveDaysLabel(pendingSavedDelete, ['left', 'right'], names)}. The Pod won't change temperature on those days until another curve runs on them.`
          : `"${pendingSavedDelete?.name ?? ''}" will be removed from your curves.`}
        confirmLabel="Delete"
        variant="danger"
        busy={saved.isDeleting}
        onConfirm={() => {
          if (pendingSavedDelete) void saved.remove(pendingSavedDelete.name).finally(() => setPendingSavedDelete(null))
        }}
        onCancel={() => setPendingSavedDelete(null)}
      />

      <ConfirmDialog
        open={pendingToggle !== null}
        title="Move days to this curve?"
        message={pendingToggle ? `${describeMoves(pendingToggle.moves, names, viewSides)}. Turn on ${pendingToggle.curve.name}?` : ''}
        confirmLabel={saved.isChanging ? 'Turning on…' : 'Move & turn on'}
        busy={saved.isChanging}
        onConfirm={() => {
          if (pendingToggle) void runToggle(pendingToggle.curve, true)
        }}
        onCancel={() => setPendingToggle(null)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete curve?"
        message={`This will remove the schedule for ${pendingDelete?.label ?? ''}. The Pod won't change temperature on those days until you create a new curve.`}
        confirmLabel="Delete"
        variant="danger"
        busy={isMutating}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          setPendingDelete(null)
          restoreBoth()
        }}
      />
    </>
  )
}

function deleteLabel(days: DayOfWeek[]): string {
  return days.length === 7 ? 'every day' : days.length === 1 ? days[0] : `${days.length} days`
}

/** Footer: scheduler drift status from health.system (shared with the sidebar's query). */
function SchedulerStatus({ sideLabel, next }: { sideLabel: string, next?: { name: string, time: string, temperature: number } | null }) {
  const { formatTime } = useTimeFormatter()
  const { data } = trpc.health.system.useQuery({}, { staleTime: 10_000, refetchInterval: 30_000 })
  const { unit } = useTemperatureUnit()
  const scheduler = data?.scheduler
  const drifted = scheduler?.drift?.drifted ?? false

  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-3 font-mono text-xs text-fg-2 @min-[960px]:mt-auto">
      {scheduler && (
        <div className="flex items-center gap-2">
          <StatusDot tone={!scheduler.enabled ? 'muted' : drifted ? 'warn' : 'ok'} />
          {!scheduler.enabled
            ? 'Scheduler off'
            : `Scheduler ${drifted ? 'out of sync' : 'in sync'} · ${scheduler.jobCount} job${scheduler.jobCount === 1 ? '' : 's'}`}
        </div>
      )}
      {next && (
        <div>
          {'Next: '}
          <span className="text-fg">{next.name}</span>
          {' → '}
          <span className="text-fg">{formatSetpointF(next.temperature, unit)}</span>
          {` at ${formatTime(next.time)}`}
        </div>
      )}
      <div>{`Applies to ${sideLabel} · edits apply on save`}</div>
    </div>
  )
}
