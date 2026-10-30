import { expect, it } from 'vitest'
import { homeDiscovery } from '../mqttDiscovery'

it('advertises only qualified measurement fields with individual availability and expiry', () => {
  const entries = homeDiscovery('pod', 'private/pod', false)
  for (const [path, config] of entries) {
    if (path.includes('_clog/')) {
      expect(config).toBeNull()
      continue
    }
    expect(config?.availability_mode).toBe('all')
    expect(config?.availability).toEqual([
      { topic: 'private/pod/availability' },
      { topic: expect.stringMatching(/^private\/pod\//), value_template: expect.stringContaining('value_json.expiresAt') },
    ])
    expect(config).not.toHaveProperty('availability_topic')
    expect(config).not.toHaveProperty('temperature_command_topic')
    if (!path.startsWith('climate/')) expect(config?.expire_after).toBe(15)
  }
  const configs = new Map(entries)
  expect(configs.get('sensor/pod/water_level/config')).not.toHaveProperty('state_class')
  expect(configs.get('sensor/pod/ambient_humidity/config')?.availability).toEqual(expect.arrayContaining([
    expect.objectContaining({ value_template: expect.stringContaining('value_json.humidity is number') }),
  ]))
  expect(configs.get('binary_sensor/pod/left_occupancy/config')?.value_template).toContain('else \'None\'')
  expect(configs.get('sensor/pod/left_hrv/config')?.name).toBe('Left beat interval variability')
})

it('keeps the existing entity identifiers and command opt-in', () => {
  const configs = new Map(homeDiscovery('pod', 'private/pod', true))
  expect(configs.get('climate/pod/left/config')).toMatchObject({ unique_id: 'pod_left_climate',
    temperature_command_topic: 'private/pod/cmd/request', retain: false, qos: 0 })
  expect(configs.get('sensor/pod/left_hrv/config')?.unique_id).toBe('pod_left_hrv')
})
