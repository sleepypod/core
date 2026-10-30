import { mqttClimateCommandTemplate } from './mqttCommands'

/** Availability requires both a broker connection and a fresh source observation. */
export function homeDiscovery(id: string, base: string, commands: boolean): Array<[string, Record<string, unknown> | null]> {
  const device = { identifiers: [id], name: `Sleepypod ${id}`, manufacturer: 'Sleepypod', model: 'Pod' }
  const entries: Array<[string, Record<string, unknown> | null]> = []
  const available = (path: string, condition: string) => ({
    availability_mode: 'all',
    availability: [{ topic: `${base}/availability` }, {
      topic: `${base}/${path}`,
      value_template: `{{ 'online' if value_json.available and value_json.ts <= now().timestamp() * 1000 < value_json.expiresAt and (${condition}) else 'offline' }}`,
    }],
  })
  const add = (kind: string, key: string, name: string, path: string, field: string,
    unit?: string, deviceClass?: string) => {
    const numeric = kind === 'sensor' && !!unit
    const condition = numeric ? `value_json.${field} is number` : `value_json.${field} is not none`
    entries.push([`${kind}/${id}/${key}/config`, {
      name, unique_id: `${id}_${key}`, device, ...available(path, condition),
      state_topic: `${base}/${path}`,
      value_template: kind === 'binary_sensor'
        ? `{{ 'on' if value_json.available and value_json.${field} == true else 'off' if value_json.available and value_json.${field} == false else 'None' }}`
        : `{{ value_json.${field} if value_json.available and (${condition}) else 'None' }}`,
      expire_after: 15,
      ...(unit ? { unit_of_measurement: unit, state_class: 'measurement' } : {}),
      ...(deviceClass ? { device_class: deviceClass } : {}),
      ...(kind === 'binary_sensor' ? { payload_on: 'on', payload_off: 'off' } : {}),
    }])
  }
  add('sensor', 'water_level', 'Water level', 'state/water-level', 'level')
  add('sensor', 'ambient_temperature', 'Ambient temperature', 'state/environment/ambient', 'temperature', '°C', 'temperature')
  add('sensor', 'ambient_humidity', 'Ambient humidity', 'state/environment/ambient', 'humidity', '%', 'humidity')
  for (const side of ['left', 'right'] as const) {
    const label = side === 'left' ? 'Left' : 'Right'
    const path = `state/${side}/climate`
    entries.push([`climate/${id}/${side}/config`, {
      name: `${label} side`, unique_id: `${id}_${side}_climate`, device,
      ...available(path, 'value_json.mode is not none'),
      current_temperature_topic: `${base}/${path}`,
      current_temperature_template: '{{ value_json.currentTemperature if value_json.available and value_json.currentTemperature is number else \'None\' }}',
      temperature_state_topic: `${base}/${path}`,
      temperature_state_template: '{{ value_json.targetTemperature if value_json.available and value_json.targetTemperature is number else \'None\' }}',
      mode_state_topic: `${base}/${path}`,
      mode_state_template: '{{ value_json.mode if value_json.available else \'None\' }}',
      ...(commands
        ? {
            temperature_command_topic: `${base}/cmd/request`,
            temperature_command_template: mqttClimateCommandTemplate(side, 'temperature'),
            mode_command_topic: `${base}/cmd/request`,
            mode_command_template: mqttClimateCommandTemplate(side, 'power'), retain: false, qos: 0,
          }
        : {}),
      modes: ['off', 'heat'], min_temp: 55, max_temp: 110, temp_step: 1, temperature_unit: 'F',
    }])
    add('sensor', `${side}_heart_rate`, `${label} heart rate`, `state/biometrics/${side}`, 'heartRate', 'bpm')
    add('sensor', `${side}_breathing_rate`, `${label} breathing rate`, `state/biometrics/${side}`, 'breathingRate', 'br/min')
    add('sensor', `${side}_hrv`, `${label} beat interval variability`, `state/biometrics/${side}`, 'hrv', 'ms')
    add('binary_sensor', `${side}_occupancy`, `${label} bed occupancy`, `state/occupancy/${side}`, 'occupied', undefined, 'occupancy')
    add('sensor', `pump_${side}_rpm`, `${label} pump RPM`, `pump/${side}/rpm`, 'rpm', 'rpm')
    add('sensor', `pump_${side}_loop_temp`, `${label} pump loop temp`, `pump/${side}/loop_temp_c`, 'temperature', '°C', 'temperature')
    add('binary_sensor', `pump_${side}_stall`, `${label} pump stall warning`, `pump/${side}/stall`, 'active', undefined, 'problem')
    // Withdraw the previously advertised detector: no implementation measures clogs.
    entries.push([`binary_sensor/${id}/pump_${side}_clog/config`, null])
  }
  return entries
}
