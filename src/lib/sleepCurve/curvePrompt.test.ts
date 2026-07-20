import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteTemplate,
  EXAMPLE_SUGGESTIONS,
  generatePrompt,
  loadTemplates,
  parseAIResponse,
  saveTemplate,
  type GeneratedCurve,
} from './curvePrompt'

const VALID_CURVE = {
  name: 'Deep Cool',
  bedtime: '22:30',
  wake: '06:45',
  points: {
    '21:45': 84,
    '22:30': 78,
    '02:00': 67,
  },
  reasoning: 'Cool early and warm gently.',
} satisfies GeneratedCurve

function validJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID_CURVE, ...overrides })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('generatePrompt', () => {
  it('includes the complete medical context, caller preferences, schema, and name constraint', () => {
    const prompt = generatePrompt('Hot sleeper; bed 23:15, wake 06:30.')

    expect(prompt).toContain('board-certified sleep medicine physician')
    expect(prompt).toContain('Water temperature range: 55°F to 110°F')
    expect(prompt).toContain('Hot sleeper; bed 23:15, wake 06:30.')
    expect(prompt).toContain('"points": {')
    expect(prompt).toContain('All temperatures must be integers between 55 and 110')
    expect(prompt).toContain('IMPORTANT: The "name" field must be 2-3 words maximum.')
  })

  it('exposes every curated suggestion verbatim', () => {
    expect(EXAMPLE_SUGGESTIONS).toEqual([
      'I run hot, bed at 11pm, wake 6:30. Really cold first few hours.',
      'Light sleeper, cold feet. Warm start, gentle cooling, warm wake at 7am.',
      'Post-workout recovery. Bed 10pm, wake 6am. Extra cold for muscles.',
      'I\'m always cold. Minimal cooling, cozy all night. Bed 11:30, wake 7:30.',
    ])
  })
})

describe('parseAIResponse', () => {
  it('extracts a complete JSON object from fenced, surrounding prose', () => {
    const result = parseAIResponse(`Here is the curve:\n\`\`\`JSON\n${validJson()}\n\`\`\`\nEnjoy it.`)

    expect(result).toEqual({ success: true, curve: VALID_CURVE })
  })

  it('trims outer whitespace before stripping fences around a non-object value', () => {
    expect(parseAIResponse('  \n```[]```\n  ')).toEqual({
      success: false,
      error: 'Missing or invalid "bedtime" field (expected "HH:mm").',
    })
  })

  it('supports compact bare fences around a non-object value', () => {
    expect(parseAIResponse('```[]```')).toEqual({
      success: false,
      error: 'Missing or invalid "bedtime" field (expected "HH:mm").',
    })
  })

  it('does not strip non-whitespace trailing text after a closing fence', () => {
    expect(parseAIResponse('```[]```junk')).toEqual({
      success: false,
      error: 'Invalid JSON. Make sure you copied the complete response.',
    })
  })

  it('preserves triple backticks inside JSON string values', () => {
    const reasoning = 'Keep the literal ``` marker intact.'

    expect(parseAIResponse(validJson({ reasoning }))).toMatchObject({
      success: true,
      curve: { reasoning },
    })
  })

  it('reports malformed JSON with the public copy/paste guidance', () => {
    expect(parseAIResponse('{not json')).toEqual({
      success: false,
      error: 'Invalid JSON. Make sure you copied the complete response.',
    })
  })

  it('preserves field-level validation for a valid non-object JSON value', () => {
    expect(parseAIResponse('[]')).toEqual({
      success: false,
      error: 'Missing or invalid "bedtime" field (expected "HH:mm").',
    })
  })

  it.each(['}', '{'])('does not extract a lone %s from a valid JSON string', (brace) => {
    expect(parseAIResponse(JSON.stringify(brace))).toEqual({
      success: false,
      error: 'Missing or invalid "bedtime" field (expected "HH:mm").',
    })
  })

  it('extracts JSON when the opening brace is exactly index one', () => {
    expect(parseAIResponse(`x${validJson()}`)).toEqual({ success: true, curve: VALID_CURVE })
  })

  it.each([
    [undefined, 'Missing or invalid "bedtime" field (expected "HH:mm").'],
    [null, 'Missing or invalid "bedtime" field (expected "HH:mm").'],
    ['1:30', 'Missing or invalid "bedtime" field (expected "HH:mm").'],
    ['x22:30', 'Missing or invalid "bedtime" field (expected "HH:mm").'],
    ['22:30x', 'Missing or invalid "bedtime" field (expected "HH:mm").'],
    ['ab:30', 'Missing or invalid "bedtime" field (expected "HH:mm").'],
    ['22:ab', 'Missing or invalid "bedtime" field (expected "HH:mm").'],
  ])('rejects bedtime=%s', (bedtime, error) => {
    expect(parseAIResponse(validJson({ bedtime }))).toEqual({ success: false, error })
  })

  it.each([undefined, null, '6:45', 'x06:45', '06:45x', 'ab:45', '06:ab'])(
    'rejects wake=%s',
    (wake) => {
      expect(parseAIResponse(validJson({ wake }))).toEqual({
        success: false,
        error: 'Missing or invalid "wake" field (expected "HH:mm").',
      })
    },
  )

  it.each([undefined, null, [], 'not-an-object'])('rejects points=%s', (points) => {
    expect(parseAIResponse(validJson({ points }))).toEqual({
      success: false,
      error: 'Missing or invalid "points" field (expected object).',
    })
  })

  it('requires at least three points and accepts exactly three', () => {
    expect(parseAIResponse(validJson({ points: { '22:00': 80, '23:00': 75 } }))).toEqual({
      success: false,
      error: 'Need at least 3 set points, got 2.',
    })
    expect(parseAIResponse(validJson()).success).toBe(true)
  })

  it.each(['1:00', 'x01:00', '01:00x', 'ab:00', '01:ab'])(
    'rejects malformed point time %s',
    (time) => {
      const result = parseAIResponse(validJson({
        points: { [time]: 70, '02:00': 71, '03:00': 72 },
      }))
      expect(result).toEqual({
        success: false,
        error: `Invalid time format "${time}" (expected "HH:mm").`,
      })
    },
  )

  it('rejects a non-finite temperature with its point context', () => {
    expect(parseAIResponse(validJson({
      points: { '01:00': 'warm', '02:00': 71, '03:00': 72 },
    }))).toEqual({
      success: false,
      error: 'Invalid temperature for 01:00: warm',
    })
  })

  it('rounds temperatures and clamps both range boundaries', () => {
    const result = parseAIResponse(validJson({
      points: { '01:00': 54.6, '02:00': 82.6, '03:00': 110.6 },
    }))
    expect(result).toMatchObject({
      success: true,
      curve: { points: { '01:00': 55, '02:00': 83, '03:00': 110 } },
    })
  })

  it('truncates long names and defaults missing optional strings', () => {
    const longName = 'A deliberately much longer curve name than allowed'
    const named = parseAIResponse(validJson({ name: longName, reasoning: 42 }))
    expect(named).toMatchObject({
      success: true,
      curve: { name: longName.slice(0, 30), reasoning: '' },
    })

    const defaults = parseAIResponse(validJson({ name: null, reasoning: null }))
    expect(defaults).toMatchObject({
      success: true,
      curve: { name: 'Custom Curve', reasoning: '' },
    })
  })
})

