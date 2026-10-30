import { build } from 'esbuild'
// A separate browser graph prevents personal sessions from mounting owner clients.
const result = await build({ entryPoints: ['src/household/web/entry.tsx'], outfile: 'public/household/personal-runtime.js',
  bundle: true, platform: 'browser', format: 'esm', target: ['safari16', 'chrome110'], jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' }, metafile: true, write: false,
})
const forbidden = Object.keys(result.metafile.inputs).filter(path => /src\/(hardware|db|streaming|homekit)\//.test(path)
  || (/src\/server\//.test(path) && !path.endsWith('src/server/validation-schemas.ts')))
if (forbidden.length)
  throw new Error(`Personal browser bundle contains forbidden server modules: ${forbidden.join(', ')}`)
const { writeFile } = await import('node:fs/promises')
for (const output of result.outputFiles)
  await writeFile(output.path, output.contents)
console.log(`Personal browser workspace: ${result.outputFiles[0].contents.length} bytes, isolated graph checked.`)
