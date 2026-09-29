import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useDocumentTitle } from '../useDocumentTitle'

function Page({ parts }: { parts: Array<string | null> }) {
  useDocumentTitle(...parts)
  return null
}

describe('useDocumentTitle', () => {
  it('joins the parts with the app name, skipping empty ones', () => {
    render(<Page parts={['Health', null, 'System']} />)
    expect(document.title).toBe('Health · System · sleepypod')
  })

  it('keeps its title when route metadata overwrites it later', async () => {
    const { unmount } = render(<Page parts={['Databases', 'System']} />)
    document.title = 'System · sleepypod'
    await new Promise(r => setTimeout(r, 0))
    expect(document.title).toBe('Databases · System · sleepypod')
    unmount()
    document.title = 'Schedule · sleepypod'
    await new Promise(r => setTimeout(r, 0))
    expect(document.title).toBe('Schedule · sleepypod')
  })
})
