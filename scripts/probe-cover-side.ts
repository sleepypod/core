/**
 * Probe Pod 5 cover for a per-side vibration command.
 *
 * Background: ALARM_SOLO (cmd 2) buzzes both LP5009 motor drivers
 * simultaneously. ALARM_LEFT/RIGHT (5/6) reject on cover-only pods
 * (pillow label gate). docs/hardware/alarms.md "Open work" section flags
 * "probe additional CBOR field names (s, m, side, motor) to see if
 * ALARM_SOLO quietly respects a side hint we haven't found yet" — this
 * script does that, plus probes undocumented opcodes near the known ones.
 *
 * Usage:
 *   npx tsx scripts/probe-cover-side.ts [POD_URL]
 *
 * After each probe the script pauses so you can listen / observe and
 * type y/n/q before continuing. Defaults to http://192.168.1.88:3000.
 */

import { Encoder } from 'cbor-x'

const POD_URL = process.argv[2] || 'http://192.168.1.88:3000'
const BUZZ_SECONDS = 10 // firmware silently ignores < 10
const SETTLE_SECONDS = 4 // gap after clear, before next
const encoder = new Encoder({ useRecords: false })

const t0 = Date.now()
const stamp = () => `t+${Math.round((Date.now() - t0) / 100) / 10}s`.padEnd(8)

interface Probe {
  label: string
  command: string // opcode string or allowlisted name
  payload: Record<string, unknown>
}

const base = (extra: Record<string, unknown> = {}) => ({
  pl: 40,
  du: BUZZ_SECONDS,
  pi: 'double', // double = two firm bursts; easier to localize than 'rise'
  tt: Math.floor(Date.now() / 1000),
  ...extra,
})

const probes: Probe[] = [
  // ── baseline ───────────────────────────────────────────────────────────
  { label: 'ALARM_SOLO baseline (both motors expected)', command: 'ALARM_SOLO', payload: base() },

  // ── side hints on SOLO ────────────────────────────────────────────────
  { label: 'ALARM_SOLO + s:"l" (string left)', command: 'ALARM_SOLO', payload: base({ s: 'l' }) },
  { label: 'ALARM_SOLO + s:0 (int 0=left convention)', command: 'ALARM_SOLO', payload: base({ s: 0 }) },
  { label: 'ALARM_SOLO + side:"left"', command: 'ALARM_SOLO', payload: base({ side: 'left' }) },
  { label: 'ALARM_SOLO + m:"l"', command: 'ALARM_SOLO', payload: base({ m: 'l' }) },
  { label: 'ALARM_SOLO + motor:"left"', command: 'ALARM_SOLO', payload: base({ motor: 'left' }) },
  { label: 'ALARM_SOLO + ch:0 (channel index)', command: 'ALARM_SOLO', payload: base({ ch: 0 }) },

  // ── confirm rejection of per-side without pillow ─────────────────────
  { label: 'ALARM_LEFT (expected: err:-1 on cover-only Pod 5)', command: 'ALARM_LEFT', payload: base() },

  // ── undocumented opcodes between known commands ──────────────────────
  { label: 'opcode 3 (between SOLO=2 and ALARM_LEFT=5)', command: '3', payload: base() },
  { label: 'opcode 4', command: '4', payload: base() },
  { label: 'opcode 7 (after ALARM_RIGHT=6)', command: '7', payload: base() },
  { label: 'opcode 15 (between DEVICE_STATUS=14 and ALARM_CLEAR=16)', command: '15', payload: base() },
  { label: 'opcode 17 (free-sleep had ALARM_SOLO commented at 17)', command: '17', payload: base() },
  { label: 'opcode 18', command: '18', payload: base() },
  { label: 'opcode 19', command: '19', payload: base() },
  { label: 'opcode 20', command: '20', payload: base() },
]

function encode(payload: Record<string, unknown>): string {
  return Buffer.from(encoder.encode(payload)).toString('hex')
}

async function send(probe: Probe): Promise<{ http: number, body: string }> {
  const args = encode(probe.payload)
  const body = JSON.stringify({ json: { command: probe.command, args } })

  const res = await fetch(`${POD_URL}/api/trpc/device.execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  const text = await res.text()
  return { http: res.status, body: text.slice(0, 240) }
}

async function clearAlarms(): Promise<void> {
  for (const side of ['0', '1']) {
    try {
      await fetch(`${POD_URL}/api/trpc/device.execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: { command: 'ALARM_CLEAR', args: side } }),
      })
    }
    catch { /* ignore — best-effort */ }
  }
}

async function main(): Promise<void> {
  console.log(`Probing ${POD_URL} — ${probes.length} probes, ~${probes.length * (BUZZ_SECONDS + SETTLE_SECONDS)}s total`)
  console.log(`buzz=${BUZZ_SECONDS}s gap=${SETTLE_SECONDS}s pl=40 pi=double`)
  console.log(`Listen for which motor fires (left / right / both / nothing) at each timestamp.`)
  console.log()

  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i]
    const fireStart = stamp()
    let result: { http: number, body: string } | { error: string }
    try {
      result = await send(probe)
    }
    catch (e) {
      result = { error: e instanceof Error ? e.message : String(e) }
    }

    const fireEnd = stamp()
    const ok = 'http' in result && result.http >= 200 && result.http < 300
    const tag = ok ? 'OK ' : 'ERR'
    console.log(`[${i + 1}/${probes.length}] ${fireStart} → ${fireEnd}  ${tag}  cmd=${probe.command.padEnd(12)} ${probe.label}`)
    console.log(`              payload=${JSON.stringify(probe.payload)}`)
    if ('error' in result) {
      console.log(`              error: ${result.error}`)
    }
    else {
      console.log(`              http=${result.http} body=${result.body}`)
    }

    // Let the buzz play out before clearing
    await new Promise(r => setTimeout(r, BUZZ_SECONDS * 1000))
    await clearAlarms()
    await new Promise(r => setTimeout(r, SETTLE_SECONDS * 1000))
  }

  console.log('\nDone. Match observed sides to the timestamps above.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