describe('curve template persistence', () => {
  it('returns an empty list on the server, missing storage, malformed JSON, or storage failure', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    vi.stubGlobal('window', undefined)
    expect(loadTemplates()).toEqual([])
    expect(getItem).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    getItem.mockRestore()

    expect(loadTemplates()).toEqual([])
    localStorage.setItem('sleepypod_curve_templates', '{bad json')
    expect(loadTemplates()).toEqual([])

    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
      throw new Error('storage blocked')
    })
    expect(loadTemplates()).toEqual([])
  })

  it('prepends new templates and replaces an exact-name match in place', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T08:00:00.000Z'))
    const older = { ...VALID_CURVE, name: 'Older', createdAt: 1 }
    const matching = { ...VALID_CURVE, name: VALID_CURVE.name, createdAt: 2 }
    localStorage.setItem('sleepypod_curve_templates', JSON.stringify([older, matching]))

    const replaced = saveTemplate({ ...VALID_CURVE, reasoning: 'Updated' })
    expect(replaced).toEqual({
      ...VALID_CURVE,
      reasoning: 'Updated',
      createdAt: Date.now(),
    })
    expect(loadTemplates()).toEqual([older, replaced])

    const added = saveTemplate({ ...VALID_CURVE, name: 'New Curve' })
    expect(loadTemplates()[0]).toEqual(added)
  })

  it('replaces an exact-name match at the first array position', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T08:00:00.000Z'))
    const matching = { ...VALID_CURVE, createdAt: 1 }
    const trailing = { ...VALID_CURVE, name: 'Trailing', createdAt: 2 }
    localStorage.setItem('sleepypod_curve_templates', JSON.stringify([matching, trailing]))

    const replacement = saveTemplate({ ...VALID_CURVE, reasoning: 'Updated first' })

    expect(loadTemplates()).toEqual([replacement, trailing])
  })

  it('deletes only templates whose names match exactly', () => {
    const templates = [
      { ...VALID_CURVE, name: 'Keep', createdAt: 1 },
      { ...VALID_CURVE, name: 'Delete', createdAt: 2 },
      { ...VALID_CURVE, name: 'Delete Later', createdAt: 3 },
    ]
    localStorage.setItem('sleepypod_curve_templates', JSON.stringify(templates))

    deleteTemplate('Delete')

    expect(loadTemplates().map(template => template.name)).toEqual(['Keep', 'Delete Later'])
  })
})
