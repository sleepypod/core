'use client'

import { useEffect, useRef, useState } from 'react'
import { RotateCcw, Wifi } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, SegmentedControl, SelectValue, SettingRow, Slider, Toggle } from '@/src/components/ds'
import { NumberField, SaveToast, SectionColumns, TimeField } from './SettingsLayout'

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
const MAX_ON_HOUR_OPTIONS = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 36, 48]

// Common US/international timezones
export const TIMEZONES = [
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
 * Device-level settings: timezone, unit, power cap, pump protection,
 * reconnect/restart, daily maintenance, LED, and a vibration test.
 * Every control auto-saves through settings.updateDevice.
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

  // Sync from server data when it changes. Gated on a value fingerprint:
  // `device` gets a new object identity on every refetch (poll, focus,
  // mutation invalidate), and resetting on identity alone stomped fields the
  // user was actively editing.
  const lastSyncedDevice = useRef(JSON.stringify(device))
  useEffect(() => {
    const fingerprint = JSON.stringify(device)
    if (fingerprint === lastSyncedDevice.current) return
    lastSyncedDevice.current = fingerprint
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

  const rebootMutation = trpc.system.triggerUpdate.useMutation()

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

  // LED brightness sliders update local state continuously, but the mutation
  // only fires on pointer/key release so dragging doesn't flood the hardware
  // with SET_SETTINGS commands.
  function commitLedDay(value: number) {
    if (value !== device.ledDayBrightness) {
      save({ ledDayBrightness: value })
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

  function commitLedNightBrightness(value: number) {
    if (value !== device.ledNightBrightness) {
      save({ ledNightBrightness: value })
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

  // Pump-safety number inputs: update state on every keystroke but only clamp
  // + save on blur so partial values like "5" → "500" aren't clamped to the
  // min mid-type and don't fire a mutation per character.
  function commitPumpStallThreshold() {
    const clamped = Math.max(100, Math.min(1500, Math.round(pumpStallThreshold)))
    setPumpStallThreshold(clamped)
    if (clamped !== device.pumpStallRpmThreshold) save({ pumpStallRpmThreshold: clamped })
  }

  function commitPumpStallDwell() {
    const clamped = Math.max(1, Math.min(10, Math.round(pumpStallDwell)))
    setPumpStallDwell(clamped)
    if (clamped !== device.pumpStallDwellSamples) save({ pumpStallDwellSamples: clamped })
  }

  function handlePumpAutoRecoverToggle() {
    const next = !pumpAutoRecover
    setPumpAutoRecover(next)
    save({ pumpStallAutoRecoveryEnabled: next })
  }

  function commitPumpRecoveryRpm() {
    const clamped = Math.max(500, Math.min(3000, Math.round(pumpRecoveryRpm)))
    setPumpRecoveryRpm(clamped)
    if (clamped !== device.pumpStallRecoveryRpm) save({ pumpStallRecoveryRpm: clamped })
  }

  function commitPumpRecoverySamples() {
    const clamped = Math.max(1, Math.min(10, Math.round(pumpRecoverySamples)))
    setPumpRecoverySamples(clamped)
    if (clamped !== device.pumpStallRecoverySamples) save({ pumpStallRecoverySamples: clamped })
  }

  function handleRestart() {
    if (confirm('Restart the sleepypod service? The pod will be briefly unavailable.')) {
      rebootMutation.mutate({})
    }
  }

  const timezoneOptions = (TIMEZONES.includes(timezone) ? TIMEZONES : [...TIMEZONES, timezone])
    .map(tz => ({ value: tz, label: tz.replace(/_/g, ' ') }))
  const maxOnOptions = (MAX_ON_HOUR_OPTIONS.includes(maxOnHours) ? MAX_ON_HOUR_OPTIONS : [...MAX_ON_HOUR_OPTIONS, maxOnHours].sort((a, b) => a - b))
    .map(h => ({ value: h, label: `${h} h` }))

  const left = (
    <>
      <Card>
        <CardHeader title="Pod" />
        <SettingRow label="Timezone">
          <SelectValue
            label="Timezone"
            value={timezone}
            options={timezoneOptions}
            onChange={handleTimezoneChange}
            disabled={isPending}
            className="max-w-[210px]"
          />
        </SettingRow>
        <SettingRow label="Temperature unit">
          <SegmentedControl
            ariaLabel="Temperature unit"
            value={tempUnit === 'C' ? 'C' : 'F'}
            options={[{ value: 'F', label: '°F' }, { value: 'C', label: '°C' }]}
            onChange={handleTempUnitChange}
          />
        </SettingRow>
      </Card>

      <Card>
        <CardHeader title="Power" />
        <SettingRow
          label="Auto power-off cap"
          sub="Turns a side off after it has been on this long. Always-on sides and run-once sessions are exempt."
        >
          <SelectValue
            label="Auto power-off hours"
            value={maxOnHours}
            options={maxOnOptions}
            onChange={handleMaxOnHoursChange}
            disabled={isPending || !maxOnEnabled}
          />
          <Toggle
            on={maxOnEnabled}
            onChange={handleMaxOnToggle}
            disabled={isPending}
            label="Toggle global auto power-off cap"
          />
        </SettingRow>
      </Card>

      <Card>
        <CardHeader title="Pump protection" />
        <SettingRow label="Pump stall protection" sub="Powers a side off when pump RPM stays under the threshold for the dwell window">
          <Toggle
            on={pumpStallEnabled}
            onChange={handlePumpStallToggle}
            disabled={isPending}
            label="Toggle pump stall protection"
          />
        </SettingRow>
        {pumpStallEnabled && (
          <>
            <SettingRow label="Trip threshold" sub="RPM">
              <NumberField
                label="Trip threshold (RPM)"
                value={pumpStallThreshold}
                min={100}
                max={1500}
                step={50}
                onChange={setPumpStallThreshold}
                onBlur={commitPumpStallThreshold}
                disabled={isPending}
              />
            </SettingRow>
            <SettingRow label="Dwell samples" sub="Consecutive sub-threshold frames, ~60 s apart">
              <NumberField
                label="Dwell samples"
                value={pumpStallDwell}
                min={1}
                max={10}
                onChange={setPumpStallDwell}
                onBlur={commitPumpStallDwell}
                disabled={isPending}
              />
            </SettingRow>
            <SettingRow label="Pump auto-recovery" sub="Restores the side once the pump returns">
              <Toggle
                on={pumpAutoRecover}
                onChange={handlePumpAutoRecoverToggle}
                disabled={isPending}
                label="Toggle pump auto-recovery"
              />
            </SettingRow>
            {pumpAutoRecover && (
              <>
                <SettingRow label="Recovery RPM">
                  <NumberField
                    label="Recovery RPM"
                    value={pumpRecoveryRpm}
                    min={500}
                    max={3000}
                    step={50}
                    onChange={setPumpRecoveryRpm}
                    onBlur={commitPumpRecoveryRpm}
                    disabled={isPending}
                  />
                </SettingRow>
                <SettingRow label="Recovery samples">
                  <NumberField
                    label="Recovery samples"
                    value={pumpRecoverySamples}
                    min={1}
                    max={10}
                    onChange={setPumpRecoverySamples}
                    onBlur={commitPumpRecoverySamples}
                    disabled={isPending}
                  />
                </SettingRow>
              </>
            )}
          </>
        )}
      </Card>

      <div className="flex flex-wrap gap-2.5">
        <Button icon={Wifi} onClick={() => window.location.reload()}>
          Reconnect
        </Button>
        <Button variant="danger" icon={RotateCcw} onClick={handleRestart} disabled={rebootMutation.isPending}>
          {rebootMutation.isPending ? 'Restarting…' : 'Restart service'}
        </Button>
      </div>
      {rebootMutation.isSuccess && (
        <p className="text-xs text-ok">Service restarting — reconnecting…</p>
      )}
      {rebootMutation.error && <InlineError>{rebootMutation.error.message}</InlineError>}
    </>
  )

  const right = (
    <>
      <Card>
        <CardHeader title="Daily maintenance" />
        <SettingRow label="Daily reboot">
          <TimeField
            label="Reboot time"
            value={rebootTime}
            onChange={handleRebootTimeChange}
            disabled={isPending || !rebootDaily}
          />
          <Toggle
            on={rebootDaily}
            onChange={handleRebootToggle}
            disabled={isPending}
            label="Toggle daily reboot"
          />
        </SettingRow>
        <SettingRow label="Daily prime" sub="Circulates water to clear air from the lines">
          <TimeField
            label="Prime time"
            value={primePodTime}
            onChange={handlePrimeTimeChange}
            disabled={isPending || !primePodDaily}
          />
          <Toggle
            on={primePodDaily}
            onChange={handlePrimeToggle}
            disabled={isPending}
            label="Toggle daily prime pod"
          />
        </SettingRow>
      </Card>

      <Card>
        <CardHeader title="LED" />
        <SettingRow label="Brightness">
          <div className="flex w-[150px] items-center gap-2.5">
            <Slider
              label="LED brightness"
              value={ledDayBrightness}
              onChange={setLedDayBrightness}
              onCommit={commitLedDay}
              disabled={isPending}
            />
            <span className="w-8 text-right font-mono text-xs">
              {ledDayBrightness}
              %
            </span>
          </div>
        </SettingRow>
        <SettingRow label="Night mode" sub={`Dims the LED to ${ledNightBrightness}% overnight`}>
          <Toggle
            on={ledNightEnabled}
            onChange={handleLedNightToggle}
            disabled={isPending}
            label="Toggle LED night mode"
          />
        </SettingRow>
        {ledNightEnabled && (
          <>
            <SettingRow label="Window">
              <TimeField label="Night mode start" value={ledNightStart} onChange={handleLedNightStartChange} disabled={isPending} />
              <span className="text-fg-3">–</span>
              <TimeField label="Night mode end" value={ledNightEnd} onChange={handleLedNightEndChange} disabled={isPending} />
            </SettingRow>
            <SettingRow label="Night brightness">
              <div className="flex w-[150px] items-center gap-2.5">
                <Slider
                  label="LED night brightness"
                  value={ledNightBrightness}
                  onChange={setLedNightBrightness}
                  onCommit={commitLedNightBrightness}
                  disabled={isPending}
                />
                <span className="w-8 text-right font-mono text-xs">
                  {ledNightBrightness}
                  %
                </span>
              </div>
            </SettingRow>
          </>
        )}
      </Card>

      {mutation.error && <InlineError>{mutation.error.message}</InlineError>}
    </>
  )

  return (
    <>
      <SectionColumns left={left} right={right} />
      <SaveToast pending={isPending} saved={savedFlash} />
    </>
  )
}
