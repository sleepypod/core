import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'
import { homeSensors, ENVIRONMENT_LIFETIME_MS } from '@/src/telemetry/sensorCache'
import { buildAmbientSensor } from '../accessories/ambientSensor'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1700000000000)
  homeSensors.clear()
})
afterEach(() => {
  homeSensors.clear()
  vi.useRealTimers()
})

it('keeps the paired identity and faults until a real reading arrives, then expires it', async () => {
  const { service, stop } = buildAmbientSensor()
  expect(service.displayName).toBe('Pod ambient')
  expect(service.subtype).toBe('ambient')
  const characteristic = service.getCharacteristic(Characteristic.CurrentTemperature)
  await expect(characteristic.handleGetRequest()).rejects.toBe(-70402)
  homeSensors.record({ type: 'bedTemp', ts: Date.now() / 1000, amb: 2150 }, false, Date.now())
  vi.advanceTimersByTime(5000)
  expect(await characteristic.handleGetRequest()).toBe(21.5)
  expect(service.getCharacteristic(Characteristic.StatusFault).value).toBe(0)
  vi.advanceTimersByTime(ENVIRONMENT_LIFETIME_MS)
  await expect(characteristic.handleGetRequest()).rejects.toBe(-70402)
  expect(service.getCharacteristic(Characteristic.StatusFault).value).toBe(1)
  stop()
  expect(vi.getTimerCount()).toBe(0)
})

it('withdraws a previous value when the next firmware record has no ambient sensor', async () => {
  homeSensors.record({ type: 'bedTemp2', ts: Date.now() / 1000, left: { amb: 25 } }, false, Date.now())
  const { service, stop } = buildAmbientSensor()
  expect(await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()).toBe(25)
  vi.advanceTimersByTime(1000)
  homeSensors.record({ type: 'bedTemp2', ts: Date.now() / 1000, left: { amb: -327.68 } }, false, Date.now())
  await expect(service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()).rejects.toBe(-70402)
  stop()
})
