'use client'

import { useState, useEffect, useCallback } from 'react'
import { Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, Modal, Slider, Stepper } from '@/src/components/ds'
import { TimeInput } from './TimeInput'
import type { EditorSetPoint } from './SetPointCard'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { displayToSetpointF, setpointFToDisplay } from '@/src/lib/tempUtils'
import { TONE_TEXT, tempTone } from './scheduleFormat'

interface SetPointEditorProps {
  /** Point to edit, or null for create mode */
  editingPoint: EditorSetPoint | null
  /** Whether the editor is visible */
  open: boolean
  /** Close the editor */
  onClose: () => void
  /** Called with (time, temperature °F) for creation */
  onCreate: (time: string, temperature: number) => void
  /** Called with (id, { time, temperature }) for updates */
  onUpdate: (id: number, updates: { time?: string, temperature?: number }) => void
  /** Called with (id) for deletion */
  onDelete: (id: number) => void
}

const MIN_TEMP = 55
const MAX_TEMP = 110
const DEFAULT_TEMP = 78
const DEFAULT_TIME = '22:00'

/**
 * Dialog/sheet for creating or editing a single set point: time plus
 * temperature (stepper + slider in the user's unit, stored as °F).
 */
export function SetPointEditor({
  editingPoint,
  open,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: SetPointEditorProps) {
  const isEditing = editingPoint !== null
  const { unit } = useTemperatureUnit()
  const minDisplayTemp = Math.round(setpointFToDisplay(MIN_TEMP, unit) ?? MIN_TEMP)
  const maxDisplayTemp = Math.round(setpointFToDisplay(MAX_TEMP, unit) ?? MAX_TEMP)
  const defaultDisplayTemp = Math.round(setpointFToDisplay(DEFAULT_TEMP, unit) ?? DEFAULT_TEMP)

  const [time, setTime] = useState(DEFAULT_TIME)
  const [displayTemperature, setDisplayTemperature] = useState(defaultDisplayTemp)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Sync form state when the edited point changes
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (editingPoint) {
      setTime(editingPoint.time)
      setDisplayTemperature(Math.round(setpointFToDisplay(editingPoint.temperature, unit) ?? editingPoint.temperature))
    }
    else {
      setTime(DEFAULT_TIME)
      setDisplayTemperature(defaultDisplayTemp)
    }
    setShowDeleteConfirm(false)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [editingPoint, open, unit, defaultDisplayTemp])

  const temperatureF = Math.round(displayToSetpointF(displayTemperature, unit) ?? DEFAULT_TEMP)

  const handleSave = useCallback(() => {
    if (isEditing && editingPoint) {
      const updates: { time?: string, temperature?: number } = {}
      if (time !== editingPoint.time) updates.time = time
      if (temperatureF !== editingPoint.temperature) updates.temperature = temperatureF
      // Only call update if something changed
      if (Object.keys(updates).length > 0) {
        onUpdate(editingPoint.id, updates)
      }
    }
    else {
      onCreate(time, temperatureF)
    }
    onClose()
  }, [isEditing, editingPoint, time, temperatureF, onCreate, onUpdate, onClose])

  const handleDelete = useCallback(() => {
    if (editingPoint) {
      onDelete(editingPoint.id)
      onClose()
    }
  }, [editingPoint, onDelete, onClose])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEditing ? 'Edit set point' : 'Add set point'}
      width={480}
      footer={(
        <>
          {isEditing && (
            <Button
              variant="danger"
              icon={Trash2}
              onClick={() => (showDeleteConfirm ? handleDelete() : setShowDeleteConfirm(true))}
            >
              {showDeleteConfirm ? 'Confirm delete' : 'Delete'}
            </Button>
          )}
          <div className="ml-auto flex gap-2.5">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={handleSave}>
              {isEditing ? 'Save' : 'Add set point'}
            </Button>
          </div>
        </>
      )}
    >
      <TimeInput label="Time" value={time} onChange={setTime} />

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        <div className="flex items-center gap-3">
          <span className="flex-1 text-sm">Temperature</span>
          <span className={cn('font-mono text-2xl font-light', TONE_TEXT[tempTone(temperatureF)])}>
            {`${displayTemperature}°${unit}`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Slider
            value={displayTemperature}
            onChange={setDisplayTemperature}
            min={minDisplayTemp}
            max={maxDisplayTemp}
            label="Temperature slider"
          />
          <Stepper
            value={displayTemperature}
            onChange={setDisplayTemperature}
            min={minDisplayTemp}
            max={maxDisplayTemp}
            label="temperature"
          />
        </div>
      </div>
    </Modal>
  )
}
