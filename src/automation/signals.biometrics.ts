/**
 * Biometrics-backed signal reader for the automation engine.
 *
 * The live DAC monitor (DeviceSignalReader) only knows heat level / water level.
 * The richer sensors — vitals, movement, ambient + bed-surface + water
 * temperature, ambient light, and the capacitive sensor matrix — are produced by
 * the streaming services and persisted to biometrics.db (scalars) or held as a
 * live in-memory snapshot (the cap matrix). This reader surfaces them to the
 * engine as numeric catalog signals, gated by a per-source freshness window so a
 * stale or absent sample resolves to `undefined` — the engine then skips, the
 * safe default DeviceSignalReader already relies on.
 *
 * The capacitive presence matrix (capSense2: `[A1,A2,B1,B2,C1,C2,ref1,ref2]` per
 * side — body-contact load across head/torso/legs, NOT temperature) is exposed
 * to the engine only as scalar reducers — max / mean / spread — keeping the
 * engine scalar. This reader resolves them from the live in-memory snapshot; a
 * downsampled copy is persisted separately for historical replay (see
 * `streaming/capFramePersistence`). (`reduceCap` also derives a peakZone index,
 * used by the UI zone visualization rather than the engine.)
 *
 * `{side}.presence` is the shared virtual occupancy sensor (`lib/occupancy`)
 * collapsed to 1 (a person is in bed) / 0 (empty, or a light load such as a
 * pet). It reads `undefined` while presence can't be sensed — no fresh
 * supported capacitance frame or no calibration — so rules skip rather than fire blind.
 * `{side}.presence.zones` is the lit head/torso/legs count behind that call.
 *
 * Automation temperature signals are Fahrenheit by contract because automation
 * actions target hardware setpoints, which are also Fahrenheit.
 */

import { desc, eq } from 'drizzle-orm'
import { biometricsDb } from '@/src/db'
import { ambientLight, bedTemp, freezerTemp, movement, vitals } from '@/src/db/biometrics-schema'
import { centiDegreesToF, centiPercentToPercent } from '@/src/lib/tempUtils'
import { getOccupancy } from '@/src/lib/occupancy'
import { getLatestCapSenseSnapshot } from '@/src/streaming/piezoStream'
import { mean, reduceCap } from './capReduce'
import { finiteSignal } from './signalValidity'
import { isMechanicallyQualifiedVital } from '@/src/biometrics/mechanical/eligibility'
import type { SignalReader, SignalSnapshot } from './signals'

// Freshness windows (ms). A latest row older than its window is treated as
// absent. Vitals/movement land ~once a minute while in bed; environment frames
// are slower; the cap matrix arrives ~2 Hz on the live stream (see piezoStream).
const VITALS_FRESH_MS = 5 * 60_000
const MOVEMENT_FRESH_MS = 5 * 60_000
const ENV_FRESH_MS = 15 * 60_000
const CAP_FRESH_MS = 30_000

const SIDES = ['left', 'right'] as const

