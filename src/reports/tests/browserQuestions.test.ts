import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MorningReportQuestions } from '../browserQuestions'
import { BrowserModelFailure, browserReportModel, readBrowserModelAnswer, readModelJSON, reportModelDestination, reportQuestionPrompt, type BrowserModelGenerate } from '../browserModel'
import type { ReportBrowserAccess, ReportBrowserTransport } from '../browserWorkspace'
import { reportFixture, reportNow } from './fixture'

const choice = { provider: 'openai' as const, model: 'chosen-model' }
const secret = 'synthetic-test-key'
const openai = { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Evidence is limited. [health.sleep]' }] }], usage: { input_tokens: 10, output_tokens: 8 } }
const replies = {
  openai,
  gemini: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Evidence is limited.' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 } },
  anthropic: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Evidence is limited.' }], usage: { input_tokens: 10, output_tokens: 8 } },
  ollama: { done: true, done_reason: 'stop', response: 'Evidence is limited.', prompt_eval_count: 10, eval_count: 8 },
}
function required<Value>(value: Value | null | undefined): Value {
  if (value === undefined || value === null) throw new Error('Expected a test value')
  return value
}
const workspaces: MorningReportQuestions[] = []
afterEach(() => {
  workspaces.splice(0).forEach(workspace => workspace.dispose())
  vi.useRealTimers()
})

function setup() {
  let clock = reportNow
  const report = reportFixture().report
  const access: ReportBrowserAccess = { scope: { kind: 'legacy', installationId: randomUUID() }, revision: 'signed-in-account' }
  const receipt = { id: report.id, revision: randomUUID(), deleted: false, createdAt: report.createdAt, receivedAt: clock, updatedAt: clock }
  let copy = { version: 1 as const, generatedAt: clock, scope: access.scope, receipt, report }
  const transport: ReportBrowserTransport = { access: vi.fn(async () => structuredClone(access)), read: vi.fn(async () => structuredClone(copy)),
    write: vi.fn(async (_id, _revision, document) => {
      copy = { ...copy, generatedAt: clock, receipt: { ...receipt, revision: randomUUID(), updatedAt: clock }, report: document }
      return structuredClone(copy)
    }) }
  const generate = vi.fn<BrowserModelGenerate>(async () => ({ text: 'Only the saved facts support this answer. [health.sleep]', inputTokens: 10, outputTokens: 8 }))
  const accepted = vi.fn(), secure = vi.fn(() => true)
  const workspace = new MorningReportQuestions(transport, accepted, generate, () => clock, secure)
  workspace.bind(access, copy)
  workspaces.push(workspace)
  return { report, access, receipt, transport, generate, accepted, secure, workspace, getCopy: () => copy,
    advance: (milliseconds: number) => { clock += milliseconds } }
}
async function ask(sample: ReturnType<typeof setup>) {
  await sample.workspace.prepare(choice, 'What changed?', secret)
  const review = required(sample.workspace.getSnapshot().review)
  expect(review).not.toBeNull()
  await sample.workspace.send(review.id, true)
}

describe('reviewed browser questions', () => {
  it('previews exact old evidence without contacting a model, then requires a separate save', async () => {
    const sample = setup()
    await sample.workspace.prepare(choice, '  What changed?  ', secret)
    const review = required(sample.workspace.getSnapshot().review)
    expect(review).toMatchObject({ question: 'What changed?', reportDate: sample.report.createdAt, facts: sample.report.facts })
    expect(JSON.stringify(sample.workspace.getSnapshot())).not.toContain(secret)
    expect(sample.generate).not.toHaveBeenCalled()
    await sample.workspace.send(review.id, false)
    await sample.workspace.send(randomUUID(), true)
    expect(sample.generate).not.toHaveBeenCalled()
    await sample.workspace.send(review.id, true)
    expect(sample.workspace.getSnapshot().phase).toBe('answer')
    expect(sample.transport.write).not.toHaveBeenCalled()
    await sample.workspace.save(false)
    expect(sample.transport.write).not.toHaveBeenCalled()
    await sample.workspace.save(true)
    expect(sample.workspace.getSnapshot().phase).toBe('saved')
    expect(sample.transport.write).toHaveBeenCalledTimes(1)
    expect(sample.accepted).toHaveBeenCalledOnce()
    expect(sample.getCopy().report.facts).toEqual(sample.report.facts)
    expect(sample.getCopy().report.text).toBe(sample.report.text)
  })
  it('sends calculated facts and the question without old model prose or other records', () => {
    const report = reportFixture().report
    const prompt = reportQuestionPrompt({ ...report, text: 'Never send this generated report', followUps: [{ id: randomUUID(), question: 'Earlier', text: 'Never send this answer', createdAt: reportNow, provider: 'apple', model: 'local' }] }, 'Explain coverage')
    expect(prompt).toContain(report.facts[0].text)
    expect(prompt).toContain(new Date(report.createdAt).toISOString())
    expect(prompt).not.toContain('Never send')
  })
  it('expires reviews and erases the key without dispatch', async () => {
    vi.useFakeTimers()
    const sample = setup()
    await sample.workspace.prepare(choice, 'What changed?', secret)
    const review = required(sample.workspace.getSnapshot().review)
    sample.advance(300001)
    await sample.workspace.send(review.id, true)
    expect(sample.generate).not.toHaveBeenCalled()
    expect(sample.workspace.getSnapshot().review).toBeNull()
    await sample.workspace.prepare(choice, 'What changed?', secret)
    await vi.advanceTimersByTimeAsync(300001)
    expect(sample.workspace.getSnapshot().review).toBeNull()
  })
  it.each(['clear', 'dispose', 'cancel'] as const)('discards and aborts a delayed provider answer after %s', async (action) => {
    const sample = setup()
    let release: (value: { text: string }) => void = () => {}
    sample.generate.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve
    }))
    await sample.workspace.prepare(choice, 'What changed?', secret)
    const pending = sample.workspace.send(required(sample.workspace.getSnapshot().review).id, true)
    await vi.waitFor(() => expect(sample.generate).toHaveBeenCalledOnce())
    const signal = sample.generate.mock.calls[0][1]
    sample.workspace[action]()
    expect(signal.aborted).toBe(true)
    release({ text: 'Late private answer' })
    await pending
    expect(sample.workspace.getSnapshot().answer).toBeNull()
    expect(sample.transport.write).not.toHaveBeenCalled()
  })
  it.each(['before', 'after'] as const)('withholds a question when the account changes %s inference', async (when) => {
    const sample = setup()
    await sample.workspace.prepare(choice, 'What changed?', secret)
    if (when === 'before') vi.mocked(sample.transport.access).mockResolvedValue({ ...sample.access, revision: 'revoked' })
    else sample.generate.mockImplementationOnce(async () => {
      vi.mocked(sample.transport.access).mockResolvedValue({ ...sample.access, revision: 'revoked' })
      return { text: 'Late answer', inputTokens: 10, outputTokens: 8 }
    })
    await sample.workspace.send(required(sample.workspace.getSnapshot().review).id, true)
    expect(sample.generate).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
    expect(sample.workspace.getSnapshot().answer).toBeNull()
    expect(sample.workspace.getSnapshot().review).toBeNull()
  })
  it('rejects a changed report before sending and does not silently use newer facts', async () => {
    const sample = setup()
    await sample.workspace.prepare(choice, 'What changed?', secret)
    vi.mocked(sample.transport.read).mockResolvedValue({ ...sample.getCopy(), receipt: { ...sample.receipt, revision: randomUUID() } })
    await sample.workspace.send(required(sample.workspace.getSnapshot().review).id, true)
    expect(sample.generate).not.toHaveBeenCalled()
    expect(sample.workspace.getSnapshot().phase).toBe('error')
  })
  it('requires secure context and refuses invalid keys, models, empty evidence and an eleventh answer', async () => {
    for (const kind of ['insecure', 'key', 'model', 'facts', 'full']) {
      const sample = setup()
      if (kind === 'insecure') sample.secure.mockReturnValue(false)
      if (kind === 'facts') sample.getCopy().report.facts = []
      if (kind === 'full') sample.getCopy().report.followUps = Array.from({ length: 10 }, () => ({ id: randomUUID(), question: 'Previous', text: 'Old', createdAt: reportNow, provider: 'apple', model: 'local' }))
      sample.workspace.bind(sample.access, sample.getCopy())
      await sample.workspace.prepare({ ...choice, model: kind === 'model' ? '../bad model' : choice.model }, 'Question', kind === 'key' ? '' : secret)
      expect(sample.workspace.getSnapshot().phase).toBe('error')
      expect(sample.generate).not.toHaveBeenCalled()
    }
  })
  it('recovers a committed upload through reads after a lost reply, never by replaying', async () => {
    const sample = setup()
    await ask(sample)
    const save = required(sample.transport.write)
    sample.transport.write = vi.fn<NonNullable<ReportBrowserTransport['write']>>(async (...args) => {
      await save(...args)
      throw new Error('Reply lost')
    })
    await sample.workspace.save(true)
    expect(sample.workspace.getSnapshot().phase).toBe('uncertain')
    await sample.workspace.save(true)
    expect(sample.transport.write).toHaveBeenCalledTimes(1)
    await sample.workspace.recover()
    expect(sample.workspace.getSnapshot().phase).toBe('saved')
    expect(sample.transport.write).toHaveBeenCalledTimes(1)
  })
  it('requires a read before offering a second explicit upload when nothing was saved', async () => {
    const sample = setup()
    await ask(sample)
    vi.mocked(required(sample.transport.write)).mockRejectedValue(new Error('Network unavailable'))
    await sample.workspace.save(true)
    await sample.workspace.recover()
    expect(sample.workspace.getSnapshot().phase).toBe('answer')
    expect(sample.transport.write).toHaveBeenCalledTimes(1)
  })
  it('withdraws an unsaved private answer when recovery cannot verify the account', async () => {
    const sample = setup()
    await ask(sample)
    vi.mocked(required(sample.transport.write)).mockRejectedValue(new Error('Network unavailable'))
    await sample.workspace.save(true)
    vi.mocked(sample.transport.access).mockResolvedValue({ ...sample.access, revision: 'another-account' })
    await sample.workspace.recover()
    expect(sample.workspace.getSnapshot().answer).toBeNull()
    expect(sample.workspace.getSnapshot().phase).toBe('error')
  })
  it('announces read recovery and preserves uncertainty when that read is cancelled', async () => {
    const sample = setup()
    await ask(sample)
    vi.mocked(required(sample.transport.write)).mockRejectedValue(new Error('Reply unavailable'))
    await sample.workspace.save(true)
    let release: () => void = () => {}, readStarted = false
    vi.mocked(sample.transport.read).mockImplementationOnce(() => new Promise((resolve) => {
      readStarted = true
      release = () => resolve(sample.getCopy())
    }))
    const recovery = sample.workspace.recover()
    expect(sample.workspace.getSnapshot().phase).toBe('recovering')
    expect(sample.workspace.getSnapshot().answer).not.toBeNull()
    await vi.waitFor(() => expect(readStarted).toBe(true))
    sample.workspace.cancel()
    release()
    await recovery
    expect(sample.workspace.getSnapshot().phase).toBe('uncertain')
    expect(sample.workspace.getSnapshot().answer).not.toBeNull()
    expect(sample.transport.write).toHaveBeenCalledTimes(1)
  })
  it.each(['access', 'limit', 'network', 'response'] as const)('presents only controlled %s provider guidance', async (kind) => {
    const sample = setup()
    sample.generate.mockRejectedValueOnce(new BrowserModelFailure(kind))
    await ask(sample)
    expect(sample.workspace.getSnapshot()).toMatchObject({ phase: 'error', answer: null })
    expect(sample.workspace.getSnapshot().message).toContain(new BrowserModelFailure(kind).message)
    expect(sample.workspace.getSnapshot().message).toContain('Nothing was saved or will retry automatically')
    expect(sample.transport.write).not.toHaveBeenCalled()
  })
})

