import { describe, expect, it } from 'vitest'
import { reportBlocks, reportExperiment, reportInline } from '../document'

describe('saved report prose', () => {
  const facts = [{ id: 'health.sleep', text: 'The saved source-specific fact.' }, { id: 'unknown.custom', text: 'Not a recognized display badge.' }]
  it('renders headings, lists, emphasis and exact source badges without inventing references', () => {
    const blocks = reportBlocks('### Coverage\n**Saved sleep** is a source estimate. [health.sleep] [unknown.custom]\n\n- A first idea\n2. Another idea', facts)
    expect(blocks.map(block => block.kind)).toEqual(['heading', 'paragraph', 'bullet', 'bullet'])
    expect(blocks[1].evidence).toEqual(['health.sleep'])
    expect(blocks[1].text).toContain('[unknown.custom]')
    expect(reportInline(blocks[1].text)[0]).toEqual({ kind: 'strong', text: 'Saved sleep' })
  })
  it('keeps code, tables and literal HTML as data, and turns linked labels into non-navigable text', () => {
    const blocks = reportBlocks('```\n[health.sleep] <script>alert(1)</script>\n```\n\nName | Value\n--- | ---\nRecorded | 7h\n\n[health.sleep](https://example.com)', facts)
    expect(blocks[0].kind).toBe('code')
    expect(blocks[0].evidence).toEqual([])
    expect(blocks[1].cells).toEqual([['Name', 'Value'], ['Recorded', '7h']])
    expect(blocks[2].evidence).toEqual([])
    expect(reportInline(blocks[2].text)).toEqual([{ kind: 'text', text: 'health.sleep' }])
  })
  it('lifts exactly one explicitly named experiment without trimming conditions', () => {
    const text = '## One experiment to consider\nTry one nearby setting only after review.\n### Keep the alarm\nKeep the wake plan unchanged.\n## Sources\nOriginal evidence.'
    const experiment = reportExperiment(reportBlocks(text, facts))
    expect(experiment?.map(block => block.text)).toEqual(['Try one nearby setting only after review.', 'Keep the alarm', 'Keep the wake plan unchanged.'])
    expect(reportExperiment(reportBlocks(text + '\n## One optional experiment\nA second idea.', facts))).toBeNull()
    expect(reportExperiment(reportBlocks('## One optional experiment\n' + 'x'.repeat(1201), facts))).toBeNull()
    expect(reportExperiment(reportBlocks('## Suggestions\nTry changing temperature.', facts))).toBeNull()
  })
})
