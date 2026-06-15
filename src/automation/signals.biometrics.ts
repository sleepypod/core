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
 */

import { desc, eq } from 'drizzle-orm'
import { biometricsDb } from '@/src/db'
import { ambientLight, bedTemp, freezerTemp, movement, vitals } from '@/src/db/biometrics-schema'
import { centiDegreesToF, centiPercentToPercent } from '@/src/lib/tempUtils'
import { getLatestCapSenseSnapshot } from '@/src/streaming/piezoStream'
import { mean, reduceCap } from './capReduce'
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
    const fresh = (ts: Date | number, maxAgeMs: number): boolean =>
      now - (ts instanceof Date ? ts.getTime() : ts) <= maxAgeMs

    try {
      for (const side of SIDES) {
        const [v] = biometricsDb.select().from(vitals)
          .where(eq(vitals.side, side)).orderBy(desc(vitals.timestamp)).limit(1).all()
        if (v && fresh(v.timestamp, VITALS_FRESH_MS)) {
          if (v.heartRate != null) out[`${side}.heartRate`] = v.heartRate
          if (v.hrv != null) out[`${side}.hrv`] = v.hrv
          if (v.breathingRate != null) out[`${side}.breathingRate`] = v.breathingRate
        }

        const [m] = biometricsDb.select().from(movement)
          .where(eq(movement.side, side)).orderBy(desc(movement.timestamp)).limit(1).all()
        if (m && fresh(m.timestamp, MOVEMENT_FRESH_MS)) {
          out[`${side}.movement`] = m.totalMovement
        }
      }

      const [bt] = biometricsDb.select().from(bedTemp).orderBy(desc(bedTemp.timestamp)).limit(1).all()
      if (bt && fresh(bt.timestamp, ENV_FRESH_MS)) {
        if (bt.ambientTemp != null) out['ambient.temperature'] = centiDegreesToF(bt.ambientTemp)
        if (bt.humidity != null) out['ambient.humidity'] = centiPercentToPercent(bt.humidity)
        const zonesBySide = {
          left: { outer: bt.leftOuterTemp, center: bt.leftCenterTemp, inner: bt.leftInnerTemp },
          right: { outer: bt.rightOuterTemp, center: bt.rightCenterTemp, inner: bt.rightInnerTemp },
        }
        for (const side of SIDES) {
          const z = zonesBySide[side]
          const presentF = [z.outer, z.center, z.inner]
            .filter((t): t is number => t != null)
            .map(centiDegreesToF)
          if (presentF.length > 0) out[`${side}.surfaceTemp`] = mean(presentF)
          if (presentF.length >= 2) out[`${side}.surfaceTemp.spread`] = Math.max(...presentF) - Math.min(...presentF)
          if (z.inner != null && z.outer != null) out[`${side}.surfaceTemp.gradient`] = centiDegreesToF(z.inner) - centiDegreesToF(z.outer)
        }
      }

      const [fz] = biometricsDb.select().from(freezerTemp).orderBy(desc(freezerTemp.timestamp)).limit(1).all()
      if (fz && fresh(fz.timestamp, ENV_FRESH_MS)) {
        if (fz.leftWaterTemp != null) out['left.waterTemp'] = centiDegreesToF(fz.leftWaterTemp)
        if (fz.rightWaterTemp != null) out['right.waterTemp'] = centiDegreesToF(fz.rightWaterTemp)
      }

      const [al] = biometricsDb.select().from(ambientLight).orderBy(desc(ambientLight.timestamp)).limit(1).all()
      if (al && fresh(al.timestamp, ENV_FRESH_MS) && al.lux != null) {
        out['ambient.light'] = al.lux
      }

      const cap = getLatestCapSenseSnapshot()
      if (cap && fresh(cap.receivedAtMs, CAP_FRESH_MS)) {
        for (const side of SIDES) {
          const raw = cap[side]
          const r = reduceCap(Array.isArray(raw) ? raw : [raw])
          if (r) {
            out[`${side}.cap.max`] = r.max
            out[`${side}.cap.mean`] = r.mean
            out[`${side}.cap.spread`] = r.spread
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
