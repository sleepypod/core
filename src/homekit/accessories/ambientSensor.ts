/**
 * HomeKit TemperatureSensor accessory bound to the Pod's ambient air sensor.
 *
 * The Pod's bed unit ships an ambient temperature reading alongside the
 * fluid-temperature channels; biometrics modules persist it to
 * bed_temp.ambient_temp (centidegrees C) at roughly 60s cadence. This
 * accessory exposes the latest row as a generic HomeKit temperature
 * sensor so Home / automations can react to room conditions the same
 * way they would to any third-party thermometer.
 *
 * Poll cadence matches the upstream write rate — a faster poll would
 * just return the same row.
 */

import { Service, Characteristic } from 'hap-nodejs'
import { desc } from 'drizzle-orm'
import { biometricsDb } from '@/src/db'
import { bedTemp } from '@/src/db/biometrics-schema'
import { centiDegreesToC } from '@/src/lib/tempUtils'

const POLL_MS = 60_000

// Returned by onGet before the first DB read lands. HomeKit requires a
// numeric value; 20°C is a benign room-temperature sentinel that won't
// look like a sensor fault in the Home app.
const NEUTRAL_C = 20

export interface AmbientSensorAccessory {
  service: Service
  stop: () => void
}

async function readAmbientC(): Promise<number | null> {
  try {
    const [row] = await biometricsDb
      .select({ ambientTemp: bedTemp.ambientTemp })
      .from(bedTemp)
      .orderBy(desc(bedTemp.timestamp))
      .limit(1)
    if (!row || row.ambientTemp == null) return null
    return centiDegreesToC(row.ambientTemp)
  }
  catch (e) {
    console.warn('[homekit] ambient sensor read failed:', e instanceof Error ? e.message : e)
    return null
  }
}

export function buildAmbientSensor(): AmbientSensorAccessory {
  const service = new Service.TemperatureSensor('Pod ambient', 'ambient')
  let lastC: number = NEUTRAL_C

  service.getCharacteristic(Characteristic.CurrentTemperature)
    .onGet(() => lastC)

  const refresh = async (): Promise<void> => {
    const c = await readAmbientC()
    if (c == null) return
    lastC = c
    service.updateCharacteristic(Characteristic.CurrentTemperature, c)
  }
  void refresh()
  const handle = setInterval(() => void refresh(), POLL_MS)
  handle.unref()

  return {
    service,
    stop: () => clearInterval(handle),
  }
}
