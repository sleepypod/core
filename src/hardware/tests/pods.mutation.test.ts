import { describe, expect, it, vi } from 'vitest'

async function loadPodCapabilities() {
  // POD_CAPS is built at module load. Reload it while each static Stryker
  // mutant is active so catalog changes are observable instead of reading the
  // original object from Vitest's module cache.
  vi.resetModules()
  const { POD_CAPS } = await import('../pods')
  return POD_CAPS
}

describe('POD_CAPS mutation contract', () => {
  it('pins every deployed pod capability after a fresh module import', async () => {
    await expect(loadPodCapabilities()).resolves.toEqual({
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
    })
  })
})
