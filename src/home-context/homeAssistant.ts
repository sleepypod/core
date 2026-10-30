import { configVersionSchema } from './contract'

/** JSON is valid YAML; return one importable HA automation per mapped sensor.
 * Only the publisher clock uses now(). A cached sensor timestamp is preserved.
 */
export function homeAssistantAutomations(input: unknown, topic: string) {
  const { revision, config } = configVersionSchema.parse(input)
  if (!/^[a-zA-Z0-9_/-]+\/room\/report$/.test(topic)) throw new Error('Room MQTT topic unavailable')
  return config.mappings.map((mapping) => {
    const timestampValue = `state_attr('${mapping.entityId}', '${mapping.timestampAttribute}')`
    const measuredSeconds = mapping.timestampFormat === 'iso8601'
      ? `as_timestamp(${timestampValue}, none)`
      : `(${timestampValue} | float(none))`
    const factor = mapping.timestampFormat === 'unix_milliseconds' ? 1 : 1000
    const payload = `{% set raw_time = ${measuredSeconds} %}
{% set measurement = (raw_time * ${factor}) | int if raw_time is not none else none %}
{% set raw_value = states('${mapping.entityId}') | float(none) %}
{% set usable = raw_value is not none and measurement is not none and state_attr('${mapping.entityId}', 'unit_of_measurement') == '${mapping.unit}' %}
{{ {'schemaVersion': 1, 'source': 'home_assistant', 'revision': ${revision}, 'metric': '${mapping.metric}', 'entityId': '${mapping.entityId}', 'unit': '${mapping.unit}', 'reportedAt': (as_timestamp(now()) * 1000) | int, 'measuredAt': measurement if usable else none, 'available': usable, 'value': raw_value if usable else none} | to_json }}`
    return {
      alias: `SleepyPod ${config.roomName} ${mapping.metric}`,
      description: 'Read-only sensor publisher. Verify the timestamp attribute is the source measurement time before enabling. Does not control the Pod or accessories.',
      triggers: [{ trigger: 'state', entity_id: mapping.entityId }, { trigger: 'time_pattern', seconds: '/30' }],
      actions: [{ action: 'mqtt.publish', data: { topic, qos: 0, retain: false, payload } }],
      mode: 'single',
    }
  })
}
