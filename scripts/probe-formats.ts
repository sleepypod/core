import { Encoder } from 'cbor-x'

const enc = new Encoder({ useRecords: false })
const cborPayload = Buffer.from(enc.encode({ pl: 80, du: 30, pi: 'double', tt: Math.floor(Date.now() / 1000) })).toString('hex')

const probes = [
  { label: 'cmd5 LEFT + CBOR', cmd: 'ALARM_LEFT', args: cborPayload },
  { label: 'cmd6 RIGHT + comma', cmd: 'ALARM_RIGHT', args: '80,0,30' },
  { label: 'cmd6 RIGHT + CBOR', cmd: 'ALARM_RIGHT', args: cborPayload },
  { label: 'cmd2 SOLO + comma', cmd: 'ALARM_SOLO', args: '80,0,30' },
  { label: 'cmd2 SOLO + CBOR', cmd: 'ALARM_SOLO', args: cborPayload },
  { label: 'cmd5 LEFT + alt comma 80,1,30 (rise)', cmd: 'ALARM_LEFT', args: '80,1,30' },
]

async function main() {
  for (const p of probes) {
    const res = await fetch('http://192.168.1.88:3000/api/trpc/device.execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { command: p.cmd, args: p.args } }),
    })
    const body = await res.text()
    const m = body.match(/"response":"([^"]*)"/)
    console.log(`${p.label.padEnd(48)} → response=${m?.[1] ?? '?'}`)
    // wait between probes for clear
    await fetch('http://192.168.1.88:3000/api/trpc/device.execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { command: 'ALARM_CLEAR', args: '0' } }),
    })
    await new Promise(r => setTimeout(r, 2000))
  }
}
main()
