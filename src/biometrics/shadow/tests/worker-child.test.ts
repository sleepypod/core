// @vitest-environment node
import type * as ChildProcess from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultConfig } from '../../algorithms/registry'
import { configHash } from '../../algorithms/canonical'
import { shadowPartialReceiptSchema } from '../receipt'
import { runShadowChild } from '../worker-child'

const state = vi.hoisted(() => ({ mode: 'normal', pid: 0, descendantPid: 0, rss: 1000 as number | null, hangRss: false, delayClose: false, missingAfterFinish: false, launches: [] as unknown[][] }))
vi.mock('../../backtest/process-group-memory', () => ({ sampleProcessGroupRss: () => state.hangRss ? new Promise(() => {}) : Promise.resolve(state.rss) }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>()
  return { ...actual, spawn: (command: string, args: string[], options: ChildProcess.SpawnOptions) => {
    state.launches.push([command, args, options])
    const script = `
const readline = require('node:readline');
const mode = ${JSON.stringify(state.mode)};
let init, records = 0, outputs = 0;
const health = state => ({state, reason:null, records, outputs, cpu_ms:1, input_hash:'a'.repeat(64), limitations:[],
 timestampBasis:"firmware_event_time_v1",counts:{mechanical_gated_frames:0,timestamp_rejected_frames:0,records,accepted_frames:records,empty_channel_frames:0,pump_gated_frames:0,preroll_outputs:0,scored_outputs:outputs}});
function emit(row) { process.stdout.write(JSON.stringify({runId:init.runId,attemptId:init.attemptId,...row})+'\\n'); }
if(mode==='ignore') { setInterval(()=>{},1000); }
else readline.createInterface({input:process.stdin}).on('line', line => {
 const message = JSON.parse(line);
 if(!init) {
  init = message;
  if(mode==='descendant') {
   const grandchild = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'});
   process.stderr.write('descendant:'+grandchild.pid+'\\n'); grandchild.unref();
  }
  if(mode==='bad') return process.stdout.write('{}\\n');
  if(mode==='flood') return process.stdout.write('x'.repeat(140000));
  if(mode==='stderr') return process.stderr.write('x'.repeat(17000));
  if(mode==='duplicate') return process.stdout.write((JSON.stringify({runId:init.runId,attemptId:init.attemptId,type:'ready',configHashes:init.configHashes})+'\\n').repeat(2));
  return emit({type:'ready', configHashes:init.configHashes});
 }
 if(message.type==='frame') {
  records++;
  const batch = mode==='output' ? [{sequence:outputs++,inputHash:'a'.repeat(64),side:init.side,sourceSide:init.side,timestampBasis:"firmware_event_time_v1",
   timestampMs:init.startMs+records*1000,configHash:init.configHashes[init.side],flags:null,limitations:[],readings:[
    {metric:'heart_rate',unit:'bpm',windowMs:null,value:60,quality:1},
    {metric:'breathing_rate',unit:'breaths/min',windowMs:null,value:12,quality:1},
    {metric:'window_ibi_variability_v1',unit:'ms',windowMs:300000,value:null,quality:0}]}] : [];
  return emit({type:'frame_result',sequence:message.sequence,outputs:batch,health:health('running')});
 }
 if(mode==='noexit') { emit({type:'finished',outputs:[],health:health('completed')}); setInterval(()=>{},1000); return; }
 if(mode==='truncated') { process.stdout.write('{'); return process.exit(0); }
 emit({type:'finished',outputs:[],health:health('completed')});
 process.exitCode = mode==='badexit' ? 1 : 0;
});`
    const child = state.mode === 'python'
      ? actual.spawn(resolve('modules/piezo-processor/.venv/bin/python'), ['-B', '-m', 'common.biometrics.shadow_worker'], options)
      : state.mode === 'missing' ? actual.spawn('/nonexistent/shadow-test-python', [], options) : actual.spawn(process.execPath, ['-e', script], options)
    child.stderr?.on('data', (chunk: Buffer) => {
      const match = /descendant:(\d+)/.exec(chunk.toString())
      if (match) state.descendantPid = Number(match[1])
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (state.missingAfterFinish && chunk.toString().includes('"type":"finished"')) state.rss = null
    })
    if (state.delayClose) {
      // procfs can lose the address space before Node drains/closes its pipes.
      child.once('exit', () => {
        state.rss = null
      })
      const emit = child.emit.bind(child)
      child.emit = ((event: string, ...args: unknown[]) => {
        if (event === 'close') {
          setTimeout(() => emit(event, ...args), 150)
          return true
        }
        return emit(event, ...args)
      }) as typeof child.emit
    }
    state.pid = child.pid ?? 0
    return child
  } }
})
const hash = configHash(defaultConfig)
function init() {
  return { schema: 'biometric-shadow-worker-v1', runId: randomUUID(), attemptId: randomUUID(), side: 'left',
    startMs: 1700000000000, endMs: 1700000150000, configs: { left: defaultConfig, right: defaultConfig },
    configHashes: { left: hash, right: hash }, maximumRecords: 10, maximumOutputs: 10, maximumCpuMs: 1000,
    maximumInputBytes: 1024 * 1024, maximumOutputBytes: 1024 * 1024 }
}
const budgets = { cpuSeconds: 2, addressSpaceBytes: 100000000, maximumRssBytes: 2000, wallMs: 2000,
  acknowledgmentMs: 500, idleMs: 300, rssIntervalMs: 50, rssTimeoutMs: 100 }
