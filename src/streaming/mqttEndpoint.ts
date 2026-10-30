/** Shared by the form and server; a TLS requirement must never rely on an unencrypted URL. */
export function mqttEndpointIssue(value: string | null, requireTls: boolean): string | null {
  if (!value) return 'Enter a broker URL.'
  let endpoint: URL
  try {
    endpoint = new URL(value)
  }
  catch { return 'Enter a valid MQTT broker URL.' }
  if (!endpoint.hostname || !['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(endpoint.protocol)) {
    return 'Use an mqtt://, mqtts://, ws:// or wss:// broker URL.'
  }
  if (requireTls && endpoint.protocol !== 'mqtts:' && endpoint.protocol !== 'wss:') {
    return 'TLS requires an mqtts:// or wss:// broker URL. Update the URL and port.'
  }
  return null
}
