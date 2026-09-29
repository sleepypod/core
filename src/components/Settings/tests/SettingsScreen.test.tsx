import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SettingsScreen } from '../SettingsScreen'
const mock = vi.hoisted(() => ({ query: '', push: vi.fn(), replace: vi.fn(), data: undefined as unknown, loading: false, error: null as Error | null }))
vi.mock('next/navigation', () => ({ usePathname: () => '/de/settings', useRouter: () => ({ push: mock.push, replace: mock.replace }), useSearchParams: () => new URLSearchParams(mock.query) }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Alex', rightName: 'Sam' }) }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  settings: { getAll: { useQuery: () => ({ data: mock.data, isLoading: mock.loading, error: mock.error }) } },
  biometrics: { getOccupancy: { useQuery: () => ({ data: { left: { available: true }, right: { available: false } } }) } },
} }))
vi.mock('../DeviceSettingsForm', () => ({ DeviceSettingsForm: () => <div>Device form</div> }))
vi.mock('../SideSettingsForm', () => ({ SideSettingsForm: ({ side, presenceAvailable }: { side: string, presenceAvailable: boolean }) => (
  <div>
    {'Side '}
    {side}
    {' '}
    {String(presenceAvailable)}
  </div>
) }))
vi.mock('../TapGestureConfig', () => ({ TapGestureConfig: ({ filterSide }: { filterSide: string }) => (
  <div>
    {'Gestures '}
    {filterSide}
  </div>
) }))
vi.mock('../MqttSettingsForm', () => ({ MqttSettingsForm: () => <div>MQTT form</div> }))
vi.mock('../HomeKitConfig', () => ({ HomeKitConfig: () => <div>HomeKit form</div> }))
vi.mock('../ArchivePushSettingsForm', () => ({ ArchivePushSettingsForm: () => <div>Backup form</div> }))
vi.mock('@/src/components/status/InternetToggleCard', () => ({ InternetToggleCard: () => <div>Network form</div> }))
vi.mock('@/src/components/status/UpdateCard', () => ({ UpdateCard: () => <div>Update form</div> }))
vi.mock('@/src/components/status/SystemInfoCard', () => ({ SystemInfoCard: () => <div>System info</div> }))
vi.mock('../AppearanceSettings', () => ({
  AppearanceSettings: ({ temperatureUnit }: { temperatureUnit: string }) => (
    <div>
      {'Appearance '}
      {temperatureUnit}
    </div>
  ),
  TempControlPicker: () => <div>Control picker</div>, TempDisplayControl: () => null, ThemeControl: () => null, UnitsControl: () => null,
}))
beforeEach(() => {
  vi.clearAllMocks()
  mock.query = ''
  mock.data = { device: { temperatureUnit: 'C' }, sides: { left: {}, right: {} } }
  mock.loading = false
  mock.error = null
})

it('opens phone sections, preserves unrelated parameters and clears legacy navigation on back', () => {
  mock.query = 'other=keep'
  const { rerender } = render(<SettingsScreen />)
  fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
  expect(mock.push).toHaveBeenCalledWith('?other=keep&section=appearance', { scroll: false })
  expect(screen.getByRole('link', { name: /Docs/ }).getAttribute('href')).toBe('https://sleepypod.github.io/')
  mock.query = 'section=appearance&tab=old'
  rerender(<SettingsScreen />)
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  expect(mock.replace).toHaveBeenCalledWith('?', { scroll: false })
})

it.each([
  ['device', 'Device form'], ['appearance', 'Appearance C'], ['gestures', 'Gestures left'],
  ['mqtt', 'MQTT form'], ['homekit', 'HomeKit form'], ['backup', 'Backup form'],
  ['network', 'Network form'], ['updates', 'Update form'], ['sides', 'Side left true'],
])('renders %s section', (section, text) => {
  mock.query = `section=${section}`
  render(<SettingsScreen />)
  expect(screen.getByText(text)).toBeTruthy()
  if (section === 'sides') {
    fireEvent.click(screen.getAllByRole('tab', { name: 'Sam' })[0])
    expect(screen.getByText('Side right false')).toBeTruthy()
  }
})

it('handles loading, absent settings, errors and legacy status links', () => {
  mock.query = 'section=device'
  mock.loading = true
  mock.data = undefined
  const { rerender } = render(<SettingsScreen />)
  expect(screen.queryByText('Device form')).toBeNull()
  mock.loading = false
  rerender(<SettingsScreen />)
  expect(screen.queryByText('Device form')).toBeNull()
  mock.error = new Error('Offline')
  rerender(<SettingsScreen />)
  expect(screen.getByText('Failed to load settings: Offline')).toBeTruthy()
  mock.query = 'tab=status'
  rerender(<SettingsScreen />)
  expect(mock.replace).toHaveBeenCalledWith('/de/system')
})
