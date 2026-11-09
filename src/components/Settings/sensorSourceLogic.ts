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
  /** Prefixes seen publishing sensor subjects (NATS only). */
  observedPrefixes?: ReadonlyArray<ObservedPrefix>
}

export interface ObservedPrefix {
  prefix: string
  subscribed: boolean
  messages: number
  lastSeenAgeMs: number
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
  const unread = unreadPrefixes(i.observedPrefixes)
  const starved = i.lastFrameAgeMs === null || i.lastFrameAgeMs > FRAME_STALE_MS
  if (i.source === 'nats' && starved && unread.length > 0) {
    return `Firmware publishes under ${unread.join(', ')}, which this pod doesn't read. Set the subject prefix to ${unread[0]}.`
  }
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

export type PrefixChoice = 'auto' | 'raw' | 'rawmem' | 'custom'

export const PREFIX_CHOICES: ReadonlyArray<{ value: PrefixChoice, label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'raw', label: 'raw' },
  { value: 'rawmem', label: 'rawmem' },
  { value: 'custom', label: 'Custom…' },
]

/** Which segment a stored `natsSubjectPrefix` shows as; null is auto. */
export function prefixChoice(prefix: string | null): PrefixChoice {
  if (prefix === null) return 'auto'
  return prefix === 'raw' || prefix === 'rawmem' ? prefix : 'custom'
}

/** Prefixes publishing sensor subjects that the readers don't subscribe to. */
export function unreadPrefixes(observed: ReadonlyArray<ObservedPrefix> | undefined): string[] {
  return (observed ?? []).filter(p => !p.subscribed).map(p => p.prefix)
}

/** "raw: sens.piezo, frz.temp · rawmem: sens.capsense2", or null before any subject has a source. */
export function sourcesSummary(sources: Record<string, string>): string | null {
  const byPrefix = new Map<string, string[]>()
  const entries = Object.entries(sources).sort(([sa, pa], [sb, pb]) => pa.localeCompare(pb) || sa.localeCompare(sb))
  for (const [subject, prefix] of entries) {
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), subject])
  }
  if (byPrefix.size === 0) return null
  return [...byPrefix].map(([prefix, subjects]) => `${prefix}: ${subjects.join(', ')}`).join(' · ')
}

/** "raw 2s ago · rawv2 (not read) 1s ago", or null before discovery has seen anything. */
export function observedSummary(observed: ReadonlyArray<ObservedPrefix>): string | null {
  if (observed.length === 0) return null
  return observed
    .map(p => `${p.prefix}${p.subscribed ? '' : ' (not read)'} ${fmtAgo(p.lastSeenAgeMs)}`)
    .join(' · ')
}
