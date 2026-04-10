// Snoo data model — TypeScript port of pysnoo2

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum ResponsivenessLevel {
  VERY_LOW = 'lvl-2',
  LOW = 'lvl-1',
  NORMAL = 'lvl0',
  HIGH = 'lvl+1',
  VERY_HIGH = 'lvl+2',
}

export enum MinimalLevelVolume {
  VERY_LOW = 'lvl-2',
  LOW = 'lvl-1',
  NORMAL = 'lvl0',
  HIGH = 'lvl+1',
  VERY_HIGH = 'lvl+2',
}

export enum SoothingLevelVolume {
  NORMAL = 'lvl0',
  HIGH = 'lvl+1',
  VERY_HIGH = 'lvl+2',
}

export enum MinimalLevel {
  BASELINE = 'baseline',
  LEVEL1 = 'level1',
  LEVEL2 = 'level2',
}

export enum Sex {
  MALE = 'Male',
  FEMALE = 'Female',
}

export enum SessionLevel {
  ONLINE = 'ONLINE',
  BASELINE = 'BASELINE',
  WEANING_BASELINE = 'WEANING_BASELINE',
  LEVEL1 = 'LEVEL1',
  LEVEL2 = 'LEVEL2',
  LEVEL3 = 'LEVEL3',
  LEVEL4 = 'LEVEL4',
  NONE = 'NONE',
  PRETIMEOUT = 'PRETIMEOUT',
  TIMEOUT = 'TIMEOUT',
}

export enum SessionItemType {
  ASLEEP = 'asleep',
  SOOTHING = 'soothing',
  AWAKE = 'awake',
}

export enum EventType {
  ACTIVITY = 'activity',
  CRY = 'cry',
  TIMER = 'timer',
  COMMAND = 'command',
  SAFETY_CLIP = 'safety_clip',
  STATUS_REQUESTED = 'status_requested',
  STICKY_WHITE_NOISE_UPDATED = 'sticky_white_noise_updated',
  LONG_ACTIVITY_PRESS = 'long_activity_press',
  UNKNOWN = 'unknown',
}

export enum AggregatedSessionInterval {
  WEEK = 'week',
  MONTH = 'month',
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface SnooToken {
  accessToken: string
  tokenType: string
  expiresIn: number
  refreshToken: string
}

export interface User {
  email: string
  givenName: string
  region: string
  surname: string
  userId: string
  familyId: string
}

export interface SSID {
  name: string
  updatedAt: string
}

export interface Device {
  babyIds: string[]
  createdAt: string
  firmwareUpdateDate: string
  firmwareVersion: string
  lastProvisionSuccess: string
  lastSsid: SSID
  serialNumber: string
  timezone: string
  updatedAt: string
}

export interface Picture {
  id: string
  mime: string
  encoded: boolean
  updatedAt: string
}

export interface Settings {
  responsivenessLevel: ResponsivenessLevel
  minimalLevelVolume: MinimalLevelVolume
  soothingLevelVolume: SoothingLevelVolume
  minimalLevel: MinimalLevel
  motionLimiter: boolean
  weaning: boolean
  carRideMode: boolean
  daytimeStart: number
  stickyWhiteNoiseTimeout: number
}

export interface Baby {
  babyId: string
  babyName: string
  birthDate: string | null
  expectedBirthDate: string | null
  createdAt: string
  disabledLimiter: boolean
  pictures: Picture[]
  preemie: number | null
  settings: Settings
  sex: Sex | null
  updatedAt: string
  updatedByUserAt: string
}

export interface Signal {
  rssi: number
  strength: number
}

export interface StateMachine {
  upTransition: SessionLevel
  sinceSessionStartMs: number | null
  stickyWhiteNoise: boolean
  weaning: boolean
  timeLeftMs: number | null
  sessionId: string
  state: SessionLevel
  isActiveSession: boolean
  downTransition: SessionLevel
  hold: boolean
  audio: boolean
}

export interface ActivityState {
  leftSafetyClip: boolean
  rxSignal: Signal
  rightSafetyClip: boolean
  swVersion: string
  eventTime: Date
  stateMachine: StateMachine
  systemState: string
  event: EventType
}

export interface LastSession {
  endTime: string | null
  levels: SessionLevel[]
  startTime: string
}

export interface AggregatedSessionItem {
  isActive: boolean
  sessionId: string
  startTime: string
  stateDurationSec: number
  type: SessionItemType
}

export interface AggregatedSession {
  daySleepSec: number
  levels: AggregatedSessionItem[]
  longestSleepSec: number
  naps: number
  nightSleepSec: number
  nightWakings: number
  timezone: string
  totalSleepSec: number
}

export interface AggregatedDays {
  totalSleepSec: number[]
  daySleepSec: number[]
  nightSleepSec: number[]
  longestSleepSec: number[]
  nightWakings: number[]
}

export interface AggregatedSessionAvg {
  totalSleepAvgSec: number
  daySleepAvgSec: number
  nightSleepAvgSec: number
  longestSleepAvgSec: number
  nightWakingsAvg: number
  days: AggregatedDays | null
}

// ---------------------------------------------------------------------------
// Settings update (PATCH payload) — all fields optional
// ---------------------------------------------------------------------------

export interface SettingsUpdate {
  minimalLevel?: MinimalLevel
  minimalLevelVolume?: MinimalLevelVolume
  soothingLevelVolume?: SoothingLevelVolume
  responsivenessLevel?: ResponsivenessLevel
  motionLimiter?: boolean
  weaning?: boolean
  carRideMode?: boolean
  daytimeStart?: number
  stickyWhiteNoiseTimeout?: number
}

export interface BabyUpdate {
  babyName?: string
  birthDate?: string
  preemie?: number | null
  sex?: Sex | null
  settings?: SettingsUpdate
}

// ---------------------------------------------------------------------------
// PubNub command types
// ---------------------------------------------------------------------------

export interface StartSnooCommand {
  command: 'start_snoo'
}

export interface GoToStateCommand {
  command: 'go_to_state'
  state: SessionLevel
  hold?: 'on' | 'off'
}

export type SnooCommand = StartSnooCommand | GoToStateCommand