export class BiometricsSignalReader implements SignalReader {
  read(): SignalSnapshot {
    const out: SignalSnapshot = {}
    const now = Date.now()
    const fresh = (timestamp: Date | number, maxAgeMs: number): boolean => {
      const observedAt = timestamp instanceof Date ? timestamp.getTime() : timestamp
      return finiteSignal(observedAt) !== undefined && observedAt <= now && now - observedAt <= maxAgeMs
    }
    const publish = (key: string, value: unknown, convert?: (reading: number) => number): void => {
      const reading = finiteSignal(value)
      if (reading === undefined) return
      const converted = convert ? finiteSignal(convert(reading)) : reading
      if (converted !== undefined) out[key] = converted
    }

    try {
      for (const side of SIDES) {
        const [vitalReading] = biometricsDb.select().from(vitals)
          .where(eq(vitals.side, side)).orderBy(desc(vitals.timestamp)).limit(1).all()
        if (vitalReading && fresh(vitalReading.timestamp, VITALS_FRESH_MS)
          && isMechanicallyQualifiedVital(biometricsDb.$client, vitalReading.id, now)) {
          publish(`${side}.heartRate`, vitalReading.heartRate)
          publish(`${side}.hrv`, vitalReading.hrv)
          publish(`${side}.breathingRate`, vitalReading.breathingRate)
        }

        const [movementReading] = biometricsDb.select().from(movement)
          .where(eq(movement.side, side)).orderBy(desc(movement.timestamp)).limit(1).all()
        if (movementReading && fresh(movementReading.timestamp, MOVEMENT_FRESH_MS)) {
          publish(`${side}.movement`, movementReading.totalMovement)
        }
      }

      const [bedReading] = biometricsDb.select().from(bedTemp).orderBy(desc(bedTemp.timestamp)).limit(1).all()
      if (bedReading && fresh(bedReading.timestamp, ENV_FRESH_MS)) {
        publish('ambient.temperature', bedReading.ambientTemp, centiDegreesToF)
        publish('ambient.humidity', bedReading.humidity, centiPercentToPercent)
        const zonesBySide = {
          left: { outer: bedReading.leftOuterTemp, center: bedReading.leftCenterTemp, inner: bedReading.leftInnerTemp },
          right: { outer: bedReading.rightOuterTemp, center: bedReading.rightCenterTemp, inner: bedReading.rightInnerTemp },
        }
        for (const side of SIDES) {
          const zones = zonesBySide[side]
          const presentF = [zones.outer, zones.center, zones.inner]
            .filter((temperature): temperature is number => finiteSignal(temperature) !== undefined)
            .map(centiDegreesToF)
          if (presentF.length > 0) publish(`${side}.surfaceTemp`, mean(presentF))
          if (presentF.length >= 2) publish(`${side}.surfaceTemp.spread`, Math.max(...presentF) - Math.min(...presentF))
          const inner = finiteSignal(zones.inner)
          const outer = finiteSignal(zones.outer)
          if (inner !== undefined && outer !== undefined) {
            publish(`${side}.surfaceTemp.gradient`, centiDegreesToF(inner) - centiDegreesToF(outer))
          }
        }
      }

      const [waterReading] = biometricsDb.select().from(freezerTemp).orderBy(desc(freezerTemp.timestamp)).limit(1).all()
      if (waterReading && fresh(waterReading.timestamp, ENV_FRESH_MS)) {
        publish('left.waterTemp', waterReading.leftWaterTemp, centiDegreesToF)
        publish('right.waterTemp', waterReading.rightWaterTemp, centiDegreesToF)
      }

      const [lightReading] = biometricsDb.select().from(ambientLight).orderBy(desc(ambientLight.timestamp)).limit(1).all()
      if (lightReading && fresh(lightReading.timestamp, ENV_FRESH_MS) && lightReading.lux != null) {
        publish('ambient.light', lightReading.lux)
      }

      for (const side of SIDES) {
        const occ = getOccupancy(side)
        if (!occ.available) continue
        out[`${side}.presence`] = occ.classification === 'person' ? 1 : 0
        publish(`${side}.presence.zones`, occ.level.zones)
      }

      const cap = getLatestCapSenseSnapshot()
      if (cap && fresh(cap.receivedAtMs, CAP_FRESH_MS) && fresh(cap.ts * 1000, CAP_FRESH_MS)) {
        for (const side of SIDES) {
          const raw = cap[side]
          const channels = Array.isArray(raw) ? raw : [raw]
          if (channels.some(value => finiteSignal(value) === undefined)) continue
          const reduced = reduceCap(channels)
          if (reduced) {
            publish(`${side}.cap.max`, reduced.max)
            publish(`${side}.cap.mean`, reduced.mean)
            publish(`${side}.cap.spread`, reduced.spread)
          }
        }
      }
    }
    catch (err) {
      // Surface rather than swallow; the partial/empty snapshot makes dependent
      // rules skip, which is the safe default but shouldn't happen silently.
      console.warn('[automation] BiometricsSignalReader.read failed:', err)
    }
    return out
  }
}
