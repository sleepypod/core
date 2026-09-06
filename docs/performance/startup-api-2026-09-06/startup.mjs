// Restarts only sleepypod.service and samples readiness for 90 seconds.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
const run = promisify(execFile)
const [label = 'startup', destination] = process.argv.slice(2)
const startedAt = performance.now()
const elapsed = () => Math.round(performance.now() - startedAt)
const result = { label, startedAt: new Date().toISOString(), serviceRestartMs: null,
  httpReadyMs: null, firstSensorMs: null, firstCurrentSensorMs: null, firstDeviceStatusMs: null,
  samples: [], performance: null }
await run('systemctl', ['restart', 'sleepypod.service'])
result.serviceRestartMs = elapsed()
let socket = null
let stopped = false
const connect = () => {
  if (socket || stopped) return
  const ws = new WebSocket('ws://127.0.0.1:3001')
  socket = ws
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'subscribe', sensors: ['capSense', 'capSense2', 'deviceStatus'] })))
  ws.addEventListener('error', () => {
    if (socket === ws) socket = null
  })
  ws.addEventListener('close', () => {
    if (socket === ws) socket = null
  })
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data)
    if (frame.type === 'deviceStatus') result.firstDeviceStatusMs ??= elapsed()
    if (frame.type === 'capSense' || frame.type === 'capSense2') {
      result.firstSensorMs ??= elapsed()
      if (typeof frame.ts === 'number' && Math.abs(Date.now() / 1000 - frame.ts) <= 5) result.firstCurrentSensorMs ??= elapsed()
    }
  })
}
while (elapsed() < 90_000) {
  const sampleAt = elapsed()
  connect()
  try {
    const response = await fetch('http://127.0.0.1:3000/api/healthcheck', { signal: AbortSignal.timeout(1500) })
    await response.text()
    if (response.ok) {
      result.httpReadyMs ??= elapsed()
      result.samples.push({ atMs: sampleAt, latencyMs: elapsed() - sampleAt })
    }
  }
  catch { /* server still starting */ }
  await delay(Math.max(0, 500 - (elapsed() - sampleAt)))
}
stopped = true
socket?.close()
try {
  const response = await fetch('http://127.0.0.1:3000/api/health/performance')
  if (response.ok) result.performance = await response.json()
}
catch { /* absent in the baseline build */ }
result.finishedAt = new Date().toISOString()
if (destination) writeFileSync(destination, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
