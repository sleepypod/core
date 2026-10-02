import type { DemoHandlers, RouterOutputs } from '../types'

type Config = RouterOutputs['archivePush']['getConfig']['config']

// Not a real key — a placeholder of the right shape for the copy-to-clipboard UI.
const DEMO_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemo sleepypod-archive-push'

let config: Config = {
  enabled: false,
  host: '',
  remoteUser: '',
  remotePath: '',
  port: 22,
  identity: '/etc/sleepypod/archive-push.id_ed25519',
  include: ['raw', 'db'],
}
let publicKey: string | null = null

export const archivePush: DemoHandlers<'archivePush'> = {
  getConfig: () => ({ config, publicKey }),

  setConfig: (input) => {
    config = { ...input }
    return { ok: true }
  },

  generateKey: () => {
    const generated = publicKey === null
    publicKey = DEMO_PUBLIC_KEY
    return { publicKey, generated }
  },

  testConnection: () => {
    if (!config.host || !config.remoteUser) {
      return { ok: false, message: 'host and remoteUser must be set before testing' }
    }
    return { ok: true, message: `Connected to ${config.remoteUser}@${config.host}:${config.port}` }
  },
}
