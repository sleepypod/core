/** Shared types for the Biometrics/Data screen composition */

export type Side = 'left' | 'right'

export interface SleepRecord {
  id: number
  side: Side
  enteredBedAt: Date
  leftBedAt: Date
  sleepDurationSeconds: number
  timesExitedBed: number
}

export interface VitalsSummary {
  avgHeartRate: number | null
  minHeartRate: number | null
  maxHeartRate: number | null
  avgHRV: number | null
  avgBreathingRate: number | null
  recordCount: number
}

export interface VitalsRecord {
  id: number
  side: Side
  timestamp: Date
  heartRate: number | null
  hrv: number | null
  breathingRate: number | null
}

export interface MovementRecord {
  id: number
  side: Side
  timestamp: Date
  totalMovement: number
}
