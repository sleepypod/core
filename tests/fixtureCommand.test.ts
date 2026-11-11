// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { fixtureCommand } from './helpers/fixtureCommand'

describe('bounded real fixture commands', () => {
  it('preserves a deliberate nonzero exit and its diagnostic output', () => {
    const result = fixtureCommand(process.execPath, ['-e', 'process.stderr.write("fixture rejection"); process.exit(7)'], { encoding: 'utf8' })
    expect(result.status).toBe(7)
    expect(result.stderr).toBe('fixture rejection')
  })
  it('throws for a process that does not finish instead of treating a timeout as an expected rejection', () => {
    expect(() => fixtureCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100 }))
      .toThrow(expect.objectContaining({ code: 'ETIMEDOUT' }))
  })
  it('rejects an unbounded timeout', () => {
    expect(() => fixtureCommand(process.execPath, ['-e', ''], { timeout: 0 })).toThrow(RangeError)
  })
})
