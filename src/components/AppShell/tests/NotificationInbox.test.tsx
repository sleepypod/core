import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationPage } from '@/src/notifications/contract'
import { ToastProvider } from '@/src/components/ds'
import { NotificationInbox } from '../NotificationInbox'

const state = vi.hoisted(() => ({
  latest: { data: undefined as NotificationPage | undefined, isError: false, refetch: vi.fn() },
  history: { data: undefined as NotificationPage | undefined, isError: false, refetch: vi.fn() },
  mutation: { isPending: false, mutateAsync: vi.fn() },
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: { notifications: {
  list: { useQuery: ({ beforeId }: { beforeId?: number }) => beforeId === undefined ? state.latest : state.history },
  acknowledge: { useMutation: () => state.mutation },
} } }))
const item = { id: 2, source: 'automation' as const, sourceId: 7, title: 'Humidity changed', message: '<script>literal text</script>', createdAt: 100, expiresAt: 1000, acknowledgedAt: null }
const page: NotificationPage = { apiVersion: 1, generatedAt: 150, newestId: 2, nextBeforeId: null, unreadCount: 1, items: [item], delivery: { foregroundInbox: true, backgroundPush: false } }
const ui = <ToastProvider><NotificationInbox /></ToastProvider>
beforeEach(() => {
  vi.clearAllMocks()
  state.latest = { data: structuredClone(page), isError: false, refetch: vi.fn().mockResolvedValue({}) }
  state.history = { data: undefined, isError: false, refetch: vi.fn().mockResolvedValue({}) }
  state.mutation = { isPending: false, mutateAsync: vi.fn().mockResolvedValue({ acknowledgedIds: [2], missingIds: [] }) }
})
describe('owner alert inbox', () => {
  it('shows history without replaying toasts, renders messages as text, and traps/restores keyboard focus', () => {
    render(ui)
    const trigger = screen.getByRole('button', { name: 'Alerts, 1 unread' })
    expect(screen.queryByTestId('toast')).toBeNull()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Automation alerts' })
    expect(within(dialog).getByText(item.message)).toBeTruthy()
    expect(dialog.querySelector('script')).toBeNull()
    expect(dialog.textContent).toContain('Background push is not available')
    const close = within(dialog).getByRole('button', { name: 'Close' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Mark Humidity changed read' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('announces a newly polled alert once and does not acknowledge merely opening it', () => {
    const { rerender } = render(ui)
    state.latest.data = { ...page, newestId: 3, unreadCount: 2, items: [{ ...item, id: 3 }, item] }
    rerender(<ToastProvider><NotificationInbox /></ToastProvider>)
    expect(screen.getByTestId('toast').textContent).toContain('Humidity changed')
    fireEvent.click(screen.getByRole('button', { name: 'Alerts, 2 unread' }))
    expect(state.mutation.mutateAsync).not.toHaveBeenCalled()
  })

  it('acknowledges exactly the displayed page and reconciles a lost reply without optimistic success', async () => {
    state.latest.data = { ...page, nextBeforeId: 2 }
    state.history.data = { ...page, items: [{ ...item, id: 1, title: 'Older alert' }], nextBeforeId: null }
    state.mutation.mutateAsync.mockRejectedValueOnce(new Error('Connection lost'))
    render(ui)
    fireEvent.click(screen.getByRole('button', { name: 'Alerts, 1 unread' }))
    fireEvent.click(screen.getByRole('button', { name: 'Older alerts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark this page read' }))
    await waitFor(() => expect(state.history.refetch).toHaveBeenCalledOnce())
    expect(state.mutation.mutateAsync).toHaveBeenCalledExactlyOnceWith({ ids: [1] })
    expect(state.latest.refetch).toHaveBeenCalledOnce()
    expect(screen.getByText(/Could not confirm the read status/)).toBeTruthy()
    expect(screen.getByText('Unread')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Latest alerts' }))
    expect(screen.getByText('Humidity changed')).toBeTruthy()
  })

  it('distinguishes network failure, loading, expiry, and an honest empty inbox', () => {
    state.latest.data = undefined
    const { rerender } = render(ui)
    fireEvent.click(screen.getByRole('button', { name: 'Alerts' }))
    expect(screen.getByText('Loading alerts…')).toBeTruthy()
    state.latest.isError = true
    rerender(<ToastProvider><NotificationInbox /></ToastProvider>)
    expect(screen.getByText(/Cannot refresh alerts/)).toBeTruthy()
    expect(screen.queryByText(/No automation alerts yet/)).toBeNull()
    state.latest.isError = false
    state.latest.data = { ...page, generatedAt: 1000, unreadCount: 0 }
    rerender(<ToastProvider><NotificationInbox /></ToastProvider>)
    expect(screen.getByText('Expired')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Mark this page read' }) as HTMLButtonElement).disabled).toBe(true)
    state.latest.data = { ...page, items: [], newestId: null, unreadCount: 0 }
    rerender(<ToastProvider><NotificationInbox /></ToastProvider>)
    expect(screen.getByText(/No automation alerts yet/)).toBeTruthy()
  })

  it('clears an uncertain acknowledgment only after a fresh read confirms the selected ID', async () => {
    state.mutation.mutateAsync.mockRejectedValueOnce(new Error('Reply lost'))
    state.latest.refetch.mockResolvedValue({ isError: false, data: { ...page, items: [{ ...item, acknowledgedAt: 200 }] } })
    render(ui)
    fireEvent.click(screen.getByRole('button', { name: 'Alerts, 1 unread' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark this page read' }))
    await waitFor(() => expect(state.latest.refetch).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByText(/Could not confirm the read status/)).toBeNull())
    expect(state.mutation.mutateAsync).toHaveBeenCalledExactlyOnceWith({ ids: [2] })
  })
})
