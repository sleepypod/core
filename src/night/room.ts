import { nightRoomSchema, type NightExplanation } from './contract'
import { recordedJSON, type StoredNightRow } from './events'
import { bedroomReportSchema, bedroomSourceSchema, BEDROOM_METRICS } from '@/src/bedroom/contract'

/** Historical mappings stay attached to their report; a later rename never changes the evidence. */
export function roomObservation(row: StoredNightRow, side: 'left' | 'right'): NightExplanation['room'][number] | null {
  const source = bedroomSourceSchema.parse(recordedJSON(row.source))
  const report = bedroomReportSchema.parse(recordedJSON(row.report))
  if (source.id !== row.sourceId || report.sourceId !== source.id || report.revision !== row.revision
    || report.observedAt > Number(row.at)) throw new Error('Room report identity or clock mismatch')
  if (source.location !== 'room' && source.location !== side) return null
  if (!['temperature', 'humidity', 'pm25', 'co2', 'airQuality'].includes(source.metric)) return null
  let value = report.value
  if (value !== null && source.metric === 'temperature' && source.unit === '°C') value = value * 9 / 5 + 32
  const definition = BEDROOM_METRICS[source.metric]
  if (value !== null && (value < definition.minimum || value > definition.maximum)) throw new Error('Invalid room value')
  return nightRoomSchema.parse({ id: row.id, sourceId: source.id, revision: report.revision,
    label: `${source.deviceName} · ${source.label}`, metric: source.metric, value, unit: definition.unit,
    receivedAt: row.at, observedAt: report.observedAt, measuredAt: report.measuredAt, timeBasis: report.timeBasis })
}
