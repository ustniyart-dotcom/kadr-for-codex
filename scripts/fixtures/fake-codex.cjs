#!/usr/bin/env node
// Offline PTY fixture. It deliberately does not invoke Codex, a shell or a model.
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const captureDir = process.env.KADR_E2E_CAPTURE_DIR
if (!captureDir || !process.env.KADR_BRIDGE_TOKEN) {
  console.error('fake Codex requires the isolated E2E fixture configuration')
  process.exit(1)
}
writeFileSync(join(captureDir, `${process.pid}.json`), JSON.stringify({
  pid: process.pid,
  argv: process.argv.slice(2),
  token: process.env.KADR_BRIDGE_TOKEN
}), { mode: 0o600, flag: 'wx' })
process.stdout.write('KADR_E2E_READY\r\n')
process.stdin.setEncoding('utf8')
let pending = ''
process.stdin.on('data', (data) => {
  pending += data
  let newline
  while ((newline = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, newline).replace(/\r$/, '')
    pending = pending.slice(newline + 1)
    process.stdout.write(`KADR_E2E_ECHO:${line}\r\n`)
  }
})
process.stdin.on('end', () => process.exit(0))
