import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MqttSettingsForm } from '../MqttSettingsForm'

const m = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, update: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ mqtt: { getSettings: { invalidate: vi.fn() }, getStatus: { invalidate: vi.fn() } } }),
    mqtt: {
      getSettings: { useQuery: () => ({ data: m.settings, isLoading: false }) },
      getStatus: { useQuery: () => ({ data: { connected: true, messagesPublished: 0, lastPublishAt: null }, isLoading: false }) },
      updateSettings: { useMutation: () => ({ mutate: m.update, isPending: false }) },
      testConnection: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}))

beforeEach(() => {
  m.update.mockReset()
  m.settings = {
    enabled: true,
    url: 'mqtt://broker.local:1883',
    username: null,
    passwordIsSet: false,
    topicPrefix: 'sleepypod',
    haDiscovery: true,
    tlsEnabled: false,
    presenceHoldSeconds: 0,
    sources: { enabled: 'db', url: 'db', username: 'default', password: 'default', topicPrefix: 'default', haDiscovery: 'default', tlsEnabled: 'default', presenceHoldSeconds: 'default' },
  }
})
afterEach(cleanup)

it('sets the presence hold in 5 s steps and saves it', () => {
  render(<MqttSettingsForm />)
  expect(screen.getByText('Off')).toBeTruthy()
  expect(screen.getByText('In bed updates the moment the sensor sees you get in or out.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Increase presence hold' }))
  fireEvent.click(screen.getByRole('button', { name: 'Increase presence hold' }))
  expect(screen.getByText('10 s')).toBeTruthy()
  expect(screen.getByText(/once you've been in or out for 10 s/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ presenceHoldSeconds: 10 }))
})

it('leaves an unchanged hold out of the save, so an env value isn\'t pinned', () => {
  m.settings = { ...m.settings, presenceHoldSeconds: 20, sources: { ...(m.settings.sources as object), presenceHoldSeconds: 'env' } }
  render(<MqttSettingsForm />)
  expect(screen.getByText('20 s')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(m.update.mock.calls[0][0]).not.toHaveProperty('presenceHoldSeconds')
})
