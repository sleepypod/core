import { formatSensorC, formatSetpointF } from '@/src/lib/tempUtils'
import type { TempUnit } from '@/src/lib/tempUtils'
import { meanTemperature, THERMAL_LABELS } from './thermalData'
import type { ThermalMode, ThermalSide, ThermalState } from './thermalData'

export interface PillContent {
  mode: ThermalMode
  label: string
  /** Mean surface reading, or '--' without one. */
  value: string
  /** The setpoint while the side is on; empty otherwise. */
  target: string
}

/** What a side's status pill says; shared by the 3D overlay and the flat fallback. */
export function pillContent(state: ThermalState, unit: TempUnit): PillContent {
  return {
    mode: state.mode,
    label: THERMAL_LABELS[state.mode],
    value: formatSensorC(meanTemperature(state.zones), unit, { includeUnit: false }),
    target: state.targetF === null ? '' : formatSetpointF(state.targetF, unit, { includeUnit: false }),
  }
}

export interface StatusPill { element: HTMLDivElement, value: HTMLSpanElement, target: HTMLSpanElement }

/** The pill's DOM, styled by `.thermal-pill` in globals.css; the scene positions it. */
export function createStatusPill(host: HTMLElement, side: ThermalSide): StatusPill {
  const element = document.createElement('div')
  element.className = 'thermal-pill'
  element.dataset.thermalPill = side
  const ring = document.createElement('span')
  ring.className = 'thermal-ring'
  const value = document.createElement('span')
  value.className = 'thermal-pill-value'
  const target = document.createElement('span')
  target.className = 'thermal-pill-target'
  element.append(ring, value, target)
  host.append(element)
  return { element, value, target }
}

export function fillStatusPill(pill: StatusPill, state: ThermalState, unit: TempUnit) {
  const content = pillContent(state, unit)
  pill.element.dataset.mode = content.mode
  pill.element.title = content.label
  pill.value.textContent = content.value
  pill.target.textContent = content.target ? `→ ${content.target}` : ''
  pill.target.hidden = content.target === ''
}
