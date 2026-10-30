import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MqttSettingsForm } from '../MqttSettingsForm'

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>, update: vi.fn(), test: vi.fn(), invalidate: vi.fn(),
  result: null as { ok: boolean } | null,
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ mqtt: { getSettings: { invalidate: state.invalidate }, getStatus: { invalidate: state.invalidate } } }),
  mqtt: {
    getSettings: { useQuery: () => ({ data: state.settings, isLoading: false }) },
    getStatus: { useQuery: () => ({ data: { connected: false, messagesPublished: 0, commandsEnabled: false } }) },
    updateSettings: { useMutation: () => ({ mutate: state.update, isPending: false }) },
    testConnection: { useMutation: () => ({ mutate: state.test, data: state.result, isPending: false, reset: () => { state.result = null } }) },
  },
} }))
beforeEach(() => {
  vi.clearAllMocks()
  state.result = null
  state.settings = {
    enabled: true, url: 'mqtt://broker:1883', username: 'owner', passwordIsSet: true,
    topicPrefix: 'sleepypod', haDiscovery: true, tlsEnabled: false,
    sources: { enabled: 'db', url: 'db', username: 'db', password: 'db', topicPrefix: 'db', haDiscovery: 'db', tlsEnabled: 'db' },
  }
})

it('requires an explicit secure URL without rewriting the selected broker or port', () => {
  render(<MqttSettingsForm />)
  fireEvent.click(screen.getByRole('switch', { name: 'Toggle TLS' }))
  expect((screen.getByLabelText(/Broker URL/) as HTMLInputElement).value).toBe('mqtt://broker:1883')
  expect(screen.getByText(/TLS requires an mqtts/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Test connection' }).hasAttribute('disabled')).toBe(true)
  expect(state.test).not.toHaveBeenCalled()
  expect(state.update).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText(/Broker URL/), { target: { value: 'wss://broker:8081/mqtt' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ url: 'wss://broker:8081/mqtt', tlsEnabled: true }))
})
it('allows disabling an invalid configuration', () => {
  state.settings.tlsEnabled = true
  render(<MqttSettingsForm />)
  fireEvent.click(screen.getByRole('switch', { name: 'Toggle MQTT bridge' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
})
it('checks the resolved environment URL and uses only newly entered test credentials', () => {
  state.settings.tlsEnabled = true
  state.settings.sources = { ...(state.settings.sources as object), url: 'env' }
  render(<MqttSettingsForm />)
  expect((screen.getByLabelText(/Broker URL/) as HTMLInputElement).value).toBe('')
  expect(screen.getByRole('button', { name: 'Test connection' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText(/Broker URL/), { target: { value: 'mqtts://new-broker:8883' } })
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  expect(state.test).toHaveBeenLastCalledWith({ url: 'mqtts://new-broker:8883', username: 'owner', tlsEnabled: true })
  expect(screen.getByText(/Enter a password when testing a different broker or account/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'synthetic-test-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  expect(state.test).toHaveBeenLastCalledWith(expect.objectContaining({ password: 'synthetic-test-password' }))
})
it('removes an old connection result when the endpoint or TLS requirement changes', () => {
  state.result = { ok: true }
  render(<MqttSettingsForm />)
  expect(screen.getByText('Connection succeeded.')).toBeTruthy()
  fireEvent.change(screen.getByLabelText(/Broker URL/), { target: { value: 'mqtt://different-broker' } })
  expect(screen.queryByText('Connection succeeded.')).toBeNull()
})
it('leaves secure URLs encrypted even when TLS is not required', () => {
  state.settings.url = 'mqtts://broker:8883'
  render(<MqttSettingsForm />)
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  expect(state.test).toHaveBeenCalledWith(expect.objectContaining({ url: 'mqtts://broker:8883', tlsEnabled: false }))
})
it('tests the saved password without exposing it when the broker identity is unchanged', () => {
  render(<MqttSettingsForm />)
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  expect(state.test).toHaveBeenCalledWith({ url: 'mqtt://broker:1883', username: 'owner', tlsEnabled: false, useSavedPassword: true })
})
