'use client'

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Globe, Thermometer, RotateCcw, Droplets, Timer, Lightbulb, Loader2, ShieldAlert } from 'lucide-react'
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
  ledNightModeEnabled: boolean
  ledDayBrightness: number
  ledNightBrightness: number
  ledNightStartTime: string | null
  ledNightEndTime: string | null
  globalMaxOnHours: number | null
  pumpStallProtectionEnabled: boolean
  pumpStallRpmThreshold: number
  pumpStallDwellSamples: number
  pumpStallAutoRecoveryEnabled: boolean
  pumpStallRecoveryRpm: number
  pumpStallRecoverySamples: number
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
  const [ledDayBrightness, setLedDayBrightness] = useState(device.ledDayBrightness)
  const [ledNightEnabled, setLedNightEnabled] = useState(device.ledNightModeEnabled)
  const [ledNightBrightness, setLedNightBrightness] = useState(device.ledNightBrightness)
  const [ledNightStart, setLedNightStart] = useState(device.ledNightStartTime ?? '22:00')
  const [ledNightEnd, setLedNightEnd] = useState(device.ledNightEndTime ?? '07:00')
  const [pumpStallEnabled, setPumpStallEnabled] = useState(device.pumpStallProtectionEnabled)
  const [pumpStallThreshold, setPumpStallThreshold] = useState(device.pumpStallRpmThreshold)
  const [pumpStallDwell, setPumpStallDwell] = useState(device.pumpStallDwellSamples)
  const [pumpAutoRecover, setPumpAutoRecover] = useState(device.pumpStallAutoRecoveryEnabled)
  const [pumpRecoveryRpm, setPumpRecoveryRpm] = useState(device.pumpStallRecoveryRpm)
  const [pumpRecoverySamples, setPumpRecoverySamples] = useState(device.pumpStallRecoverySamples)

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
    setLedDayBrightness(device.ledDayBrightness)
    setLedNightEnabled(device.ledNightModeEnabled)
    setLedNightBrightness(device.ledNightBrightness)
    setLedNightStart(device.ledNightStartTime ?? '22:00')
    setLedNightEnd(device.ledNightEndTime ?? '07:00')
    setPumpStallEnabled(device.pumpStallProtectionEnabled)
    setPumpStallThreshold(device.pumpStallRpmThreshold)
    setPumpStallDwell(device.pumpStallDwellSamples)
    setPumpAutoRecover(device.pumpStallAutoRecoveryEnabled)
    setPumpRecoveryRpm(device.pumpStallRecoveryRpm)
    setPumpRecoverySamples(device.pumpStallRecoverySamples)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [device])

  const [savedFlash, setSavedFlash] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mutation = trpc.settings.updateDevice.useMutation({
    onSuccess: () => {
      utils.settings.getAll.invalidate()
      setSavedFlash(true)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSavedFlash(false), 1500)
    },
  })
  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current)
  }, [])

  const isPending = mutation.isPending

  function save(updates: Partial<{
    timezone: string
    temperatureUnit: 'F' | 'C'
    rebootDaily: boolean
    rebootTime: string
    primePodDaily: boolean
    primePodTime: string
    globalMaxOnHours: number | null
    ledNightModeEnabled: boolean
    ledDayBrightness: number
    ledNightBrightness: number
    ledNightStartTime: string
    ledNightEndTime: string
    pumpStallProtectionEnabled: boolean
    pumpStallRpmThreshold: number
    pumpStallDwellSamples: number
    pumpStallAutoRecoveryEnabled: boolean
    pumpStallRecoveryRpm: number
    pumpStallRecoverySamples: number
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

  // LED brightness handlers — sliders update local state continuously, but the
  // mutation only fires on pointer/touch release so dragging doesn't flood the
  // hardware with SET_SETTINGS commands.
  function handleLedDayChange(brightness: number) {
    setLedDayBrightness(brightness)
  }

  function commitLedDay() {
    if (ledDayBrightness !== device.ledDayBrightness) {
      save({ ledDayBrightness })
    }
  }

  function handleLedNightToggle() {
    const newVal = !ledNightEnabled
    setLedNightEnabled(newVal)
    if (newVal) {
      save({
        ledNightModeEnabled: true,
        ledNightStartTime: ledNightStart,
        ledNightEndTime: ledNightEnd,
      })
    }
    else {
      save({ ledNightModeEnabled: false })
    }
  }

  function handleLedNightBrightnessChange(brightness: number) {
    setLedNightBrightness(brightness)
  }

  function commitLedNightBrightness() {
    if (ledNightBrightness !== device.ledNightBrightness) {
      save({ ledNightBrightness })
    }
  }

  function handleLedNightStartChange(time: string) {
    setLedNightStart(time)
    save({ ledNightStartTime: time })
  }

  function handleLedNightEndChange(time: string) {
    setLedNightEnd(time)
    save({ ledNightEndTime: time })
  }

  function handlePumpStallToggle() {
    const next = !pumpStallEnabled
    setPumpStallEnabled(next)
    save({ pumpStallProtectionEnabled: next })
  }

  function handlePumpStallThreshold(rpm: number) {
    const clamped = Math.max(100, Math.min(1500, Math.round(rpm)))
    setPumpStallThreshold(clamped)
    save({ pumpStallRpmThreshold: clamped })
  }

  function handlePumpStallDwell(samples: number) {
    const clamped = Math.max(1, Math.min(10, Math.round(samples)))
    setPumpStallDwell(clamped)
    save({ pumpStallDwellSamples: clamped })
  }

  function handlePumpAutoRecoverToggle() {
    const next = !pumpAutoRecover
    setPumpAutoRecover(next)
    save({ pumpStallAutoRecoveryEnabled: next })
  }

  function handlePumpRecoveryRpm(rpm: number) {
    const clamped = Math.max(500, Math.min(3000, Math.round(rpm)))
    setPumpRecoveryRpm(clamped)
    save({ pumpStallRecoveryRpm: clamped })
  }

  function handlePumpRecoverySamples(samples: number) {
    const clamped = Math.max(1, Math.min(10, Math.round(samples)))
    setPumpRecoverySamples(clamped)
    save({ pumpStallRecoverySamples: clamped })
  }

  const showToast = isPending || savedFlash


  return (
    <div className="space-y-4">
      <div
        aria-live="polite"
        className={`pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 transition-opacity duration-200 sm:bottom-28 ${
          showToast ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="flex items-center gap-2 rounded-full bg-zinc-800/95 px-3 py-1.5 text-xs font-medium text-zinc-200 shadow-lg ring-1 ring-zinc-700/60 backdrop-blur">
          {isPending
            ? (
                <>
                  <Loader2 size={12} className="animate-spin text-sky-400" />
                  Saving…
                </>
              )
            : savedFlash
              ? (
                  <>
                    <CheckCircle2 size={12} className="text-emerald-400" />
                    Saved
                  </>
                )
              : null}
        </div>
      </div>

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

      {/* LED brightness + night mode */}
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="mb-3 flex items-center gap-2">
          <Lightbulb size={16} className="text-zinc-400" />
          <span className="text-sm font-medium text-zinc-300">Pod LED</span>
        </div>

        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Brightness</span>
            <span className="text-xs font-medium text-white">
              {ledDayBrightness}
              %
            </span>
          </div>
          <input
            aria-label="LED brightness"
            type="range"
            min={0}
            max={100}
            step={1}
            value={ledDayBrightness}
            onChange={e => handleLedDayChange(parseInt(e.target.value, 10))}
            onPointerUp={commitLedDay}
            onKeyUp={commitLedDay}
            disabled={isPending}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-40 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500"
          />
          <div className="flex justify-between text-[10px] text-zinc-600">
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>

        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-300">Night Mode</span>
          <Toggle
            enabled={ledNightEnabled}
            onToggle={handleLedNightToggle}
            disabled={isPending}
            label="Toggle LED night mode"
          />
        </div>
        {ledNightEnabled && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <TimeInput
                label="Start"
                value={ledNightStart}
                onChange={handleLedNightStartChange}
                disabled={isPending}
              />
              <TimeInput
                label="End"
                value={ledNightEnd}
                onChange={handleLedNightEndChange}
                disabled={isPending}
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-400">Night brightness</span>
                <span className="text-xs font-medium text-white">
                  {ledNightBrightness}
                  %
                </span>
              </div>
              <input
                aria-label="LED night brightness"
                type="range"
                min={0}
                max={100}
                step={1}
                value={ledNightBrightness}
                onChange={e => handleLedNightBrightnessChange(parseInt(e.target.value, 10))}
                onPointerUp={commitLedNightBrightness}
                onKeyUp={commitLedNightBrightness}
                disabled={isPending}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-40 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500"
              />
              <div className="flex justify-between text-[10px] text-zinc-600">
                <span>0%</span>
                <span>100%</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Pump safety */}
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert size={16} className={pumpStallEnabled ? 'text-red-400' : 'text-zinc-400'} />
            <span className="text-sm font-medium text-zinc-300">Pump safety</span>
          </div>
          <Toggle
            enabled={pumpStallEnabled}
            onToggle={handlePumpStallToggle}
            disabled={isPending}
            label="Toggle pump stall protection"
          />
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          When the pump RPM stays under the threshold for the dwell window, the side powers off until you re-enable it.
        </p>
        {pumpStallEnabled && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="pumpThresholdRpm" className="text-sm text-zinc-300">
                Trip threshold (RPM)
              </label>
              <input
                id="pumpThresholdRpm"
                type="number"
                min={100}
                max={1500}
                step={50}
                value={pumpStallThreshold}
                onChange={e => handlePumpStallThreshold(Number(e.target.value))}
                disabled={isPending}
                className="h-11 w-28 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 text-sm font-medium text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="pumpStallDwell" className="text-sm text-zinc-300">
                Dwell samples
              </label>
              <input
                id="pumpStallDwell"
                type="number"
                min={1}
                max={10}
                step={1}
                value={pumpStallDwell}
                onChange={e => handlePumpStallDwell(Number(e.target.value))}
                disabled={isPending}
                className="h-11 w-28 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 text-sm font-medium text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
            <p className="text-xs text-zinc-500">
              Consecutive sub-threshold frames before tripping. Frames arrive every ~60 seconds.
            </p>
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-300">Auto-recover when pump returns</span>
              <Toggle
                enabled={pumpAutoRecover}
                onToggle={handlePumpAutoRecoverToggle}
                disabled={isPending}
                label="Toggle pump auto-recovery"
              />
            </div>
            {pumpAutoRecover && (
              <>
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="pumpRecoveryRpm" className="text-sm text-zinc-300">
                    Recovery RPM
                  </label>
                  <input
                    id="pumpRecoveryRpm"
                    type="number"
                    min={500}
                    max={3000}
                    step={50}
                    value={pumpRecoveryRpm}
                    onChange={e => handlePumpRecoveryRpm(Number(e.target.value))}
                    disabled={isPending}
                    className="h-11 w-28 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 text-sm font-medium text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="pumpRecoverySamples" className="text-sm text-zinc-300">
                    Recovery samples
                  </label>
                  <input
                    id="pumpRecoverySamples"
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    value={pumpRecoverySamples}
                    onChange={e => handlePumpRecoverySamples(Number(e.target.value))}
                    disabled={isPending}
                    className="h-11 w-28 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 text-sm font-medium text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {mutation.error && (
        <p className="text-xs text-red-400">{mutation.error.message}</p>
      )}
    </div>
  )
}
