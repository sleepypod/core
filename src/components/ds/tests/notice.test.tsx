import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AlertTriangle, Bell, Droplets } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoticeBanner, NoticeStack, type Notice } from '../notice'

afterEach(cleanup)

const notice = (id: string, tone: Notice['tone'], extra: Partial<Notice> = {}): Notice => ({ id, kind: 'action', tone, icon: Bell, title: id, ...extra })
const order = () => [...document.querySelectorAll('[data-notice]')].map(el => el.getAttribute('data-notice'))

describe('NoticeStack', () => {
  it('renders nothing when the list is empty', () => {
    const { container } = render(<NoticeStack notices={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('orders banners danger, then warn, then cool, keeping order within a tone', () => {
    render(<NoticeStack notices={[notice('cool', 'cool'), notice('warn-a', 'warn'), notice('danger', 'danger'), notice('warn-b', 'warn')]} />)
    expect(order()).toEqual(['danger', 'warn-a', 'warn-b', 'cool'])
  })
})

describe('NoticeBanner', () => {
  it('is an alert for danger and a status otherwise', () => {
    render(<NoticeBanner notice={notice('d', 'danger', { icon: AlertTriangle })} />)
    expect(screen.getByRole('alert').getAttribute('data-notice')).toBe('d')
    cleanup()
    render(<NoticeBanner notice={notice('w', 'warn')} />)
    expect(screen.getByRole('status').getAttribute('data-notice')).toBe('w')
  })

  it('draws the progress bar only for a progress notice with a value', () => {
    render(<NoticeBanner notice={notice('p', 'cool', { kind: 'progress', icon: Droplets, progress: 0.4, meta: '3 MIN LEFT' })} />)
    expect((screen.getByTestId('notice-progress').firstChild as HTMLElement).style.width).toBe('40%')
    expect(screen.getByText('3 MIN LEFT').className).toContain('font-mono')
    cleanup()
    render(<NoticeBanner notice={notice('p', 'cool', { kind: 'progress', icon: Droplets })} />)
    expect(screen.queryByTestId('notice-progress')).toBeNull()
  })

  it('renders the X only for an action notice with onDismiss', () => {
    const onDismiss = vi.fn()
    render(<NoticeBanner notice={notice('a', 'warn', { onDismiss, dismissLabel: 'Dismiss a' })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss a' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    cleanup()
    render(<NoticeBanner notice={notice('p', 'cool', { kind: 'progress', onDismiss })} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
