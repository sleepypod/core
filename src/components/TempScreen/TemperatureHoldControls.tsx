'use client'

import { trpc } from '@/src/utils/trpc'
import type { Side } from '@/src/hardware/types'
import type { TemperatureControlStatus } from '@/src/temperature/controller'

const sourceLabels = { 'manual': 'Manual hold', 'run-once': 'Run-once session', 'autopilot': 'Autopilot', 'schedule': 'Schedule' }

export function TemperatureHoldControls({ sides, status, holdMinutes, onDurationChange, onResumed }: {
  sides: Side[]
  status: Record<Side, TemperatureControlStatus>
  holdMinutes: number
  onDurationChange: (minutes: number) => void
  onResumed: () => void
}) {
  const resume = trpc.device.resumeTemperature.useMutation({ onSuccess: onResumed })
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-2 px-4 text-sm text-zinc-400">
      {sides.map((side) => {
        const control = status[side]
        return (
          <div key={side} className="flex items-center justify-between gap-3">
            <span>
              {side === 'left' ? 'Left' : 'Right'}
              {': '}
              {control.blocked === 'safety' ? 'Safety stop' : control.blocked === 'off' ? 'Off' : (control.source ? sourceLabels[control.source] : 'Manual temperature')}
              {control.holdUntil != null && (
                <span>
                  {' · hold until '}
                  {new Date(control.holdUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
            </span>
            {control.holdUntil != null && (
              <button
                type="button"
                className="rounded px-2 py-1 text-sky-400 hover:bg-zinc-800 disabled:opacity-50"
                disabled={resume.isPending}
                onClick={() => resume.mutate({ side })}
              >
                Resume
              </button>
            )}
          </div>
        )
      })}
      <label className="flex items-center justify-between gap-3">
        Hold after adjustment
        <select
          aria-label="Temperature hold duration"
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200"
          value={holdMinutes}
          onChange={event => onDurationChange(Number(event.target.value))}
        >
          {[15, 30, 60, 120].map(minutes => (
            <option key={minutes} value={minutes}>
              {minutes}
              {' '}
              minutes
            </option>
          ))}
        </select>
      </label>
      {resume.error && (
        <p role="alert" className="text-red-400">
          Could not resume:
          {resume.error.message}
        </p>
      )}
    </div>
  )
}
