import type { Binding, Side } from './model'
export interface RemoteActionDeps {
  state(side: Side): Promise<{
    targetTemperature: number | null
    isPowered: boolean
    isAlarmVibrating: boolean
  }>
  away(side: Side): Promise<boolean>
  setTemperature(side: Side, temperature: number): Promise<unknown>
  setPower(side: Side, powered: boolean): Promise<unknown>
  clearAlarm(side: Side): Promise<unknown>
  snoozeAlarm(side: Side, duration: number): Promise<unknown>
  setAway(side: Side, awayMode: boolean): Promise<unknown>
  prime(): Promise<unknown>
  runAutomation(id: number): Promise<unknown>
}
/** All device mutations are delegated to the same procedures as manual controls. */
/** Execute one validated software binding through device dependencies and return its diagnostic outcome. */
export async function executeRemoteAction(binding: Binding, side: Side, deps: RemoteActionDeps): Promise<string> {
  switch (binding.action) {
    case 'none': return 'No custom action; native firmware remains active'
    case 'temp.up':
    case 'temp.down': {
      const state = await deps.state(side)
      if (state.targetTemperature === null || !Number.isFinite(state.targetTemperature))
        throw new Error('Current target temperature is unavailable')
      const delta = binding.deltaF * (binding.action === 'temp.up' ? 1 : -1)
      await deps.setTemperature(side, Math.min(110, Math.max(55, state.targetTemperature + delta)))
      break
    }
    case 'temp.preset':
      await deps.setTemperature(side, binding.temperatureF)
      break
    case 'power.toggle':
      await deps.setPower(side, !(await deps.state(side)).isPowered)
      break
    case 'power.off':
      await deps.setPower(side, false)
      break
    case 'alarm.off':
      await deps.clearAlarm(side)
      break
    case 'alarm.snooze':
      if (!(await deps.state(side)).isAlarmVibrating)
        return 'Skipped: no active alarm'
      await deps.snoozeAlarm(side, binding.durationSec)
      break
    case 'away.toggle':
      await deps.setAway(side, !(await deps.away(side)))
      break
    case 'prime.start':
      await deps.prime()
      break
    case 'automation.run':
      await deps.runAutomation(binding.automationId)
      return 'Evaluated automation; see its run history'
  }
  return 'Completed'
}
