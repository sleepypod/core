import { Service, Characteristic, HapStatusError } from 'hap-nodejs'
// HAP SERVICE_COMMUNICATION_FAILURE; the library exports this as an ambient const enum.
import { homeSensors } from '@/src/telemetry/sensorCache'

export interface AmbientSensorAccessory { service: Service, stop: () => void }

export function buildAmbientSensor(): AmbientSensorAccessory {
  const service = new Service.TemperatureSensor('Pod ambient', 'ambient')
  const read = (): number => {
    const reading = homeSensors.ambient()
    if (!reading.available || typeof reading.temperature !== 'number') {
      throw new HapStatusError(-70402)
    }
    return reading.temperature
  }
  const characteristic = service.getCharacteristic(Characteristic.CurrentTemperature)
    .setProps({ minValue: -100, maxValue: 100 }).onGet(read)
  const refresh = () => {
    try {
      characteristic.updateValue(read())
      service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT)
    }
    catch {
      characteristic.updateValue(new HapStatusError(-70402))
      service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT)
    }
  }
  refresh()
  const handle = setInterval(refresh, 5_000)
  handle.unref?.()
  return { service, stop: () => clearInterval(handle) }
}