async function* source() {
  yield { type: 'frame', sequence: 0 }
}
const run = (frames: AsyncIterable<unknown> = source(), options: Partial<Parameters<typeof runShadowChild>[4]> = {}) =>
  runShadowChild({ pythonPath: '/trusted/python', modulesPath: '/trusted/modules' }, init(), frames, () => {}, { budgets, ...options })
function reaped() {
  expect(() => process.kill(state.pid, 0)).toThrow()
}
beforeEach(() => {
  state.mode = 'normal'
  state.rss = 1000
  state.hangRss = false
  state.delayClose = false
  state.missingAfterFinish = false
  state.pid = 0
  state.descendantPid = 0
  state.launches = []
})
describe('shadow child supervision', () => {
  it('uses fixed shipped entrypoint, sanitized environment and bounded sequential replies', async () => {
    const result = await run()
    expect(result).toMatchObject({ health: { state: 'completed', records: 1 }, peakObservedRssBytes: 1000, exactKernelPeak: false })
    expect(state.launches[0]).toMatchObject(['/trusted/python', ['-B', '-m', 'common.biometrics.shadow_process', '--parent-pid', String(process.pid), '--wall-ms', '2000', '--cpu-seconds', '2', '--address-space-bytes', '100000000'], { detached: true }])
    const env = (state.launches[0][2] as { env: Record<string, string> }).env
    expect(Object.keys(env).sort()).toEqual(['LANG', 'MKL_NUM_THREADS', 'NODE_ENV', 'NUMEXPR_NUM_THREADS', 'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'PYTHONPATH', 'TZ'])
    reaped()
  })
  it.each(['bad', 'duplicate', 'flood', 'stderr', 'truncated', 'badexit'])('rejects %s worker output and reaps it', async (mode) => {
    state.mode = mode
    const observed = vi.fn()
    await expect(run(source(), { onResources: observed })).rejects.toThrow(/Shadow/)
    expect(observed).toHaveBeenCalledOnce()
    expect(shadowPartialReceiptSchema.parse(observed.mock.calls[0][0]).cleanupConfirmed).toBe(true)
    reaped()
  })
  it.each(['ignore', 'noexit'])('enforces acknowledgment/exit deadlines for %s', async (mode) => {
    state.mode = mode
    await expect(run()).rejects.toThrow(/deadline/)
    reaped()
  })
  it('kills an idle source and invokes source cleanup without waiting for it', async () => {
    const cleanup = vi.fn(() => new Promise<IteratorResult<unknown>>(() => {}))
    const frames = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}), return: cleanup }) }
    await expect(run(frames)).rejects.toThrow(/idle deadline/)
    expect(cleanup).toHaveBeenCalledOnce()
    reaped()
  })
  it('honors cancellation while awaiting a source', async () => {
    const controller = new AbortController()
    const frames = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }) }
    const task = run(frames, { signal: controller.signal })
    await delay(100)
    controller.abort()
    await expect(task).rejects.toThrow(/cancelled/)
    reaped()
  })
  it.each([null, 3000])('fails closed for unavailable/over-budget RSS %s', async (rss) => {
    state.rss = rss
    const observed = vi.fn()
    await expect(run(source(), { onResources: observed })).rejects.toThrow(/RSS/)
    expect(observed).toHaveBeenCalledOnce()
    const receipt = shadowPartialReceiptSchema.parse(observed.mock.calls[0][0])
    expect(receipt.peakObservedRssBytes).toBe(rss)
    expect(receipt.cleanupConfirmed).toBe(true)
    if (rss === null) expect(receipt.rssSamples).toBe(0)
    reaped()
  })
  it('accepts disappearing RSS after completion only when clean pipe closure follows', async () => {
    state.delayClose = true
    const result = await run()
    expect(result.health.state).toBe('completed')
    expect(result.rssSamples).toBeGreaterThan(0)
    reaped()
  })
  it('still rejects a failed exit after completion when RSS disappears', async () => {
    state.delayClose = true
    state.mode = 'badexit'
    await expect(run()).rejects.toThrow(/failed or returned an incomplete result/)
    reaped()
  })
  it('bounds missing RSS after a terminal response when the worker never exits', async () => {
    state.mode = 'noexit'
    state.missingAfterFinish = true
    await expect(run()).rejects.toThrow(/exit deadline/)
    reaped()
  })
  it('bounds a stalled RSS observation', async () => {
    state.hangRss = true
    state.mode = 'ignore'
    await expect(run()).rejects.toThrow(/RSS observation timed out/)
    reaped()
  })
  it('enforces wall time independently of a longer per-command deadline', async () => {
    state.mode = 'ignore'
    await expect(run(source(), { budgets: { ...budgets, wallMs: 100 } })).rejects.toThrow(/wall deadline/)
    reaped()
  })
  it('preserves source errors and still reaps the worker', async () => {
    async function* broken() {
      yield { type: 'frame', sequence: 0 }
      throw new Error('source disconnected')
    }
    const observed = vi.fn()
    await expect(run(broken(), { onResources: observed })).rejects.toThrow('source disconnected')
    expect(observed).toHaveBeenCalledOnce()
    expect(observed.mock.calls[0][0]).toMatchObject({ health: { state: 'running', records: 1 }, cleanupConfirmed: true })
    reaped()
  })
  it('rejects input quota and out-of-order frames before sending them', async () => {
    const task = runShadowChild({ pythonPath: '/trusted/python', modulesPath: '/trusted/modules' }, { ...init(), maximumInputBytes: 1 }, source(), () => {}, { budgets })
    await expect(task).rejects.toThrow(/input exceeds/)
    reaped()
    async function* wrong() {
      yield { type: 'frame', sequence: 7 }
    }
    await expect(run(wrong())).rejects.toThrow()
    reaped()
  })
  it('does not launch for invalid config or cancelled admission', async () => {
    await expect(runShadowChild({ pythonPath: '/trusted/python', modulesPath: '/trusted/modules' }, { ...init(), configHashes: { left: 'b'.repeat(64), right: hash } }, source(), () => {}, { budgets })).rejects.toThrow(/identity/)
    await expect(run(source(), { signal: AbortSignal.abort() })).rejects.toThrow(/cancelled/)
    expect(state.launches).toHaveLength(0)
  })
})

