import type { PodVersion } from './types'

export interface PodCapabilities {
  /** Human-readable model name */
  modelName: string
  /** Base OS type */
  os: 'yocto' | 'debian'
  /** Absolute path to iptables binary */
  iptablesPath: string
  /** Whether a system package manager is available */
  hasPackageManager: boolean
  /** Which package manager, if any */
  packageManager?: 'apt'
  /** Default Python version shipped with the image */
  pythonVersion: string
  /** Whether python3 -m ensurepip works reliably */
  hasEnsurepip: boolean
  /** Whether nftables is available (Debian pods) */
  hasNftables: boolean
  /** Path to DAC hardware socket */
  dacSocketPath: string
  /** Whether iptables-persistent is available for rule persistence */
  hasIptablesPersistent: boolean
}

export const POD_CAPS: Record<PodVersion, PodCapabilities> = {
  H00: {
    modelName: 'Pod 3',
    os: 'yocto',
    iptablesPath: '/sbin/iptables',
    hasPackageManager: false,
    pythonVersion: '3.9',
    hasEnsurepip: false,
    hasNftables: false,
    dacSocketPath: '/deviceinfo/dac.sock',
    hasIptablesPersistent: false,
  },
  I00: {
    modelName: 'Pod 4',
    os: 'yocto',
    iptablesPath: '/sbin/iptables',
    hasPackageManager: false,
    pythonVersion: '3.10',
    hasEnsurepip: false,
    hasNftables: false,
    dacSocketPath: '/deviceinfo/dac.sock',
    hasIptablesPersistent: false,
  },
  J00: {
    modelName: 'Pod 5',
    os: 'debian',
    iptablesPath: '/usr/sbin/iptables',
    hasPackageManager: true,
    packageManager: 'apt',
    pythonVersion: '3.10',
    hasEnsurepip: true,
    hasNftables: true,
    dacSocketPath: '/persistent/deviceinfo/dac.sock',
    hasIptablesPersistent: true,
  },
}

/** Get capabilities for a specific pod version */
export function getPodCapabilities(version: PodVersion): PodCapabilities {
  return POD_CAPS[version]
}
