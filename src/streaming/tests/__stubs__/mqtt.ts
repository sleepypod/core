/**
 * Test-only stub for the `mqtt` npm package.
 *
 * The package is added by sleepypod-core-28 (frontend PR). On this branch it
 * isn't installed yet, so vite's import-analysis fails to resolve the literal
 * `import mqtt from 'mqtt'` in src/streaming/mqttBridge.ts at transform time —
 * before any vi.mock factory can intercept it.
 *
 * vitest.config.mts aliases `mqtt` to this stub so the bridge module loads in
 * tests. Tests then layer vi.mock('mqtt', ...) on top to control behaviour.
 *
 * No real socket is ever opened — `connect` is a noop that returns a stub
 * client wired to throw on use, surfacing any test that accidentally relies
 * on real network IO.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

export type IClientOptions = Record<string, unknown>
export type IClientPublishOptions = Record<string, unknown>

export interface MqttClient {
  connected: boolean
  publish: (...args: any[]) => any
  subscribe: (...args: any[]) => any
  on: (...args: any[]) => any
  once: (...args: any[]) => any
  end: (...args: any[]) => any
}

function notImplemented(): never {
  throw new Error('mqtt stub: real client called in a test — vi.mock(\'mqtt\') was not applied')
}

const stubClient: MqttClient = {
  connected: false,
  publish: notImplemented,
  subscribe: notImplemented,
  on: notImplemented,
  once: notImplemented,
  end: notImplemented,
}

export function connect(_url: string, _opts?: IClientOptions): MqttClient {
  return stubClient
}

const mqttDefault = { connect }

export default mqttDefault
