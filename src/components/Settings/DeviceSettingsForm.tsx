'use client'

import { useEffect, useState } from 'react'
import { Globe, Thermometer, RotateCcw, Droplets, Timer } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Toggle } from './Toggle'
import { TimeInput } from '../Schedule/TimeInput'

interface DeviceSettings {
  timezone: string
  temperatureUnit: string
  rebootDaily: boolean
  rebootTime: string | null
  primePodDaily: boolean
  primePodTime: string | null
  globalMaxOnHours: number | null
}

const DEFAULT_MAX_ON_HOURS = 12

// Common US/international timezones
const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Phoenix',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Pacific/Auckland',
]

/**
 * Device-level settings form: timezone, temperature unit, reboot schedule, prime pod schedule.
 * Matches iOS DeviceSettingsCardView device section.
 */
export function DeviceSettingsForm({ device }: { device: DeviceSettings }) {
  const utils = trpc.useUtils()

  const [timezone, setTimezone] = useState(device.timezone)
  const [tempUnit, setTempUnit] = useState(device.temperatureUnit)
  const [rebootDaily, setRebootDaily] = useState(device.rebootDaily)
  const [rebootTime, setRebootTime] = useState(device.rebootTime ?? '03:00')
  const [primePodDaily, setPrimePodDaily] = useState(device.primePodDaily)
  const [primePodTime, setPrimePodTime] = useState(device.primePodTime ?? '14:00')
  const [maxOnEnabled, setMaxOnEnabled] = useState(device.globalMaxOnHours != null)
  const [maxOnHours, setMaxOnHours] = useState(device.globalMaxOnHours ?? DEFAULT_MAX_ON_HOURS)

  // Sync from server data when it changes
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setTimezone(device.timezone)
    setTempUnit(device.temperatureUnit)
    setRebootDaily(device.rebootDaily)
    setRebootTime(device.rebootTime ?? '03:00')
    setPrimePodDaily(device.primePodDaily)
    setPrimePodTime(device.primePodTime ?? '14:00')
    setMaxOnEnabled(device.globalMaxOnHours != null)
    setMaxOnHours(device.globalMaxOnHours ?? DEFAULT_MAX_ON_HOURS)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [device])

  const mutation = trpc.settings.updateDevice.useMutation({
    onSuccess: () => utils.settings.getAll.invalidate(),
  })

  const isPending = mutation.isPending

  function save(updates: Partial<{
    timezone: string
    temperatureUnit: 'F' | 'C'
    rebootDaily: boolean
    rebootTime: string
    primePodDaily: boolean
    primePodTime: string
    globalMaxOnHours: number | null
  }>) {
    mutation.mutate(updates)
  }

  function handleTimezoneChange(tz: string) {
    setTimezone(tz)
    save({ timezone: tz })
  }

  function handleTempUnitChange(unit: 'F' | 'C') {
    setTempUnit(unit)
    save({ temperatureUnit: unit })
  }

  function handleRebootToggle() {
    const newVal = !rebootDaily
    setRebootDaily(newVal)
    if (newVal) {
      save({ rebootDaily: true, rebootTime })
    }
    else {
      save({ rebootDaily: false })
    }
  }

  function handleRebootTimeChange(time: string) {
    setRebootTime(time)
    save({ rebootTime: time })
  }

  function handlePrimeToggle() {
    const newVal = !primePodDaily
    setPrimePodDaily(newVal)
    if (newVal) {
      save({ primePodDaily: true, primePodTime })
    }
    else {
      save({ primePodDaily: false })
    }
  }

  function handlePrimeTimeChange(time: string) {
    setPrimePodTime(time)
    save({ primePodTime: time })
  }

  function handleMaxOnToggle() {
    const newVal = !maxOnEnabled
    setMaxOnEnabled(newVal)
    save({ globalMaxOnHours: newVal ? maxOnHours : null })
  }

  function handleMaxOnHoursChange(hours: number) {
    // Clamp to the router's 1–48 range before emitting.
    const clamped = Math.max(1, Math.min(48, Math.round(hours)))
    setMaxOnHours(clamped)
    if (maxOnEnabled) save({ globalMaxOnHours: clamped })
  }

  return (
    <div className="space-y-4">
      {/* Timezone */}
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="mb-3 flex items-center gap-2">
          <Globe size={16} className="text-zinc-400" />
          <span className="text-sm font-medium text-zinc-300">Timezone</span>
        </div>
        <select
          value={timezone}
          onChange={e => handleTimezoneChange(e.target.value)}
          disabled={isPending}
          className="h-11 w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 text-sm font-medium text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {TIMEZONES.map(tz => (
            <option key={tz} value={tz}>
              {tz.replace(/_/g, ' ')}
            </option>
          ))}
          {/* Include current timezone if not in common list */}
          {!TIMEZONES.includes(timezone) && (
            <option value={timezone}>{timezone.replace(/_/g, ' ')}</option>
          )}
        </select>
      </div>

      {/* Temperature Unit */}
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="mb-3 flex items-center gap-2">
          <Thermometer size={16} className="text-zinc-400" />
          <span className="text-sm font-medium text-zinc-300">Temperature Unit</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => handleTempUnitChange('F')}
            disabled={isPending}
            className={`rounded-lg min-h-[44px] text-[13px] font-medium transition-colors disabled:opacity-50 sm:text-sm ${
              tempUnit === 'F'
                ? 'bg-sky-500/20 text-sky-400'
                : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700'
            }`}
          >
            °F
          </button>
          <button
            onClick={() => handleTempUnitChange('C')}
            disabled={isPending}
            className={`rounded-lg min-h-[44px] text-[13px] font-medium transition-colors disabled:opacity-50 sm:text-sm ${
              tempUnit === 'C'
                ? 'bg-sky-500/20 text-sky-400'
                : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700'
            }`}
          >
            °C
          </button>
        </div>
      </div>

      {/* Auto Reboot */}
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <RotateCcw size={16} className={rebootDaily ? 'text-sky-400' : 'text-zinc-400'} />
            <span className="text-sm font-medium text-zinc-300">Daily Reboot</span>
          </div>
          <Toggle
            enabled={rebootDaily}
            onToggle={handleRebootToggle}
            disabled={isPending}
            label="Toggle daily reboot"
          />
        </div>
        {rebootDaily && (
          <div className="mt-2">
            <TimeInput
              label="Reboot Time"
              value={rebootTime}
              onChange={handleRebootTimeChange}
              disabled={isPending}
            />
          </div>
        )}
      </div>

      {/* Prime Pod */}
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Droplets size={16} className={primePodDaily ? 'text-sky-400' : 'text-zinc-400'} />
            <span className="text-sm font-medium text-zinc-300">Daily Prime Pod</span>
          </div>
          <Toggle
            enabled={primePodDaily}
            onToggle={handlePrimeToggle}
            disabled={isPending}
            label="Toggle daily prime pod"
          />
        </div>
        {primePodDaily && (
          <div className="mt-2">
            <TimeInput
              label="Prime Time"
              value={primePodTime}
              onChange={handlePrimeTimeChange}
              disabled={isPending}
            />
          </div>
        )}
      </div>

      {/* Global auto-off cap (wall-clock safety net) */}
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Timer size={16} className={maxOnEnabled ? 'text-sky-400' : 'text-zinc-400'} />
            <span className="text-sm font-medium text-zinc-300">Auto Power-Off Cap</span>
          </div>
          <Toggle
            enabled={maxOnEnabled}
            onToggle={handleMaxOnToggle}
            disabled={isPending}
            label="Toggle global auto power-off cap"
          />
        </div>
        <p className="mb-2 text-xs text-zinc-500">
          Forces any side that has been on for longer than this to power off. Runs on top of the per-side auto-off. Always-on sides and active run-once sessions are exempt.
        </p>
        {maxOnEnabled && (
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor="maxOnHours" className="text-sm text-zinc-300">
              Hours
            </label>
            <input
              id="maxOnHours"
              type="number"
              min={1}
              max={48}
              step={1}
              value={maxOnHours}
              onChange={e => handleMaxOnHoursChange(Number(e.target.value))}
              disabled={isPending}
              className="h-11 w-24 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 text-sm font-medium text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            />
          </div>
        )}
      </div>

      {mutation.error && (
        <p className="text-xs text-red-400">{mutation.error.message}</p>
      )}
    </div>
  )
}
