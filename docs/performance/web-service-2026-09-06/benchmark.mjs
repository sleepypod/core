import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const [base = 'http://127.0.0.1:3000', label = 'sample', destination] = process.argv.slice(2)
const pid = process.env.APP_PID || (base.includes('127.0.0.1') ? execFileSync('systemctl', ['show', 'sleepypod', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim() : null)
const round = n => Math.round(n * 100) / 100
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { n: values.length, medianMs: round(sorted[Math.ceil(sorted.length * 0.5) - 1]), p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]), maxMs: round(sorted.at(-1)), meanMs: round(values.reduce((a, b) => a + b, 0) / values.length) }
}
function resource() {
  if (!pid) return null
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  return { t: performance.now(), cpuTicks: Number(fields[11]) + Number(fields[12]), rssKiB: Number(status.match(/VmRSS:\s+(\d+)/)[1]) }
}
function usage(a, b) {
  return a && b ? { durationSec: round((b.t - a.t) / 1000), cpuPercentOneCore: round((b.cpuTicks - a.cpuTicks) * 1000 / (b.t - a.t)), rssMiBStart: round(a.rssKiB / 1024), rssMiBEnd: round(b.rssKiB / 1024) } : null
}
async function request(path, json = false, extra = {}) {
  const start = performance.now()
  const response = await fetch(base + path, { signal: AbortSignal.timeout(20000), ...extra })
  const headersMs = performance.now() - start
  const body = await response.text()
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${body.slice(0, 200)}`)
  if (json && JSON.parse(body).error) throw new Error(`${path}: returned tRPC error`)
  return { ms: performance.now() - start, headersMs, body }
}
const statusPath = '/api/trpc/device.getStatus?input=' + encodeURIComponent(JSON.stringify({ json: { unit: 'F' } }))
const settingsPath = '/api/trpc/settings.getAll?input=' + encodeURIComponent(JSON.stringify({ json: {} }))
const healthPath = '/api/health/dac-monitor'
const result = { label, base, startedAt: new Date().toISOString(), node: process.version, pid, methodology: '15s idle; one deviceStatus WebSocket; 3 warmups; 60 serial status reads spaced at least 500ms start-to-start; 12 bursts of 4 concurrent reads; 10 warm HTML requests per page. /proc CPU uses SC_CLK_TCK=100 and reports percent of one core. HTTP timing includes body; no browser rendering.' }
console.log(JSON.stringify({ event: 'start', label, pid }))
const idleStart = resource()
await delay(15000)
result.idle = usage(idleStart, resource())
console.log(JSON.stringify({ event: 'idle', ...result.idle }))
const socketUrl = new URL(base)
socketUrl.protocol = 'ws:'
socketUrl.port = '3001'
const socket = new WebSocket(socketUrl)
const frames = []
socket.addEventListener('message', (event) => {
  const data = JSON.parse(event.data)
  if (data.type === 'deviceStatus') frames.push(performance.now())
})
await Promise.race([
  new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  }),
  delay(10000).then(() => { throw new Error('WebSocket connect timed out') }),
])
socket.send(JSON.stringify({ type: 'subscribe', sensors: ['deviceStatus'] }))
try {
  await delay(2500)
  for (let i = 0; i < 3; i++) {
    await request(statusPath, true)
    await request(settingsPath, true)
  }
  const activeStart = resource()
  const serial = []
  for (let i = 0; i < 60; i++) {
    const start = performance.now()
    serial.push((await request(statusPath, true)).ms)
    await delay(Math.max(0, 500 - (performance.now() - start)))
  }
  result.status = stats(serial)
  result.statusSamplesMs = serial.map(round)
  result.active = usage(activeStart, resource())
  console.log(JSON.stringify({ event: 'serial', ...result.status, ...result.active }))
  const concurrent = [], health = []
  const burstStart = resource()
  for (let i = 0; i < 12; i++) {
    const rows = await Promise.all([request(statusPath, true), request(statusPath, true), request(statusPath, true), request(statusPath, true), request(healthPath, true)])
    concurrent.push(...rows.slice(0, 4).map(row => row.ms))
    health.push(rows[4].ms)
    await delay(300)
  }
  result.concurrentStatus = stats(concurrent)
  result.concurrentHealth = stats(health)
  result.burst = usage(burstStart, resource())
  result.pages = {}
  for (const path of ['/en', '/en/debug']) {
    await request(path)
    const rows = []
    for (let i = 0; i < 10; i++) rows.push(await request(path))
    const scripts = [...new Set([...rows.at(-1).body.matchAll(/<script\b[^>]*\bsrc="([^" ]+\.js(?:\?[^" ]*)?)"/g)].map(m => m[1]))]
    const assetStart = performance.now()
    const sizes = await Promise.all(scripts.map(async path => Buffer.byteLength((await request(path)).body)))
    result.pages[path] = { html: stats(rows.map(row => row.ms)), htmlBytes: Buffer.byteLength(rows.at(-1).body), initialJsFiles: scripts.length, initialJsDecodedBytes: sizes.reduce((a, b) => a + b, 0), fetchAllInitialJsMs: round(performance.now() - assetStart) }
  }
  const settings = []
  for (let i = 0; i < 20; i++) settings.push((await request(settingsPath, true)).ms)
  result.settings = stats(settings)
  result.websocket = { frames: frames.length, gaps: frames.length > 1 ? stats(frames.slice(1).map((t, i) => t - frames[i])) : null }
  result.health = JSON.parse((await request(healthPath, true)).body)
  result.finishedAt = new Date().toISOString()
  if (destination) writeFileSync(destination, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ event: 'complete', ...result }))
}
finally {
  socket.close()
}
