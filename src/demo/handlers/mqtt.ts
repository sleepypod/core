import type { DemoHandlers, RouterOutputs } from '../types'

type Settings = RouterOutputs['mqtt']['getSettings']

const settings: Settings = {
  enabled: true,
  url: 'mqtt://192.0.2.20:1883',
  username: 'sleepypod',
  passwordIsSet: true,
  topicPrefix: 'sleepypod',
  haDiscovery: true,
  tlsEnabled: false,
  sources: {
    enabled: 'db',
    url: 'db',
    username: 'db',
    password: 'db',
    topicPrefix: 'db',
    haDiscovery: 'db',
    tlsEnabled: 'default',
  },
}

const bootedAt = Date.now()

export const mqtt: DemoHandlers<'mqtt'> = {
  getSettings: () => settings,

  updateSettings: (input) => {
    if ('enabled' in input) settings.enabled = input.enabled ?? false
    if ('url' in input) settings.url = input.url ?? null
    if ('username' in input) settings.username = input.username ?? null
    if ('password' in input) settings.passwordIsSet = !!input.password
    if ('topicPrefix' in input) settings.topicPrefix = input.topicPrefix ?? 'sleepypod'
    if ('haDiscovery' in input) settings.haDiscovery = input.haDiscovery ?? true
    if ('tlsEnabled' in input) settings.tlsEnabled = input.tlsEnabled ?? false
    return { success: true }
  },

  testConnection: () => ({ ok: true }),

  getStatus: () => {
    const connected = settings.enabled && settings.url !== null
    return {
      runState: connected ? 'connected' : 'stopped',
      connected,
      lastError: null,
      deviceId: 'sleepypod-demo',
      topicPrefix: connected ? settings.topicPrefix : null,
      // Roughly one state publish every 5 s since the page loaded.
      messagesPublished: connected ? 1840 + Math.floor((Date.now() - bootedAt) / 5000) : 0,
      lastPublishAt: connected ? new Date(Date.now() - 3000).toISOString() : null,
    }
  },
}
