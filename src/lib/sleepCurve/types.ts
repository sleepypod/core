/**
 * Types for the SleepCurve temperature scheduling system.
 * Ported from sleepypod-ios/Sleepypod/Models/SleepCurve.swift
 */

/** Sleep phase identifiers for the temperature curve */
export type Phase
  = | 'warmUp' // Wind Down — gentle warming before bed
    | 'coolDown' // Fall Asleep — gradual cooling
    | 'deepSleep' // Deep Sleep — coldest hold
    | 'maintain' // Maintain — slight rise from deep
    | 'preWake' // Pre-Wake — warming toward wake
    | 'wake' // Wake — return to neutral

/** Display labels for each phase */
export const phaseLabels: Record<Phase, string> = {
  warmUp: 'Wind Down',
  coolDown: 'Fall Asleep',
  deepSleep: 'Deep Sleep',
  maintain: 'Maintain',
  preWake: 'Pre-Wake',
  wake: 'Wake',
}

/** Phase color mapping for chart visualization */
export const phaseColors: Record<Phase, string> = {
  warmUp: '#f59e0b', // amber
  coolDown: '#6366f1', // indigo
  deepSleep: '#2563eb', // blue
  maintain: '#8b5cf6', // violet
  preWake: '#f97316', // orange
  wake: '#eab308', // yellow
}

/** A single point on the temperature curve */
export interface CurvePoint {
  /** Minutes from bedtime (negative = before bed) */
  minutesFromBedtime: number
  /** Temperature offset from base (80°F), e.g. -6 = 74°F */
  tempOffset: number
  /** Which sleep phase this point belongs to */
  phase: Phase
}

/** Cooling intensity preset */
export type CoolingIntensity = 'cool' | 'balanced' | 'warm'

/** Display metadata for cooling intensity */
export const coolingIntensityMeta: Record<CoolingIntensity, { label: string, description: string }> = {
  cool: { label: 'Cool', description: 'Extra cooling for hot sleepers' },
  balanced: { label: 'Balanced', description: 'Science-backed defaults for most people' },
  warm: { label: 'Warm', description: 'Gentler cooling, warmer wake-up' },
}

/** Temperature offsets for each phase (relative to 80°F base) */
export interface PhaseOffsets {
  warmUp: number
  fallAsleep: number
  deepSleep: number
  maintain: number
  preWake: number
}

/** Ratios of available range each transitional phase uses (0–1) */
export interface PhaseRatios {
  warmUp: number
  fallAsleep: number
  maintain: number
}

/** Schedule entry: HH:mm → temperature °F */
export type ScheduleTemperatures = Record<string, number>