it('waits for the fenced output sink before requesting another frame', async () => {
  state.mode = 'output'
  let acknowledged = false
  async function* frames() {
    yield { type: 'frame', sequence: 0 }
    expect(acknowledged).toBe(true)
  }
  const sink = vi.fn(async () => {
    await delay(30)
    acknowledged = true
  })
  await runShadowChild({ pythonPath: '/trusted/python', modulesPath: '/trusted/modules' }, init(), frames(), sink, { budgets })
  expect(sink).toHaveBeenCalledOnce()
  expect(sink.mock.calls[0]).toMatchObject([{ side: 'left', timestampMs: 1700000001000 }])
  reaped()
})
it('bounds a hung sink by the independent wall deadline', async () => {
  state.mode = 'output'
  await expect(runShadowChild({ pythonPath: '/trusted/python', modulesPath: '/trusted/modules' }, init(), source(),
    () => new Promise(() => {}), { budgets: { ...budgets, wallMs: 200 } })).rejects.toThrow(/wall deadline/)
  reaped()
})
it('preserves storage errors while terminating the worker', async () => {
  state.mode = 'output'
  await expect(runShadowChild({ pythonPath: '/trusted/python', modulesPath: '/trusted/modules' }, init(), source(),
    () => { throw new Error('lease replaced') }, { budgets })).rejects.toThrow('lease replaced')
  reaped()
})
it('kills descendants that retain output pipes after the worker exits', async () => {
  state.mode = 'descendant'
  await expect(run()).rejects.toThrow(/exit deadline/)
  reaped()
  expect(state.descendantPid).toBeGreaterThan(0)
  let exists = true
  for (let attempt = 0; exists && attempt < 50; attempt++) {
    try {
      process.kill(state.descendantPid, 0)
    }
    catch { exists = false }
    if (exists) await delay(20)
  }
  expect(exists).toBe(false)
})
it('handles failed process creation without an unhandled event or cleanup hang', async () => {
  state.mode = 'missing'
  const observed = vi.fn()
  await expect(run(source(), { onResources: observed })).rejects.toThrow(/could not start/)
  expect(observed.mock.calls[0][0]).toMatchObject({ health: null, rssSamples: 0, peakObservedRssBytes: null, cleanupConfirmed: true })
  expect(state.pid).toBe(0)
})
it.skipIf(!existsSync(resolve('modules/piezo-processor/.venv/bin/python')))('supervises the actual locked Python transport through clean completion', async () => {
  state.mode = 'python'
  async function* frames() {
    yield { type: 'frame', sequence: 0, observedAtMs: 1700000000000, record: { type: 'frzHealth' },
      context: { activeSides: ['left'], leftOccupied: true, rightOccupied: false, pumpContextKnown: true } }
  }
  // Kernel bootstrap is verified separately on Linux; this host test exercises
  // real Python pipe behavior and protocol validation through the supervisor.
  const result = await runShadowChild({ pythonPath: '/trusted/python', modulesPath: resolve('modules') }, init(), frames(), () => {},
    { budgets: { ...budgets, acknowledgmentMs: 5000, wallMs: 10000 } })
  expect(result.health).toMatchObject({ state: 'completed', records: 1 })
  reaped()
})
it('enforces cumulative output and frame input limits', async () => {
  await expect(runShadowChild({ pythonPath: '/trusted/python', modulesPath: '/trusted/modules' }, { ...init(), maximumOutputBytes: 10 }, source(),
    () => {}, { budgets })).rejects.toThrow(/output exceeds byte quota/)
  reaped()
  async function* oversized() {
    yield { type: 'frame', sequence: 0, payload: 'x'.repeat(128 * 1024) }
  }
  await expect(run(oversized())).rejects.toThrow(/input exceeds byte quota/)
  reaped()
})
it('does not send frames beyond the frozen record quota', async () => {
  async function* two() {
    yield { type: 'frame', sequence: 0 }
    yield { type: 'frame', sequence: 1 }
  }
  await expect(runShadowChild({ pythonPath: '/trusted/python', modulesPath: '/trusted/modules' }, { ...init(), maximumRecords: 1 }, two(),
    () => {}, { budgets })).rejects.toThrow(/record quota/)
  reaped()
})

it('does not hide failed process-group cleanup behind the original protocol error', async () => {
  state.mode = 'bad'
  const kill = process.kill.bind(process)
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid < 0 && signal === 'SIGKILL') throw Object.assign(new Error('denied'), { code: 'EPERM' })
    return kill(pid, signal)
  })
  try {
    const observed = vi.fn()
    await expect(run(source(), { onResources: observed })).rejects.toMatchObject({ code: 'SHADOW_CLEANUP_UNCONFIRMED',
      message: 'shadow_worker_cleanup_unconfirmed', cause: expect.objectContaining({ message: 'Shadow worker emitted an invalid response' }) })
    expect(observed.mock.calls[0][0]).toMatchObject({ cleanupConfirmed: false })
  }
  finally {
    spy.mockRestore()
    if (state.pid) {
      try {
        kill(-state.pid, 'SIGKILL')
      }
      catch { /* The direct child may have exited when its pipes closed. */ }
    }
  }
})
