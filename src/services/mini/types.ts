/**
 * TypeScript types matching the Snoo data model.
 * Populated in the TS Snoo client implementation step.
 */

export interface MiniSession {
  sessionId: string
  startTime: string
  endTime?: string
  levels: MiniLevel[]
}

export interface MiniStatus {
  isOnline: boolean
  babyName?: string
  firmwareVersion?: string
  lastSSID?: string
}

export interface MiniSettings {
  responsiveness: 'low' | 'normal' | 'high'
  volume: number
  weaning: boolean
  motionLimiter: boolean
}

export type MiniLevel = 'baseline' | 'level1' | 'level2' | 'level3' | 'level4'

export type MiniCommand = 'start' | 'stop' | 'level_up' | 'level_down' | 'toggle'
