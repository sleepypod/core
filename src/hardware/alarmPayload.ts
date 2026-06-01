import { Encoder } from 'cbor-x'
import type { AlarmConfig } from './types'

const encoder = new Encoder({ useRecords: false })

/**
 * Build the wire payload for any of the three alarm commands —
 * `ALARM_LEFT` (5), `ALARM_RIGHT` (6), `ALARM_SOLO` (17).
 *
 * Pod 5 frankenfirmware (SensorAlarm.h::trySparkParseAlarmSettings) expects
 * a hex-encoded CBOR map with Particle Spark short keys:
 *   pl = power level / intensity (1..100)
 *   du = duration in seconds (firmware ignores < 10s — motor won't engage)
 *   pi = pattern string: 'rise' | 'double'
 *   tt = trigger time (unix epoch seconds; firmware uses it for retries / dismiss windows)
 *
 * The earlier comma-string format ("intensity,pattern,duration") returned
 * err:-1 from the firmware's registered function — verified live on Pod 5.
 *
 * Same payload works across all three commands; the command code selects the
 * code path (see docs/adr/0021-alarm-solo-trigger.md).
 */
export function encodeAlarmPayload(config: AlarmConfig): string {
  const payload = {
    pl: config.vibrationIntensity,
    du: Math.max(10, config.duration),
    pi: config.vibrationPattern,
    tt: Math.floor(Date.now() / 1000),
  }
  return Buffer.from(encoder.encode(payload)).toString('hex')
}
