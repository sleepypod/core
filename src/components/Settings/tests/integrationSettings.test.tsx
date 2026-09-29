import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArchivePushSettingsForm } from '../ArchivePushSettingsForm'
import { HomeKitConfig } from '../HomeKitConfig'
import { DeviceSettingsForm } from '../DeviceSettingsForm'
const mock = vi.hoisted(() => ({ data: {} as Record<string, unknown>, loading: false, error: null as Error | null, calls: vi.fn(), invalidate: vi.fn(), pending: false, success: false }))
vi.mock('@/src/utils/trpc', () => {
  const endpoint = (name: string) => ({
    useQuery: () => ({ data: mock.data[name], isLoading: mock.loading }),
    useMutation: (opts?: { onSuccess?: () => void, onError?: (e: Error) => void }) => ({
      mutate: (input: unknown) => {
        mock.calls(name, input)
        if (mock.error) {
          opts?.onError?.(mock.error)
        }
        else {
          opts?.onSuccess?.()
        }
      },
      error: mock.error, data: mock.data[name], isPending: mock.pending, isSuccess: mock.success,
    }),
  })
  return { trpc: {
    useUtils: () => ({ archivePush: { getConfig: { invalidate: mock.invalidate } }, homekit: { getStatus: { invalidate: mock.invalidate } }, settings: { getAll: { invalidate: mock.invalidate } } }),
    archivePush: { getConfig: endpoint('config'), setConfig: endpoint('save'), generateKey: endpoint('generate'), testConnection: endpoint('test') },
    homekit: { getStatus: endpoint('homekit'), setEnabled: endpoint('enable'), unpair: endpoint('unpair') },
    settings: { updateDevice: endpoint('device') }, system: { triggerUpdate: endpoint('restart') },
  } }
})
beforeEach(() => {
  vi.clearAllMocks()
  mock.data = {}
  mock.loading = false
  mock.error = null
  mock.pending = false
  mock.success = false
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('saves archive destination and selected payload, generates a key and probes the saved connection', () => {
  mock.loading = true
  const { rerender } = render(<ArchivePushSettingsForm />)
  expect(screen.queryByText('Nightly archive push')).toBeNull()
  mock.loading = false
  rerender(<ArchivePushSettingsForm />)
  for (const [label, value] of [['Host', 'nas.local'], ['Port', '2222'], ['Remote user', 'pod'], ['Remote path', '/archive']]) fireEvent.change(screen.getByLabelText(label), { target: { value } })
  fireEvent.click(screen.getByRole('switch', { name: 'Enable nightly push' }))
  fireEvent.click(screen.getByRole('button', { name: 'RAW waveforms' }))
  fireEvent.click(screen.getByRole('button', { name: 'RAW waveforms' }))
  fireEvent.click(screen.getByRole('button', { name: 'biometrics.db' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(mock.calls).toHaveBeenCalledWith('save', expect.objectContaining({ enabled: true, host: 'nas.local', port: 2222, remoteUser: 'pod', remotePath: '/archive', include: ['raw'] }))
  fireEvent.click(screen.getByRole('button', { name: 'Generate ed25519 keypair' }))
  expect(mock.calls).toHaveBeenCalledWith('generate', {})
  fireEvent.click(screen.getByRole('button', { name: 'Test now' }))
  expect(mock.calls).toHaveBeenCalledWith('test', {})
  mock.data.test = { ok: false, message: 'Connection refused' }
  mock.error = new Error('Offline')
  rerender(<ArchivePushSettingsForm />)
  expect(screen.getByText('Failed')).toBeTruthy()
  expect(screen.getAllByText('Offline')).toHaveLength(3)
  mock.data.test = { ok: true, message: 'Ready' }
  mock.pending = true
  rerender(<ArchivePushSettingsForm />)
  expect(screen.getByText('Reachable')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Testing…' }).hasAttribute('disabled')).toBe(true)
})

it('copies an archive public key and tolerates clipboard failure', async () => {
  mock.data.config = { config: { enabled: false, host: '', remoteUser: '', remotePath: '', port: 22, identity: '/key', include: [] }, publicKey: 'ssh-ed25519 example' }
  const writeText = vi.fn().mockRejectedValueOnce(new Error('Blocked')).mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  render(<ArchivePushSettingsForm />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy key' })))
  fireEvent.click(screen.getByRole('button', { name: 'Copy key' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
  expect(writeText).toHaveBeenCalledWith('ssh-ed25519 example')
})

it('toggles HomeKit, formats pairing codes and confirms pairing reset', () => {
  const { rerender } = render(<HomeKitConfig />)
  mock.data.homekit = { enabled: false, running: false, pairedControllers: [] }
  rerender(<HomeKitConfig />)
  fireEvent.click(screen.getByRole('switch', { name: 'HomeKit bridge' }))
  expect(mock.calls).toHaveBeenCalledWith('enable', { enabled: true })
  mock.data.homekit = { enabled: true, running: false, pairedControllers: [] }
  rerender(<HomeKitConfig />)
  expect(screen.getByText('Starting')).toBeTruthy()
  mock.data.homekit = { enabled: true, running: true, pairedControllers: ['home'], pincode: '12345678', qrDataUrl: 'data:image/png;base64,AA==' }
  rerender(<HomeKitConfig />)
  expect(screen.getByText('123-45-678')).toBeTruthy()
  expect(screen.getByAltText('HomeKit pairing QR code')).toBeTruthy()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  fireEvent.click(screen.getByRole('button', { name: 'Reset HomeKit pairing' }))
  expect(mock.calls).not.toHaveBeenCalledWith('unpair', {})
  confirm.mockReturnValue(true)
  mock.error = new Error('Reset failed')
  fireEvent.click(screen.getByRole('button', { name: 'Reset HomeKit pairing' }))
  expect(screen.getByText('Reset failed')).toBeTruthy()
  mock.error = null
  fireEvent.click(screen.getByRole('button', { name: 'Reset HomeKit pairing' }))
  expect(mock.invalidate).toHaveBeenCalled()
  expect(screen.queryByText('Reset failed')).toBeNull()
  mock.data.homekit = { enabled: true, running: true, pairedControllers: [], pincode: 'invalid' }
  rerender(<HomeKitConfig />)
  expect(screen.getByText('invalid')).toBeTruthy()
  expect(screen.getByText(/None yet/)).toBeTruthy()
})

const device = {
  timezone: 'UTC', temperatureUnit: 'F', rebootDaily: false, rebootTime: null,
  primePodDaily: false, primePodTime: null, globalMaxOnHours: 7,
  ledNightModeEnabled: true, ledDayBrightness: 50, ledNightBrightness: 10, ledNightStartTime: null, ledNightEndTime: null,
  pumpStallProtectionEnabled: true, pumpStallRpmThreshold: 300, pumpStallDwellSamples: 3,
  pumpStallAutoRecoveryEnabled: true, pumpStallRecoveryRpm: 1000, pumpStallRecoverySamples: 3,
}
it('commits LED changes on release, clamps recovery inputs and confirms restarts', () => {
  vi.useFakeTimers()
  const { rerender } = render(<DeviceSettingsForm device={device} />)
  const day = screen.getByRole('slider', { name: 'LED brightness' })
  fireEvent.change(day, { target: { value: '60' } })
  expect(mock.calls).not.toHaveBeenCalled()
  fireEvent.pointerUp(day)
  expect(mock.calls).toHaveBeenLastCalledWith('device', { ledDayBrightness: 60 })
  const night = screen.getByRole('slider', { name: 'LED night brightness' })
  fireEvent.change(night, { target: { value: '20' } })
  fireEvent.keyUp(night, { key: 'ArrowRight' })
  expect(mock.calls).toHaveBeenLastCalledWith('device', { ledNightBrightness: 20 })
  for (const [label, value, key, expected] of [['Recovery RPM', '4000', 'pumpStallRecoveryRpm', 3000], ['Recovery samples', '20', 'pumpStallRecoverySamples', 10]] as const) {
    const input = screen.getByLabelText(label)
    fireEvent.change(input, { target: { value } })
    fireEvent.blur(input)
    expect(mock.calls).toHaveBeenLastCalledWith('device', { [key]: expected })
  }
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  fireEvent.click(screen.getByRole('button', { name: 'Restart service' }))
  expect(mock.calls).not.toHaveBeenCalledWith('restart', {})
  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: 'Restart service' }))
  expect(mock.calls).toHaveBeenCalledWith('restart', {})
  act(() => vi.advanceTimersByTime(1500))
  mock.error = new Error('Save failed')
  mock.success = true
  rerender(<DeviceSettingsForm device={{ ...device, timezone: 'Europe/London' }} />)
  expect(screen.getAllByText('Save failed')).toHaveLength(2)
  expect(screen.getByText('Service restarting — reconnecting…')).toBeTruthy()
})

it('reconnects by reloading the current page', () => {
  render(<DeviceSettingsForm device={device} />)
  const reload = vi.fn()
  const browserWindow = window
  vi.stubGlobal('window', new Proxy(browserWindow, {
    get(target, property) {
      return property === 'location' ? { reload } : Reflect.get(target, property, target)
    },
  }))
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(reload).toHaveBeenCalledOnce()
  }
  finally {
    vi.unstubAllGlobals()
  }
})
