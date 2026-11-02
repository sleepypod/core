import type { ThermalRecording } from '../thermal-dataset'

/** Synthetic dynamic heat exchange exercises software only, never personal training or sleep claims. */
export function forecastRecordings(count = 24, humidityCoupling = 0.04): ThermalRecording[] {
  return Array.from({ length: count }, (_, nightIndex) => {
    const start = Date.UTC(2026, 8, 1 + nightIndex, 20)
    const date = new Date(start + 8 * 3_600_000).toISOString().slice(0, 10)
    const targetF = 69 + nightIndex % 3
    let waterF = targetF + 2
    const samples = Array.from({ length: 97 }, (_, index) => {
      const roomF = 73 + 2 * Math.sin(index / 12 + nightIndex % 3)
      const humidity = 50 + 8 * Math.sin(index / 9 + nightIndex % 4)
      const sample = { at: start + index * 300_000, context: { targetF, waterF, roomF, humidity } }
      waterF += 0.16 * (targetF - waterF) + 0.05 * (roomF - waterF) + humidityCoupling * (humidity - 45)
      return sample
    })
    return { date, samples }
  })
}
