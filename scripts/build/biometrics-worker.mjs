import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'

const output = process.argv[2] ?? '.next/standalone/biometrics-worker'
await mkdir(output, { recursive: true })
const result = await build({
  entryPoints: ['src/biometrics/backtest/worker-entry.ts'],
  outfile: `${output}/worker.cjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: false,
  metafile: true,
  treeShaking: true,
})
// Fail packaging if the pure worker ever pulls in live application entrypoints.
const forbidden = Object.keys(result.metafile.inputs).filter(path =>
  /src\/(hardware|automation|scheduler|homekit|streaming)\//.test(path)
  || /src\/db\//.test(path) || /drizzle-orm|better-sqlite3/.test(path),
)
if (forbidden.length) throw new Error(`Replay worker has live dependencies: ${forbidden.join(', ')}`)
await writeFile(`${output}/dependencies.json`, JSON.stringify(Object.keys(result.metafile.inputs).sort(), null, 2))

// The coordinator owns SQLite and artifact I/O, but never live application services.
const coordinator = await build({
  entryPoints: ['src/biometrics/backtest/coordinator-entry.ts'],
  outfile: `${output}/coordinator.cjs`, bundle: true, platform: 'node', target: 'node22',
  format: 'cjs', metafile: true, external: ['better-sqlite3'],
})
const live = Object.keys(coordinator.metafile.inputs).filter(path =>
  /src\/(hardware|automation|scheduler|homekit|streaming)\//.test(path)
  || /src\/db\/(index|biometrics)\.ts$/.test(path),
)
if (live.length) throw new Error(`Coordinator has live entrypoints: ${live.join(', ')}`)
await writeFile(`${output}/coordinator-dependencies.json`, JSON.stringify(Object.keys(coordinator.metafile.inputs).sort(), null, 2))

// The prospective host observes a shared passive tap. Live receive timestamps
// are injected by the service; bundling hardware/streaming entrypoints is forbidden.
const shadow = await build({
  entryPoints: ['src/biometrics/shadow/host-entry.ts'],
  outfile: `${output}/shadow-host.cjs`, bundle: true, platform: 'node', target: 'node22',
  format: 'cjs', metafile: true, external: ['better-sqlite3'],
})
const shadowLive = Object.keys(shadow.metafile.inputs).filter(path =>
  /src\/(hardware|automation|scheduler|homekit)\//.test(path)
  || (/src\/streaming\//.test(path) && !path.endsWith('/prospectiveFrameTap.ts'))
  || /src\/db\/(index|biometrics)\.ts$/.test(path),
)
if (shadowLive.length) throw new Error(`Shadow host has live entrypoints: ${shadowLive.join(', ')}`)
await writeFile(`${output}/shadow-host-dependencies.json`, JSON.stringify(Object.keys(shadow.metafile.inputs).sort(), null, 2))

// Prospective temperature research reads both databases in an isolated, read-only child.
const predictive = await build({
  entryPoints: ['src/comfort/predictive-worker-entry.ts'],
  outfile: `${output}/predictive-worker.cjs`, bundle: true, platform: 'node', target: 'node22',
  format: 'cjs', metafile: true, external: ['better-sqlite3'],
})
const predictiveLive = Object.keys(predictive.metafile.inputs).filter(path =>
  /src\/(hardware|automation|scheduler|homekit|streaming)\//.test(path)
  || /src\/db\/(index|biometrics)\.ts$/.test(path),
)
if (predictiveLive.length) throw new Error(`Predictive worker has live entrypoints: ${predictiveLive.join(', ')}`)
await writeFile(`${output}/predictive-dependencies.json`, JSON.stringify(Object.keys(predictive.metafile.inputs).sort(), null, 2))
