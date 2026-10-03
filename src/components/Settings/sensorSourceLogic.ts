import { fmtAgo } from '@/src/lib/dataPath'
import type { Tone } from '@/src/components/ds'

export type StreamSource = 'pending' | 'raw' | 'nats'
export type Transport = 'raw' | 'nats'

/** Mirrors `STALE_AFTER_MS.frames` in dataPath: capSense ticks at 2 Hz, so a minute of silence is a stall. */
export const FRAME_STALE_MS = 60_000
/** Grace after core start before silence counts against the source (NATS grace window + connect). */
export const FIRST_FRAME_GRACE_MS = 90_000

export interface SensorSourceVerdictInput {
  source: StreamSource
  expectedTransport: Transport
  override: Transport | null
  legacyNatsDisabled: boolean
  /** Server-computed age of the newest live frame; null before the first one. */
  lastFrameAgeMs: number | null
  uptimeSeconds: number
}

export interface SensorSourceVerdict {
  tone: Tone
  /** Short status for the card header dot, e.g. "Live", "Stalled". */
  status: string
  /** One sentence under the header. */
  summary: string
  /** Explains an override or a firmware/source mismatch; null when the pick is the expected one. */
  note: string | null
}

export const TRANSPORT_LABELS: Record<Transport, string> = {
  nats: 'NATS stream',
  raw: '.RAW files',
}

/**
 * Judge the stream's source pick against the firmware and the frame flow.
 *
 * Freshness is judged the same way System → Health judges the `frames` node,
 * so the two surfaces never disagree about whether data is flowing. The note
 * is the Settings-specific part: it says *why* the pick might look wrong
 * (an env override, or a fallback) so a support thread can skip a step.
 */
export function sensorSourceVerdict(i: SensorSourceVerdictInput): SensorSourceVerdict {
  const note = overrideNote(i)
  if (i.source === 'pending') {
    return {
      tone: 'muted',
      status: 'Choosing',
      summary: 'Still choosing between .RAW files and the NATS stream. This settles within about a minute of startup.',
      note,
    }
  }

  const reading = `Reading ${TRANSPORT_LABELS[i.source]}`
  if (i.lastFrameAgeMs === null) {
    const inGrace = i.uptimeSeconds * 1000 < FIRST_FRAME_GRACE_MS
    return {
      tone: inGrace ? 'muted' : 'warn',
      status: inGrace ? 'Waiting' : 'No frames',
      summary: inGrace
        ? `${reading}. Waiting for the first frames.`
        : `${reading}, but no frames have arrived since the service started.`,
      note,
    }
  }

  const age = i.lastFrameAgeMs
  if (age > FRAME_STALE_MS) {
    return {
      tone: 'danger',
      status: 'Stalled',
      summary: `${reading}. No frames for ${fmtAgo(age).replace(' ago', '')}.`,
      note,
    }
  }
  return {
    tone: 'ok',
    status: 'Live',
    summary: `${reading}. Last frame ${fmtAgo(age)}.`,
    note,
  }
}

function overrideNote(i: SensorSourceVerdictInput): string | null {
  if (i.override) {
    return `PIEZO_SENSOR_SOURCE=${i.override} forces this source regardless of firmware.`
  }
  if (i.legacyNatsDisabled) {
    return 'PIEZO_NATS_DISABLED=1 forces .RAW files regardless of firmware.'
  }
  if (i.source !== 'pending' && i.source !== i.expectedTransport) {
    return `Firmware looks like ${i.expectedTransport === 'nats' ? 'NATS' : '.RAW'} firmware, but the stream fell back to ${TRANSPORT_LABELS[i.source]}. Restart the service to re-detect, then check sp-status.`
  }
  return null
}
