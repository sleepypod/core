import { AutomationEngine, type AutomationEngineDeps } from '../engine'
import type { Side } from '../types'
import { TemperatureController, type TemperatureRequest } from '@/src/temperature/controller'

/** Existing evaluator fixtures now exercise the real arbiter above their fake transport. */
export interface EngineFixtureDeps extends Omit<AutomationEngineDeps, 'control'> {
  getHardware: () => {
    connect: () => Promise<void>
    setTemperature: (side: Side, temp: number, duration?: number) => Promise<void>
    setPower: (side: Side, on: boolean, temp?: number) => Promise<void>
  }
  withSideLock: <T>(side: Side, fn: () => Promise<T>) => Promise<T>
  pumpStallShouldBlock: (side: Side) => boolean
  broadcast: (side: Side, overlay: Record<string, unknown>) => void
  markMutated: (side: Side) => void
  hasActiveRunOnceSession: (side: Side) => Promise<boolean>
}

export function engineFixture(deps: EngineFixtureDeps) {
  const deadlines: Record<Side, number | null> = { left: null, right: null }
  const holds: Record<Side, TemperatureRequest | null> = { left: null, right: null }
  const runOnce: Record<Side, boolean> = { left: false, right: false }
  const powered: Record<Side, boolean> = { left: true, right: true }
  const control = new TemperatureController({
    now: deps.now,
    withSideLock: deps.withSideLock,
    readHold: side => holds[side],
    writeHold: (side, hold) => { holds[side] = hold },
    readBaseline: side => runOnce[side]
      ? [{
          id: 'run-once', source: 'run-once', temperature: 74, startsAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER, priority: 0, createdAt: 0,
        }]
      : [],
    isPowered: side => powered[side],
    readCurrentTarget: () => 75,
    readHardwareDeadline: side => deadlines[side],
    writeHardwareDeadline: (side, deadline) => { deadlines[side] = deadline },
    isBlocked: deps.pumpStallShouldBlock,
    connect: () => deps.getHardware().connect(),
    apply: async (side, temp, duration) => {
      await deps.getHardware().setTemperature(side, temp, duration)
      powered[side] = true
      deps.markMutated(side)
    },
    powerOff: async (side) => {
      powered[side] = false
      await deps.getHardware().setPower(side, false)
    },
    publish: () => {},
  })
  const engine = new AutomationEngine({
    ...deps,
    control: {
      automationBaseline: side => control.automationBaseline(side),
      powerOff: (side, isCurrent) => control.powerOff(side, isCurrent),
      replaceAutopilot: async (side, requests, powerOnIds, isCurrent) => {
        runOnce[side] = await deps.hasActiveRunOnceSession(side)
        return control.replaceAutopilot(side, requests, powerOnIds, isCurrent)
      },
    },
  })
  return { engine, control }
}
