'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { trpc } from '@/src/utils/trpc'
import type { GeneratedCurve } from '@/src/lib/sleepCurve/curvePrompt'
import { loadTemplates, removeLocalTemplates } from '@/src/lib/sleepCurve/curvePrompt'
import { CURVE_NOTES_MAX } from '@/src/lib/sleepCurve/savePlan'
import type { CurveDays } from '@/src/lib/scheduleLibrary'
import type { inferRouterInputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'

/** A curve in the schedule library as the Schedule screen shows it; set points are °F. */
export interface SavedCurve {
  id: number
  name: string
  bedtime: string
  wake: string
  points: Record<string, number>
  notes: string
  endAction: 'turn_off' | 'maintain'
  /** Days it runs on per side while active. */
  days: CurveDays
  active: boolean
  createdAt: number
}

/**
 * The schedule library, stored on the pod so every browser and the MCP server
 * see the same list. Changing a curve's days or active flag rewrites the
 * schedule, so schedules and notes are refetched too. Curves saved by older
 * versions live in this browser's localStorage; the first successful load
 * moves them to the pod.
 */
export function useCurveTemplates(enabled = true) {
  const utils = trpc.useUtils()
  const query = trpc.curveTemplates.list.useQuery({}, { enabled })
  const invalidate = () => Promise.all([
    utils.curveTemplates.list.invalidate(),
    utils.schedules.getAll.invalidate(),
    utils.schedules.getByDay.invalidate(),
    utils.schedules.getNotes.invalidate(),
  ])
  const saveMutation = trpc.curveTemplates.save.useMutation({ onSuccess: invalidate })
  const putMutation = trpc.curveTemplates.put.useMutation({ onSuccess: invalidate })
  const activeMutation = trpc.curveTemplates.setActive.useMutation({ onSuccess: invalidate })
  const deleteMutation = trpc.curveTemplates.delete.useMutation({ onSuccess: invalidate })
  const { mutateAsync: saveAsync } = saveMutation

  const migrated = useRef(false)
  useEffect(() => {
    if (!enabled || !query.data || migrated.current) return
    migrated.current = true
    const onPod = new Set(query.data.map(t => t.name))
    const local = loadTemplates()
    if (local.length === 0) return
    const toMove = local.filter(t => !onPod.has(t.name.trim()))
    void Promise.allSettled(toMove.map(t => saveAsync({
      name: t.name, bedtime: t.bedtime, wake: t.wake, points: t.points, notes: t.reasoning.slice(0, CURVE_NOTES_MAX),
    }))).then((results) => {
      // Drop the ones the pod already has or just accepted; keep any it rejected.
      const rejected = new Set(toMove.filter((_, i) => results[i].status === 'rejected').map(t => t.name))
      removeLocalTemplates(local.map(t => t.name).filter(name => !rejected.has(name)))
    })
  }, [enabled, query.data, saveAsync])

  const templates = useMemo<SavedCurve[]>(
    () => (query.data ?? []).map(t => ({
      id: t.id,
      name: t.name,
      bedtime: t.bedtime,
      wake: t.wake,
      points: t.points,
      notes: t.notes,
      endAction: t.endAction,
      days: t.days,
      active: t.active,
      createdAt: t.createdAt.getTime(),
    })),
    [query.data],
  )

  // A wizard curve's reasoning becomes the saved curve's notes; the AI's text has no length limit of its own.
  const save = useCallback((curve: GeneratedCurve) => saveAsync({
    name: curve.name, bedtime: curve.bedtime, wake: curve.wake, points: curve.points, notes: curve.reasoning.slice(0, CURVE_NOTES_MAX),
  }), [saveAsync])

  const { mutateAsync: deleteAsync } = deleteMutation
  const remove = useCallback((name: string) => deleteAsync({ name }), [deleteAsync])

  const { mutateAsync: putAsync } = putMutation
  const put = useCallback((curve: inferRouterInputs<AppRouter>['curveTemplates']['put']) => putAsync(curve), [putAsync])

  const { mutateAsync: activeAsync } = activeMutation
  const setActive = useCallback((id: number, active: boolean) => activeAsync({ id, active }), [activeAsync])

  return {
    templates,
    save,
    put,
    setActive,
    remove,
    isLoading: query.isLoading,
    isSaving: saveMutation.isPending || putMutation.isPending,
    isChanging: activeMutation.isPending,
    isDeleting: deleteMutation.isPending,
  }
}
