'use client'

import { useEffect, useState } from 'react'
import { Play, Square } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { useSideNames } from '@/src/hooks/useSideNames'
import { Button, Card, CardHeader, InlineError, SegmentedControl, SettingRow, Slider } from '@/src/components/ds'
import { FIXED_INTENSITY, FIXED_PATTERN, VIBRATION_PRESETS } from '@/src/lib/vibrationPatterns'

type Side = 'left' | 'right'

const CUSTOM = 'Custom'

/**
 * Test vibration: pick a side and a preset, then play it on the cover.
 * Intensity/pattern are firmware-clamped on Pod 5 — only duration matters.
 */
export function HapticsTestCard({ filterSide }: { filterSide?: Side } = {}) {
  const { side: contextSide } = useSide()
  const { leftName, rightName } = useSideNames()
  const [pickedSide, setPickedSide] = useState<Side | null>(null)
  const side = filterSide ?? pickedSide ?? contextSide
  const [preset, setPreset] = useState(VIBRATION_PRESETS[0].name)
  const [customDuration, setCustomDuration] = useState(10)
  // A fresh object per play, so replaying the same preset restarts the timer and sweep.
  const [playing, setPlaying] = useState<{ duration: number, startedAt: number } | null>(null)

  const setAlarm = trpc.device.setAlarm.useMutation({
    onSuccess: (_data, vars) => setPlaying(vars.duration == null ? null : { duration: vars.duration, startedAt: Date.now() }),
  })
  const clearAlarm = trpc.device.clearAlarm.useMutation({
    onSuccess: () => setPlaying(null),
  })

  // The cover stops on its own once the duration runs out.
  useEffect(() => {
    if (playing == null) return
    const t = setTimeout(() => setPlaying(null), playing.duration * 1000)
    return () => clearTimeout(t)
  }, [playing])

  const isMutating = setAlarm.isPending || clearAlarm.isPending
  const isCustom = preset === CUSTOM
  const selected = VIBRATION_PRESETS.find(p => p.name === preset)
    ?? { name: CUSTOM, duration: customDuration, description: 'Custom duration' }

  function handlePlay() {
    setAlarm.mutate({
      side,
      vibrationIntensity: FIXED_INTENSITY,
      vibrationPattern: FIXED_PATTERN,
      duration: selected.duration,
    })
  }

  function handleStop() {
    clearAlarm.mutate({ side })
  }

  return (
    <Card>
      <CardHeader title="Test vibration" subtitle="Run a pattern on one side to check the cover" />
      <div className="flex flex-wrap items-center gap-2.5">
        {!filterSide && (
          <SegmentedControl
            ariaLabel="Vibration side"
            value={side}
            options={[{ value: 'left', label: leftName }, { value: 'right', label: rightName }]}
            onChange={setPickedSide}
          />
        )}
        <SegmentedControl
          ariaLabel="Vibration pattern"
          value={preset}
          options={[...VIBRATION_PRESETS.map(p => ({ value: p.name, label: p.name })), { value: CUSTOM, label: CUSTOM }]}
          onChange={setPreset}
        />
        <Button icon={Play} onClick={handlePlay} disabled={isMutating}>
          Play
        </Button>
        {playing != null && (
          <Button variant="danger" icon={Square} onClick={handleStop} disabled={clearAlarm.isPending}>
            Stop
          </Button>
        )}
      </div>
      {isCustom && (
        <SettingRow label="Duration">
          <div className="flex w-[180px] items-center gap-2.5">
            <Slider label="Custom vibration duration" value={customDuration} min={1} max={60} onChange={setCustomDuration} />
            <span className="w-8 text-right font-mono text-xs">
              {customDuration}
              s
            </span>
          </div>
        </SettingRow>
      )}
      <VibrationPreview duration={playing?.duration ?? selected.duration} playing={playing != null} playKey={playing?.startedAt} />
      <p className="text-xs text-fg-2">
        {selected.description}
        {' · '}
        <span className="font-mono">
          {selected.duration}
          s
        </span>
      </p>
      {setAlarm.error && <InlineError>{setAlarm.error.message}</InlineError>}
      {clearAlarm.error && <InlineError>{clearAlarm.error.message}</InlineError>}
    </Card>
  )
}

/** Longest preset; the preview track is drawn on this scale so lengths compare. */
const PREVIEW_MAX_S = 60

/**
 * What the selected pattern will do: one pulse a second for its duration, on
 * a fixed 0–60 s track, with a sweep while it plays.
 */
export function VibrationPreview({ duration, playing, playKey }: { duration: number, playing: boolean, playKey?: number }) {
  const share = Math.min(1, duration / PREVIEW_MAX_S)
  return (
    <div className="flex flex-col gap-1" data-testid="vibration-preview">
      <div className="relative h-6 overflow-hidden rounded-[4px] bg-active" aria-hidden>
        <div className="absolute inset-y-0 left-0 flex items-center gap-px px-px" style={{ width: `${share * 100}%` }}>
          {Array.from({ length: duration }, (_, i) => (
            <span key={i} className="h-3.5 min-w-px flex-1 rounded-[1px] bg-cool/70" />
          ))}
        </div>
        {playing && (
          <div
            key={playKey ?? duration}
            className="sp-sweep absolute inset-y-0 left-0 origin-left bg-cool/25"
            style={{ width: `${share * 100}%`, animationDuration: `${duration}s` }}
          />
        )}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-fg-3">
        <span>0s</span>
        <span>{playing ? 'playing…' : `${duration}s of ${PREVIEW_MAX_S}s`}</span>
        <span>{`${PREVIEW_MAX_S}s`}</span>
      </div>
    </div>
  )
}
