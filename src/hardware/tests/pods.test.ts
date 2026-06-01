import { describe, expect, it } from 'vitest'

import { type PodCapabilities, POD_CAPS, getPodCapabilities } from '../pods'
import { PodVersion } from '../types'

describe('POD_CAPS manifest', () => {
  const allVersions = Object.values(PodVersion)

  it('has an entry for every PodVersion enum value', () => {
    for (const version of allVersions) {
      expect(POD_CAPS).toHaveProperty(version)
    }
  })

  it('has no extra entries beyond PodVersion enum values', () => {
    const manifestKeys = Object.keys(POD_CAPS)
    expect(manifestKeys.sort()).toEqual([...allVersions].sort())
  })

  it('sets packageManager only when hasPackageManager is true', () => {
    for (const [version, caps] of Object.entries(POD_CAPS) as Array<[PodVersion, PodCapabilities]>) {
      if (caps.hasPackageManager) {
        expect(caps.packageManager, `${version} has package manager but no packageManager field`).toBeDefined()
      }
      else {
        expect(caps.packageManager, `${version} has no package manager but packageManager is set`).toBeUndefined()
      }
    }
  })

  it('Yocto pods lack ensurepip and package manager', () => {
    for (const [, caps] of Object.entries(POD_CAPS) as Array<[PodVersion, PodCapabilities]>) {
      if (caps.os === 'yocto') {
        expect(caps.hasEnsurepip).toBe(false)
        expect(caps.hasPackageManager).toBe(false)
        expect(caps.hasIptablesPersistent).toBe(false)
      }
    }
  })

  it('Debian pods have ensurepip and package manager', () => {
    for (const [, caps] of Object.entries(POD_CAPS) as Array<[PodVersion, PodCapabilities]>) {
      if (caps.os === 'debian') {
        expect(caps.hasEnsurepip).toBe(true)
        expect(caps.hasPackageManager).toBe(true)
      }
    }
  })
})

describe('getPodCapabilities', () => {
  it('returns correct data for Pod 3', () => {
    const caps = getPodCapabilities(PodVersion.POD_3)
    expect(caps.modelName).toBe('Pod 3')
    expect(caps.os).toBe('yocto')
    expect(caps.iptablesPath).toBe('/sbin/iptables')
  })

  it('returns correct data for Pod 4', () => {
    const caps = getPodCapabilities(PodVersion.POD_4)
    expect(caps.modelName).toBe('Pod 4')
    expect(caps.os).toBe('yocto')
    expect(caps.pythonVersion).toBe('3.10')
  })

  it('returns correct data for Pod 5', () => {
    const caps = getPodCapabilities(PodVersion.POD_5)
    expect(caps.modelName).toBe('Pod 5')
    expect(caps.os).toBe('debian')
    expect(caps.iptablesPath).toBe('/usr/sbin/iptables')
    expect(caps.hasNftables).toBe(true)
    expect(caps.dacSocketPath).toBe('/persistent/deviceinfo/dac.sock')
  })

  it('returns the same object as POD_CAPS lookup', () => {
    for (const version of Object.values(PodVersion)) {
      expect(getPodCapabilities(version)).toBe(POD_CAPS[version])
    }
  })
})
