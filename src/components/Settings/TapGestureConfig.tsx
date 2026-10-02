'use client'

import { useState, useCallback } from 'react'
import { Hand, Trash2 } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSideNames } from '@/src/hooks/useSideNames'
import { Button, Card, CardHeader, InlineError, Modal, SegmentedControl, SettingRow, Skeleton, Stepper, ValueChip } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { SectionColumns } from './SettingsLayout'

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

/** What the gesture does while an alarm is ringing. */
export function ringingDescription(g: GestureRecord | undefined): string {
  if (!g) return 'Not set'
  if (g.actionType === 'temperature') return temperatureLabel(g)
  if (g.alarmBehavior === 'snooze') return `Snooze ${Math.round((g.alarmSnoozeDuration ?? 300) / 60)} min`
  return 'Stop alarm'
}

interface EditState {
  side: Side
  tapType: TapType
  actionType: ActionType
  temperatureChange: 'increment' | 'decrement'
  temperatureAmount: number
  alarmBehavior: 'snooze' | 'dismiss'
  alarmSnoozeDuration: number
  alarmInactiveBehavior: 'power' | 'none'
}

const defaultEditState = (side: Side, tapType: TapType): EditState => ({
  side,
  tapType,
  actionType: 'temperature',
  temperatureChange: 'increment',
  temperatureAmount: 2,
  alarmBehavior: 'snooze',
  alarmSnoozeDuration: 300,
  alarmInactiveBehavior: 'none',
})

function editStateFromGesture(g: GestureRecord): EditState {
  return {
    side: g.side,
    tapType: g.tapType,
    actionType: g.actionType,
    temperatureChange: g.temperatureChange ?? 'increment',
    temperatureAmount: g.temperatureAmount ?? 2,
    alarmBehavior: g.alarmBehavior ?? 'snooze',
    alarmSnoozeDuration: g.alarmSnoozeDuration ?? 300,
    alarmInactiveBehavior: g.alarmInactiveBehavior ?? 'none',
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
export function TapGestureConfig({ filterSide = 'left' }: { filterSide?: Side } = {}) {
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

  const openEditor = (tapType: TapType) => {
    const gesture = findGesture(filterSide, tapType)
    setEditing(gesture ? editStateFromGesture(gesture) : defaultEditState(filterSide, tapType))
  }

  const handleSave = useCallback(() => {
    if (!editing) return

    if (editing.actionType === 'temperature') {
      setGesture.mutate({
        side: editing.side,
        tapType: editing.tapType,
        actionType: 'temperature',
        temperatureChange: editing.temperatureChange,
        temperatureAmount: editing.temperatureAmount,
      })
    }
    else {
      setGesture.mutate({
        side: editing.side,
        tapType: editing.tapType,
        actionType: 'alarm',
        alarmBehavior: editing.alarmBehavior,
        alarmSnoozeDuration:
          editing.alarmBehavior === 'snooze' ? editing.alarmSnoozeDuration : undefined,
        alarmInactiveBehavior: editing.alarmInactiveBehavior,
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
          onClick={() => openEditor(key)}
          className={findGesture(filterSide, key) ? undefined : 'text-fg-2'}
        >
          {describe(findGesture(filterSide, key))}
        </ValueChip>
      </SettingRow>
    ))

  const editingLabel = editing ? TAP_TYPES.find(t => t.key === editing.tapType)?.label : ''
  const editingExists = editing ? !!findGesture(editing.side, editing.tapType) : false

  return (
    <>
      <SectionColumns
        left={(
          <Card>
            <CardHeader title="Tap gestures" subtitle="Tap the top of the cover on your side" />
            {rows(idleDescription, false)}
          </Card>
        )}
        right={(
          <Card>
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
 * Body of the gesture editor: action type plus its parameters.
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
      <SegmentedControl
        full
        ariaLabel="Gesture action"
        value={state.actionType}
        options={[{ value: 'temperature', label: 'Temperature' }, { value: 'alarm', label: 'Alarm & power' }]}
        onChange={actionType => onChange({ ...state, actionType })}
      />

      {state.actionType === 'temperature' && (
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

      {state.actionType === 'alarm' && (
        <>
          <SettingRow label="While ringing">
            <SegmentedControl
              ariaLabel="While ringing"
              value={state.alarmBehavior}
              options={[{ value: 'snooze', label: 'Snooze' }, { value: 'dismiss', label: 'Stop alarm' }]}
              onChange={alarmBehavior => onChange({ ...state, alarmBehavior })}
            />
          </SettingRow>
          {state.alarmBehavior === 'snooze' && (
            <SettingRow label="Snooze for">
              <Stepper
                label="Snooze duration"
                value={Math.round(state.alarmSnoozeDuration / 60)}
                min={1}
                max={10}
                format={v => `${v} min`}
                onChange={mins => onChange({ ...state, alarmSnoozeDuration: mins * 60 })}
              />
            </SettingRow>
          )}
          <SettingRow label="When no alarm">
            <SegmentedControl
              ariaLabel="When no alarm"
              value={state.alarmInactiveBehavior}
              options={[{ value: 'none', label: 'Nothing' }, { value: 'power', label: 'Power on / off' }]}
              onChange={alarmInactiveBehavior => onChange({ ...state, alarmInactiveBehavior })}
            />
          </SettingRow>
        </>
      )}
    </div>
  )
}
