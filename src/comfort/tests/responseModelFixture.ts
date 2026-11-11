import { randomUUID } from 'node:crypto'
import type { ResponseWindow } from '../response-window'

const start = Date.UTC(2026, 9, 1, 22)

/** Artificial system identification fixture; these are not measurements or sleep-benefit evidence. */
export function responseModelWindows(stepResponse = 0.9): ResponseWindow[] {
  return Array.from({ length: 20 }, (_, night) => Array.from({ length: 4 }, (_, position) => {
    const at = start + night * 86_400_000 + position * 2 * 3_600_000
    const step = position % 2 ? 1 : -1, waterBeforeF = 68 + night % 4 * 0.5
    const roomF = 72 + position % 3 * 0.5, humidity = 45 + night % 3 * 3, waterChange5mF = (night % 3 - 1) / 10
    const response = (70 + step - waterBeforeF) * 0.2 + step * stepResponse + (roomF - waterBeforeF) * 0.08
      + waterChange5mF * 2 + (humidity - 50) * 0.005
    return { date: new Date(start + (night + 1) * 86_400_000).toISOString().slice(0, 10), attemptId: randomUUID(), at,
      acknowledgedAt: at + 100, confirmationAt: at + 30_000, beforeAt: at - 30_000, contextAt: at - 60_000,
      previousTargetF: 70, requestedTargetF: 70 + step, waterBeforeF, waterChange5mF, roomF, humidity,
      outcomes: ([15, 30] as const).map(minutes => ({ minutes, at: at + minutes * 60_000,
        waterF: waterBeforeF + response * minutes / 15, changeF: response * minutes / 15 })) }
  })).flat()
}