describe('browser model transport', () => {
  it('keeps reasoning separate from the user-facing answer', () => {
    expect(readBrowserModelAnswer('anthropic', { ...replies.anthropic, content: [
      { type: 'thinking', thinking: 'Do not display this' }, ...replies.anthropic.content,
    ] }).text).toBe('Evidence is limited.')
    expect(() => readBrowserModelAnswer('anthropic', { ...replies.anthropic, content: [{ type: 'tool_use', name: 'bed' }] })).toThrow()
  })
  it.each(['openai', 'gemini', 'anthropic', 'ollama'] as const)('calls only the chosen %s endpoint once without cookies or redirects', async (provider) => {
    const fetcher = vi.fn(async () => Response.json(replies[provider]))
    const generate = browserReportModel(fetcher, () => true)
    const result = await generate({ choice: { provider, model: 'chosen-model', ...(provider === 'ollama' ? { server: 'https://local-model.example' } : {}) }, key: provider === 'ollama' ? '' : secret, prompt: 'Only approved calculated facts' }, new AbortController().signal)
    expect(result).toMatchObject({ inputTokens: 10, outputTokens: 8 })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).not.toContain(secret)
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' })
    expect(options.body).not.toContain(secret)
    if (provider === 'openai') expect(JSON.parse(options.body as string)).toMatchObject({ store: false, stream: false })
  })
  it.each([
    ['openai', { ...openai, status: 'incomplete' }],
    ['openai', { ...openai, output: [{ type: 'function_call', name: 'move_bed' }] }],
    ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Truncated' }] } }] }],
    ['anthropic', { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Truncated' }] }],
    ['ollama', { done: true, done_reason: 'length', response: 'Truncated' }],
  ] as const)('rejects incomplete or tool output from %s', (provider, reply) => {
    expect(() => readBrowserModelAnswer(provider, reply)).toThrow()
  })
  it('never sends from an insecure origin or forwards a cloud key to a custom server', async () => {
    const fetcher = vi.fn()
    await expect(browserReportModel(fetcher, () => false)({ choice, key: secret, prompt: 'facts' }, new AbortController().signal)).rejects.toThrow('HTTPS')
    await expect(browserReportModel(fetcher, () => true)({ choice: { provider: 'ollama', model: 'local', server: 'https://model.example' }, key: secret, prompt: 'facts' }, new AbortController().signal)).rejects.toThrow('cloud provider key')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['http://10.0.1.71:11434', 'https://user:secret@model.example', 'https://model.example/proxy', 'https://model.example?key=secret', 'file:///tmp/socket'])('rejects unreviewable local server %s', (server) => {
    expect(() => reportModelDestination({ provider: 'ollama', model: 'local', server })).toThrow()
  })
  it('bounds streamed data and releases the reader immediately on cancellation', async () => {
    await expect(readModelJSON(new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }), new AbortController().signal)).rejects.toThrow('too large')
    const cancelled = vi.fn(), controller = new AbortController()
    const result = readModelJSON(new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'Content-Type': 'application/json' } }), controller.signal)
    controller.abort()
    await expect(result).rejects.toThrow('cancelled')
    expect(cancelled).toHaveBeenCalledOnce()
  })
  it('does not echo sensitive error bodies or retry provider failures', async () => {
    const fetcher = vi.fn(async () => new Response('private provider content', { status: 401 }))
    await expect(browserReportModel(fetcher, () => true)({ choice, key: secret, prompt: 'facts' }, new AbortController().signal)).rejects.toThrow('provider rejected access')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
