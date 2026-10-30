import { describe, expect, it } from 'vitest'
import { mqttEndpointIssue } from '../mqttEndpoint'

describe('MQTT endpoint requirements', () => {
  it.each(['mqtts://broker:8883', 'wss://broker/mqtt', 'MQTTS://broker:1883', 'mqtts://[::1]:8883'])('accepts the explicit secure endpoint %s', (url) => {
    expect(mqttEndpointIssue(url, true)).toBeNull()
    expect(mqttEndpointIssue(url, false)).toBeNull()
  })
  it.each(['mqtt://broker:1883', 'ws://broker:8080/mqtt'])('requires an explicit secure URL for %s', (url) => {
    expect(mqttEndpointIssue(url, false)).toBeNull()
    expect(mqttEndpointIssue(url, true)).toContain('TLS requires')
  })
  it.each([null, '', 'broker', 'https://broker', 'file:///tmp/broker', 'tcp://broker', 'mqtt:///path', 'mqtts://'])('refuses an invalid or unsupported endpoint %s', (url) => {
    expect(mqttEndpointIssue(url, false)).not.toBeNull()
    expect(mqttEndpointIssue(url, true)).not.toBeNull()
  })
})
