'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { trpc } from '@/src/utils/trpc'
import type { GeneratedCurve } from '@/src/lib/sleepCurve/curvePrompt'
import { loadTemplates, removeLocalTemplates } from '@/src/lib/sleepCurve/curvePrompt'
import { CURVE_NOTES_MAX } from '@/src/lib/sleepCurve/savePlan'

/** A saved curve as the Schedule screen shows it; set points are °F. */
export interface SavedCurve {
  name: string
  bedtime: string
  wake: string
  points: Record<string, number>
  notes: string
  createdAt: number
}

/**
 * Saved curves, stored on the pod so every browser and the MCP server see the
 * same list. Curves saved by older versions live in this browser's
 * localStorage; the first successful load moves them to the pod.
 */
export function useCurveTemplates(enabled = true) {
  const utils = trpc.useUtils()
  const query = trpc.curveTemplates.list.useQuery({}, { enabled })
  const invalidate = () => utils.curveTemplates.list.invalidate()
  const saveMutation = trpc.curveTemplates.save.useMutation({ onSuccess: invalidate })
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
      name: t.name, bedtime: t.bedtime, wake: t.wake, points: t.points, notes: t.notes, createdAt: t.createdAt.getTime(),
    })),
    [query.data],
  )

  // A wizard curve's reasoning becomes the saved curve's notes; the AI's text has no length limit of its own.
  const save = useCallback((curve: GeneratedCurve) => saveAsync({
    name: curve.name, bedtime: curve.bedtime, wake: curve.wake, points: curve.points, notes: curve.reasoning.slice(0, CURVE_NOTES_MAX),
  }), [saveAsync])

  const { mutateAsync: deleteAsync } = deleteMutation
  const remove = useCallback((name: string) => deleteAsync({ name }), [deleteAsync])

  return { templates, save, remove, isLoading: query.isLoading, isSaving: saveMutation.isPending, isDeleting: deleteMutation.isPending }
}
