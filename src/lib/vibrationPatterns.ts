/**
 * Shared vibration pattern presets.
 * Used by: AlarmScheduleSection (quick-select), HapticsTestCard (test patterns).
 * Single source of truth — no duplication.
 */

export interface VibrationPattern {
  name: string
  intensity: number // 1-100
  pattern: 'rise' | 'double'
  duration: number // seconds
  description: string
}

export const VIBRATION_PRESETS: VibrationPattern[] = [
  { name: 'Gentle Wake', intensity: 30, pattern: 'rise', duration: 10, description: 'Soft rising vibration' },
  { name: 'Standard Alarm', intensity: 50, pattern: 'rise', duration: 30, description: 'Default alarm pattern' },
  { name: 'Urgent Wake', intensity: 80, pattern: 'double', duration: 15, description: 'Strong double-burst' },
  { name: 'Nudge', intensity: 20, pattern: 'double', duration: 3, description: 'Quick gentle tap' },
  { name: 'Pulse Train', intensity: 60, pattern: 'double', duration: 20, description: 'Repeated double bursts' },
  { name: 'Deep Sleeper', intensity: 100, pattern: 'rise', duration: 60, description: 'Maximum intensity ramp' },
  { name: 'Meditation End', intensity: 15, pattern: 'rise', duration: 5, description: 'Barely noticeable fade-in' },
]
