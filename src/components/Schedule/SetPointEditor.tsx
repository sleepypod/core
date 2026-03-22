'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, Minus, Plus, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { TimeInput } from './TimeInput'
import type { SchedulePhase } from '@/src/hooks/useSchedules'

interface SetPointEditorProps {
  /** Phase to edit, or null for create mode */
  editingPhase: SchedulePhase | null
  /** Whether the editor is visible */
  open: boolean
  /** Close the editor */
  onClose: () => void
  /** Called with (time, temperature) for creation */
  onCreate: (time: string, temperature: number) => void
  /** Called with (id, { time, temperature, enabled }) for updates */
  onUpdate: (id: number, updates: { time?: string, temperature?: number, enabled?: boolean }) => void
  /** Called with (id) for deletion */
  onDelete: (id: number) => void
}

const MIN_TEMP = 55
const MAX_TEMP = 110
const DEFAULT_TEMP = 78
const DEFAULT_TIME = '22:00'

/**
 * Bottom sheet editor for creating or editing a temperature set point.
 * Shows time picker, temperature slider with +/- buttons, enable toggle,
 * and save/delete actions.
 */
export function SetPointEditor({
  editingPhase,
  open,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: SetPointEditorProps) {
  const isEditing = editingPhase !== null

  const [time, setTime] = useState(DEFAULT_TIME)
  const [temperature, setTemperature] = useState(DEFAULT_TEMP)
  const [enabled, setEnabled] = useState(true)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Sync form state when editingPhase changes
  useEffect(() => {
    if (editingPhase) {
      setTime(editingPhase.time)
      setTemperature(editingPhase.temperature)
      setEnabled(editingPhase.enabled)
    }
    else {
      setTime(DEFAULT_TIME)
      setTemperature(DEFAULT_TEMP)
      setEnabled(true)
    }
    setShowDeleteConfirm(false)
  }, [editingPhase, open])

  const handleSave = useCallback(() => {
    if (isEditing && editingPhase) {
      const updates: { time?: string, temperature?: number, enabled?: boolean } = {}
      if (time !== editingPhase.time) updates.time = time
      if (temperature !== editingPhase.temperature) updates.temperature = temperature
      if (enabled !== editingPhase.enabled) updates.enabled = enabled
      // Only call update if something changed
      if (Object.keys(updates).length > 0) {
        onUpdate(editingPhase.id, updates)
      }
    }
    else {
      onCreate(time, temperature)
    }
    onClose()
  }, [isEditing, editingPhase, time, temperature, enabled, onCreate, onUpdate, onClose])

  const handleDelete = useCallback(() => {
    if (editingPhase) {
      onDelete(editingPhase.id)
      onClose()
    }
  }, [editingPhase, onDelete, onClose])

  const adjustTemp = (delta: number) => {
    setTemperature(prev => Math.max(MIN_TEMP, Math.min(MAX_TEMP, prev + delta)))
  }

  // Temperature color
  const tempColor
    = temperature <= 74
      ? 'text-sky-400'
      : temperature <= 80
        ? 'text-zinc-300'
        : 'text-amber-400'

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/60"
        onClick={onClose}
      />

      {/* Bottom sheet */}
      <div className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-zinc-900 px-4 pb-6 pt-3 shadow-xl sm:px-5 sm:pb-8 sm:pt-4">
        {/* Handle + close */}
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">
            {isEditing ? `Edit ${editingPhase?.name ?? 'Set Point'}` : 'Add Set Point'}
          </h3>
          <button
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800 text-zinc-400 active:bg-zinc-700"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Time input */}
        <div className="mb-5">
          <TimeInput
            label="Time"
            value={time}
            onChange={setTime}
          />
        </div>

        {/* Temperature control */}
        <div className="mb-5">
          <label className="mb-2 block text-xs font-medium text-zinc-400">
            Temperature
          </label>
          <div className="flex items-center justify-center gap-4">
            <button
              onClick={() => adjustTemp(-2)}
              disabled={temperature <= MIN_TEMP}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 transition-colors active:bg-zinc-700 disabled:opacity-30"
              aria-label="Decrease temperature"
            >
              <Minus size={18} />
            </button>

            <div className="flex flex-col items-center">
              <span className={clsx('text-4xl font-bold tabular-nums', tempColor)}>
                {temperature}
                °F
              </span>
              <span className="mt-1 text-[10px] text-zinc-600">
                {MIN_TEMP}
                ° –
                {MAX_TEMP}
                °
              </span>
            </div>

            <button
              onClick={() => adjustTemp(2)}
              disabled={temperature >= MAX_TEMP}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 transition-colors active:bg-zinc-700 disabled:opacity-30"
              aria-label="Increase temperature"
            >
              <Plus size={18} />
            </button>
          </div>

          {/* Temperature slider for quick adjustment */}
          <div className="mt-3 px-2">
            <input
              type="range"
              min={MIN_TEMP}
              max={MAX_TEMP}
              step={1}
              value={temperature}
              onChange={e => setTemperature(Number(e.target.value))}
              className="w-full accent-sky-500"
              aria-label="Temperature slider"
            />
          </div>
        </div>

        {/* Enable toggle (edit mode only) */}
        {isEditing && (
          <div className="mb-5 flex items-center justify-between rounded-xl bg-zinc-800/50 px-4 py-3">
            <span className="text-sm text-zinc-300">Enabled</span>
            <button
              onClick={() => setEnabled(!enabled)}
              className="flex min-h-[44px] min-w-[48px] items-center justify-center"
              role="switch"
              aria-checked={enabled}
            >
              <span className={clsx(
                'relative h-7 w-12 rounded-full transition-colors',
                enabled ? 'bg-sky-500' : 'bg-zinc-700'
              )}
              >
                <span
                  className={clsx(
                    'absolute top-0.5 h-6 w-6 rounded-full bg-white transition-transform',
                    enabled ? 'translate-x-5' : 'translate-x-0.5'
                  )}
                />
              </span>
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          {isEditing && (
            <button
              onClick={() => {
                if (showDeleteConfirm) {
                  handleDelete()
                }
                else {
                  setShowDeleteConfirm(true)
                }
              }}
              className={clsx(
                'flex h-12 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors',
                showDeleteConfirm
                  ? 'bg-red-500/20 text-red-400'
                  : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700'
              )}
            >
              <Trash2 size={16} />
              {showDeleteConfirm ? 'Confirm Delete' : 'Delete'}
            </button>
          )}

          <button
            onClick={handleSave}
            className="flex h-12 flex-1 items-center justify-center rounded-xl bg-sky-500 text-sm font-semibold text-white transition-colors active:bg-sky-600"
          >
            {isEditing ? 'Save Changes' : 'Add Set Point'}
          </button>
        </div>
      </div>
    </>
  )
}
