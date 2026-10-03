import { describe, expect, it } from 'vitest'
import {
  classifyFirmware,
  expectedTransport,
  FIRMWARE_LABELS,
  firmwareProbed,
  type FirmwareSignals,
} from '../firmwareGeneration'

const none: FirmwareSignals = {
  natsUnitInstalled: false,
  natsServerActive: false,
  jetstreamDirPresent: false,
  biometricsTmpfsMounted: false,
  frankShimRoutesTmpfs: false,
  frankServiceRoutesTmpfs: false,
}
const dev: FirmwareSignals = {
  natsUnitInstalled: null,
  natsServerActive: null,
  jetstreamDirPresent: false,
  biometricsTmpfsMounted: null,
  frankShimRoutesTmpfs: false,
  frankServiceRoutesTmpfs: null,
}

describe('classifyFirmware', () => {
  it('calls it NATS on installation identity, even while the server is down', () => {
    expect(classifyFirmware({ ...none, natsUnitInstalled: true })).toBe('nats')
    expect(classifyFirmware({ ...none, jetstreamDirPresent: true })).toBe('nats')
    expect(classifyFirmware({ ...none, natsServerActive: true })).toBe('nats')
    // NATS wins over a leftover tmpfs mount from before the firmware update.
    expect(classifyFirmware({ ...none, jetstreamDirPresent: true, biometricsTmpfsMounted: true, frankShimRoutesTmpfs: true })).toBe('nats')
  })

  it('distinguishes the .RAW routing variants in sp-status order', () => {
    expect(classifyFirmware({ ...none, biometricsTmpfsMounted: true, frankShimRoutesTmpfs: true })).toBe('raw-tmpfs-shim')
    expect(classifyFirmware({ ...none, biometricsTmpfsMounted: true, frankServiceRoutesTmpfs: true })).toBe('raw-tmpfs-service')
    // Shim wins when both are present, like the shell diagnostic.
    expect(classifyFirmware({ ...none, biometricsTmpfsMounted: true, frankShimRoutesTmpfs: true, frankServiceRoutesTmpfs: true })).toBe('raw-tmpfs-shim')
    expect(classifyFirmware({ ...none, biometricsTmpfsMounted: true })).toBe('raw-tmpfs-unverified')
  })

  it('falls back to plain filesystem .RAW when nothing else is seen', () => {
    expect(classifyFirmware(none)).toBe('raw-filesystem')
    // Shim text without the tmpfs mounted does not count as tmpfs routing.
    expect(classifyFirmware({ ...none, frankShimRoutesTmpfs: true })).toBe('raw-filesystem')
    expect(classifyFirmware(dev)).toBe('raw-filesystem')
  })

  it('maps every generation to a transport and a label', () => {
    for (const g of Object.keys(FIRMWARE_LABELS) as Array<keyof typeof FIRMWARE_LABELS>) {
      expect(expectedTransport(g)).toBe(g === 'nats' ? 'nats' : 'raw')
      expect(FIRMWARE_LABELS[g].label.length).toBeGreaterThan(0)
      expect(FIRMWARE_LABELS[g].detail.length).toBeGreaterThan(0)
    }
  })
})

describe('firmwareProbed', () => {
  it('is false only when every systemd/mount probe was unavailable', () => {
    expect(firmwareProbed(dev)).toBe(false)
    expect(firmwareProbed(none)).toBe(true)
    expect(firmwareProbed({ ...dev, natsServerActive: false })).toBe(true)
    expect(firmwareProbed({ ...dev, frankServiceRoutesTmpfs: false })).toBe(true)
  })
})
