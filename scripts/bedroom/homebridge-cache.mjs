/** Read-only Homebridge cache publisher. Its SSH key cannot read history or control the Pod. */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function cacheReadings(accessories, sources) {
  return sources.map((source) => {
    const accessory = accessories.find(item => item.aid === source.aid)
    const characteristic = accessory?.services?.flatMap(service => service.characteristics ?? [])
      .find(item => item.iid === source.iid)
    let value = characteristic?.value
    if (typeof value === 'boolean' && source.metric === 'power') value = Number(value)
    const bounds = { temperature: [-40, 60], humidity: [0, 100], pm25: [0, 2000],
      airQuality: [1, 5], power: [0, 1], fanSpeed: [0, 100], filterLife: [0, 100] }[source.metric]
    if (!bounds || typeof value !== 'number' || !Number.isFinite(value) || value < bounds[0] || value > bounds[1]
      || (['power', 'airQuality'].includes(source.metric) && !Number.isInteger(value))
      || (characteristic?.status !== undefined && characteristic.status !== 0)) value = null
    return { sourceId: source.sourceId, value }
  })
}

async function boundedJson(response) {
  if (!response.ok) throw new Error('Bridge unavailable')
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > 1048576) throw new Error('Bridge response too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function publish(config, readings) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.sshExecutable, ['-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR',
      '-o', `UserKnownHostsFile=${config.knownHosts}`, '-i', config.keyFile, '-p', String(config.podPort),
      `${config.podUser}@${config.podHost}`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const deadline = setTimeout(() => child.kill(), 14000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
      if (output.length > 16384) child.kill()
    })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(deadline)
      try {
        const result = JSON.parse(output)
        if (code !== 0 || result.cachedOnly !== true) throw new Error('Publication rejected')
        resolve(result)
      }
      catch { reject(new Error('Publication unavailable')) }
    })
    child.stdin.end(JSON.stringify({ version: 1, issuedAt: Date.now(), readings }))
  })
}

export async function cycle(config) {
  let readings
  try {
    const response = await fetch(config.bridgeUrl + '/accessories', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
    })
    const value = await boundedJson(response)
    if (!Array.isArray(value.accessories)) throw new Error('Invalid bridge response')
    readings = cacheReadings(value.accessories, config.sources)
  }
  catch { readings = config.sources.map(source => ({ sourceId: source.sourceId, value: null })) }
  return publish(config, readings)
}

async function main() {
  const filename = process.argv[2]
  const config = JSON.parse(await readFile(filename, 'utf8'))
  const once = process.argv.includes('--once')
  do {
    let status
    try {
      status = { ...(await cycle(config)), checkedAt: new Date().toISOString() }
    }
    catch { status = { error: 'publisher_unavailable', checkedAt: new Date().toISOString() } }
    if (config.statusFile) {
      await writeFile(config.statusFile + '.tmp', JSON.stringify(status), { mode: 0o600 })
      await rename(config.statusFile + '.tmp', config.statusFile)
    }
    if (once) console.log(JSON.stringify(status))
    else await new Promise(resolve => setTimeout(resolve, 15000))
  } while (!once)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Publisher stopped; inspect the private installation.')
    process.exitCode = 1
  })
}
