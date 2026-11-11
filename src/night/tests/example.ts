import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readNightExplanation } from '../reader'
import { nightWindow } from '../window'

/** Synthetic records through the actual migrated reader; never connected to a live Pod. */
export function nightExplanationExample(now = Date.now(), side: 'left' | 'right' = 'left', wakeDate?: string) {
  const main = new Database(':memory:'), biometrics = new Database(':memory:')
  try {
    migrate(drizzle(main), { migrationsFolder: path.resolve('src/db/migrations') })
    migrate(drizzle(biometrics), { migrationsFolder: path.resolve('src/db/biometrics-migrations') })
    main.prepare('INSERT INTO device_settings (id,timezone) VALUES (1,?)').run('America/Los_Angeles')
    const window = nightWindow('America/Los_Angeles', now, wakeDate)
    const first = window.start + 10 * 3600_000
    const through = Math.min(window.end - 4 * 3600_000, now - 60_000)
    if (through <= first) return readNightExplanation(main, biometrics, side, window.wakeDate, now)
    const decision = main.prepare('INSERT INTO comfort_events (side,observed_at,event) VALUES (?,?,?)')
    for (const offset of [0, 60_000, 120_000, 240_000]) {
      const at = first + offset
      if (at >= through) continue
      decision.run(side, at, JSON.stringify({ at, kind: 'preview', session: 'example-night', message: 'Illustrative: your manual hold kept the scheduled temperature in charge.',
        proposedF: 69, reportedF: 70, eligible: false, deviceObservedAt: at - 1000, presenceObservedAt: at - 1000, owner: 'manual' }))
    }
    main.prepare(`INSERT INTO temperature_applications (attempt_id,side,attempted_at,finished_at,outcome,request) VALUES (?,?,?,?,?,?)`)
      .run('11111111-1111-4111-8111-111111111111', side, first, first + 100, 'acknowledged', JSON.stringify({ side, targetF: 70, durationSec: null, reason: 'manual', source: 'manual', requestId: null }))
    const thermal = biometrics.prepare('INSERT INTO thermal_state (timestamp,side,is_powered,target_temp_f,current_temp_f) VALUES (?,?,?,?,?)')
    for (let at = first; at < through; at += 60_000) {
      // Deliberate recording gap remains blank in the chart, never smoothed over.
      if (at >= first + 2 * 3600_000 && at < first + 3 * 3600_000) continue
      thermal.run(at / 1000, side, 1, 70, 70 + 2 * Math.exp(-(at - first) / 600_000))
    }
    const source = { id: 'example-room', deviceId: 'example-homepod', deviceName: 'Example bedside sensor', label: 'Room temperature', provider: 'apple_home', externalId: 'example-temperature',
      model: '', location: 'room', metric: 'temperature', unit: '°F', maxAgeSeconds: 300, enabled: true, useForControl: false }
    main.prepare('INSERT INTO bedroom_history (revision,source_id,received_at,source,report) VALUES (1,?,?,?,?)')
      .run(source.id, first + 300_000, JSON.stringify(source), JSON.stringify({ schemaVersion: 1, revision: 1, sourceId: source.id,
        available: true, value: 72, observedAt: first + 299_000, measuredAt: null, timeBasis: 'cached' }))
    return readNightExplanation(main, biometrics, side, window.wakeDate, now)
  }
  finally {
    main.close()
    biometrics.close()
  }
}
