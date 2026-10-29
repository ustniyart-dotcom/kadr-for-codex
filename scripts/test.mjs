// Portable regression gate. No display, account, model call or paid API.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const flags = process.argv.slice(2)
if (flags.some((flag) => flag !== '--media')) {
  console.error('Usage: node scripts/test.mjs [--media]')
  process.exit(2)
}

const suites = flags.includes('--media')
  ? ['limiter', 'hdr'] // requires system ffmpeg/ffprobe
  : [
      'envelope', 'ttstext', 'proxy', 'voicemap', 'beats', 'models', 'timeline',
      'paths', 'autosave', 'raw-encoder', 'agent', 'mcp'
    ]

let failed = 0
for (const name of suites) {
  console.log(`\nRunning check-${name}`)
  const result = spawnSync(process.execPath, [join(root, 'scripts', `check-${name}.mjs`)], {
    cwd: root,
    stdio: 'inherit',
    timeout: 180_000
  })
  if (result.error || result.status !== 0) {
    failed++
    console.error(`check-${name} failed: ${result.error?.message ?? result.signal ?? result.status}`)
  }
}
console.log(`\n${suites.length - failed}/${suites.length} suites passed`)
process.exitCode = failed ? 1 : 0
