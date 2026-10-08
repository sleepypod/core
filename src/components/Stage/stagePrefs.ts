'use client'

import { usePreference } from '@/src/components/Base/controls'
import type { ZoneMode } from './stageScene'

export const ZONE_MODES: readonly ZoneMode[] = ['hover', 'always', 'off']
export const ZONE_MODE_LABELS: Record<ZoneMode, string> = { hover: 'On hover', always: 'Always', off: 'Off' }

/** Whether the Temp screen shows the full-screen stage instead of the cards. */
export const useStageMode = () => usePreference('tempStage', 'false', ['true', 'false'])
/** When the six zone readings glow through the cover. */
export const useStageZones = () => usePreference<ZoneMode>('stageZones', 'hover', ZONE_MODES)
/** Drift the camera home after eight idle seconds with nothing selected. */
export const useStageAutoReturn = () => usePreference('stageAutoReturn', 'true', ['true', 'false'])
