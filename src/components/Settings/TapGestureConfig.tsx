'use client'

import { useState, useCallback } from 'react'
import { Hand, Trash2 } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSideNames } from '@/src/hooks/useSideNames'
import { Button, Card, CardHeader, InlineError, Modal, SegmentedControl, SettingRow, Skeleton, Stepper, ValueChip } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { SectionColumns, SideTabs } from './SettingsLayout'

type TapType = 'doubleTap' | 'tripleTap' | 'quadTap'
type ActionType = 'temperature' | 'alarm'
type Side = 'left' | 'right'

interface GestureRecord {
  id: number
  side: Side
  tapType: TapType
  actionType: ActionType
  temperatureChange: 'increment' | 'decrement' | null
  temperatureAmount: number | null
  alarmBehavior: 'snooze' | 'dismiss' | null
  alarmSnoozeDuration: number | null
  alarmInactiveBehavior: 'power' | 'none' | null
}

const TAP_TYPES: { key: TapType, label: string, taps: number }[] = [
  { key: 'doubleTap', label: 'Double tap', taps: 2 },
  { key: 'tripleTap', label: 'Triple tap', taps: 3 },
  { key: 'quadTap', label: 'Quad tap', taps: 4 },
]

function temperatureLabel(g: GestureRecord): string {
  const dir = g.temperatureChange === 'increment' ? '+' : '−'
  return `Temperature ${dir}${g.temperatureAmount}°`
}

/** What the gesture does when no alarm is ringing. */
export function idleDescription(g: GestureRecord | undefined): string {
  if (!g) return 'Not set'
  if (g.actionType === 'temperature') return temperatureLabel(g)
  return g.alarmInactiveBehavior === 'power' ? 'Power on / off' : 'Nothing'
}

/**
 * What the gesture does while an alarm is ringing — its own setting for any
 * gesture (alarmBehavior); with none set the tap just stops the alarm, which
 * the firmware does on any tap.
 */
export function ringingDescription(g: GestureRecord | undefined): string {
  if (!g) return 'Not set'
  if (g.alarmBehavior === 'snooze') return 'Snooze'
  return 'Stop alarm'
}

/** The normal action: a temperature step, or (alarm-type rows) power toggle / nothing. */
type IdleAction = 'temperature' | 'power' | 'none'

interface EditState {
  side: Side
  tapType: TapType
  idle: IdleAction
  temperatureChange: 'increment' | 'decrement'
  temperatureAmount: number
  ringing: 'snooze' | 'dismiss'
}

// A new tap opened from the ringing column starts with no normal action, so
// saving only a ringing action doesn't also make it step the temperature.
const defaultEditState = (side: Side, tapType: TapType, fromRinging = false): EditState => ({
  side,
  tapType,
  idle: fromRinging ? 'none' : 'temperature',
  temperatureChange: 'increment',
  temperatureAmount: 2,
  ringing: 'dismiss',
})

function editStateFromGesture(g: GestureRecord): EditState {
  return {
    side: g.side,
    tapType: g.tapType,
    idle: g.actionType === 'temperature' ? 'temperature' : g.alarmInactiveBehavior === 'power' ? 'power' : 'none',
    temperatureChange: g.temperatureChange ?? 'increment',
    temperatureAmount: g.temperatureAmount ?? 2,
    ringing: g.alarmBehavior ?? 'dismiss',
  }
}

function TapDots({ taps }: { taps: number }) {
  return (
    <span className="flex gap-[3px]" aria-hidden>
      {[1, 2, 3, 4].map(i => (
        <span key={i} className={cn('size-1.5 rounded-full', i <= taps ? 'bg-fg' : 'bg-line-2')} />
      ))}
    </span>
  )
}

/**
 * Tap gestures for one side: what double/triple/quad taps do normally and
 * while an alarm is ringing. Each chip opens the gesture editor.
 */
export function TapGestureConfig({ filterSide = 'left', onSideChange }: {
  filterSide?: Side
  /** When set, each card shows a Left/Right tab strip that calls this. */
  onSideChange?: (side: Side) => void
} = {}) {
  const { sideName } = useSideNames()
  const utils = trpc.useUtils()
  const settingsQuery = trpc.settings.getAll.useQuery({})
  const setGesture = trpc.settings.setGesture.useMutation({
    onSuccess: () => {
      utils.settings.getAll.invalidate()
      setEditing(null)
    },
  })
  const deleteGesture = trpc.settings.deleteGesture.useMutation({
    onSuccess: () => {
      utils.settings.getAll.invalidate()
      setEditing(null)
    },
  })

  const [editing, setEditing] = useState<EditState | null>(null)

  const gestures = settingsQuery.data?.gestures as
    | { left: GestureRecord[], right: GestureRecord[] }
    | undefined

  const findGesture = useCallback(
    (side: Side, tapType: TapType): GestureRecord | undefined => {
      return gestures?.[side]?.find((g: GestureRecord) => g.tapType === tapType)
    },
    [gestures]
  )

  const openEditor = (tapType: TapType, fromRinging: boolean) => {
    const gesture = findGesture(filterSide, tapType)
    setEditing(gesture ? editStateFromGesture(gesture) : defaultEditState(filterSide, tapType, fromRinging))
  }

  const handleSave = useCallback(() => {
    if (!editing) return

    // Both actions are saved together, whichever column opened the editor.
    // The snooze length is the ringing alarm's (set on the alarm), not the tap's.
    const ringing = { alarmBehavior: editing.ringing }
    if (editing.idle === 'temperature') {
      setGesture.mutate({
        side: editing.side,
        tapType: editing.tapType,
        actionType: 'temperature',
        temperatureChange: editing.temperatureChange,
        temperatureAmount: editing.temperatureAmount,
        ...ringing,
      })
    }
    else {
      setGesture.mutate({
        side: editing.side,
        tapType: editing.tapType,
        actionType: 'alarm',
        ...ringing,
        alarmInactiveBehavior: editing.idle,
      })
    }
  }, [editing, setGesture])

  const handleDelete = useCallback(
    (side: Side, tapType: TapType) => {
      deleteGesture.mutate({ side, tapType })
    },
    [deleteGesture]
  )

  if (settingsQuery.isLoading) {
    return (
      <SectionColumns
        left={<Skeleton className="h-[196px]" />}
        right={<Skeleton className="h-[196px]" />}
      />
    )
  }

  const rows = (describe: (g: GestureRecord | undefined) => string, ringing: boolean) =>
    TAP_TYPES.map(({ key, label, taps }) => (
      <SettingRow
        key={key}
        label={(
          <>
            <TapDots taps={taps} />
            {label}
          </>
        )}
      >
        <ValueChip
          aria-label={`${label}${ringing ? ' while ringing' : ''}: ${describe(findGesture(filterSide, key))}`}
          onClick={() => openEditor(key, ringing)}
          className={findGesture(filterSide, key) ? undefined : 'text-fg-2'}
        >
          {describe(findGesture(filterSide, key))}
        </ValueChip>
      </SettingRow>
    ))

  const tabs = (label: string) => onSideChange && <SideTabs side={filterSide} onChange={onSideChange} label={label} />

  const editingLabel = editing ? TAP_TYPES.find(t => t.key === editing.tapType)?.label : ''
  const editingExists = editing ? !!findGesture(editing.side, editing.tapType) : false

  return (
    <>
      <SectionColumns
        left={(
          <Card>
            {tabs('Tap gestures')}
            <CardHeader title="Tap gestures" subtitle="Tap the top of the cover on your side" />
            {rows(idleDescription, false)}
          </Card>
        )}
        right={(
          <Card>
            {tabs('While an alarm is ringing')}
            <CardHeader title="While an alarm is ringing" />
            {rows(ringingDescription, true)}
          </Card>
        )}
      />
      {settingsQuery.error && <InlineError>{settingsQuery.error.message}</InlineError>}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `${editingLabel} · ${sideName(editing.side)}` : ''}
        icon={Hand}
        iconClassName="text-icon"
        width={480}
        footer={editing && (
          <>
            {editingExists && (
              <Button
                variant="danger"
                icon={Trash2}
                onClick={() => handleDelete(editing.side, editing.tapType)}
                disabled={deleteGesture.isPending}
              >
                Remove
              </Button>
            )}
            <div className="ml-auto flex gap-2.5">
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={handleSave} disabled={setGesture.isPending}>
                {setGesture.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </>
        )}
      >
        {editing && (
          <GestureEditPanel state={editing} onChange={setEditing} />
        )}
        {setGesture.error && <InlineError>{setGesture.error.message}</InlineError>}
        {deleteGesture.error && <InlineError>{deleteGesture.error.message}</InlineError>}
      </Modal>
    </>
  )
}

/**
 * Body of the gesture editor: the gesture's two independent actions — what
 * it does normally, and what it does while an alarm is ringing.
 */
function GestureEditPanel({
  state,
  onChange,
}: {
  state: EditState
  onChange: (s: EditState) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs text-fg-2">Normally</span>
      <SegmentedControl
        full
        ariaLabel="Normally"
        value={state.idle}
        options={[{ value: 'temperature', label: 'Temperature' }, { value: 'power', label: 'Power on / off' }, { value: 'none', label: 'Nothing' }]}
        onChange={idle => onChange({ ...state, idle })}
      />
      {state.idle === 'temperature' && (
        <>
          <SettingRow label="Direction">
            <SegmentedControl
              ariaLabel="Direction"
              value={state.temperatureChange}
              options={[{ value: 'increment', label: 'Warmer' }, { value: 'decrement', label: 'Cooler' }]}
              onChange={temperatureChange => onChange({ ...state, temperatureChange })}
            />
          </SettingRow>
          <SettingRow label="Amount">
            <Stepper
              label="Amount"
              value={state.temperatureAmount}
              min={1}
              max={10}
              onChange={temperatureAmount => onChange({ ...state, temperatureAmount })}
            />
          </SettingRow>
        </>
      )}

      <span className="mt-2 border-t border-line pt-3.5 text-xs text-fg-2">While an alarm is ringing</span>
      <SegmentedControl
        full
        ariaLabel="While an alarm is ringing"
        value={state.ringing}
        options={[{ value: 'snooze', label: 'Snooze' }, { value: 'dismiss', label: 'Stop alarm' }]}
        onChange={ringing => onChange({ ...state, ringing })}
      />
      {state.ringing === 'snooze' && (
        <span className="text-xs leading-[1.4] text-fg-3">
          How long a snooze lasts is set on each alarm.
        </span>
      )}
    </div>
  )
}
