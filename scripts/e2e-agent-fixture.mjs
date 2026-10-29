// Shared safety guard and fake Codex for desktop suites. Launch BOTH the editor
// and the suite with the same disposable KADR_USER_DATA under os.tmpdir().
// Never falls back to the real profile or the installed authenticated Codex.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))

function isolatedDirectory(variable) {
  const configured = process.env[variable]
  if (!configured || !isAbsolute(configured)) {
    throw new Error(`Set ${variable} to the same disposable absolute temp directory for the editor and this suite`)
  }
  const root = realpathSync(tmpdir())
  const profile = realpathSync(configured)
  const tail = relative(root, profile)
  if (!tail || tail.startsWith('..') || isAbsolute(tail)) {
    throw new Error(`${variable} for agent E2E suites must be a dedicated directory under os.tmpdir()`)
  }
  return profile
}

export function requireIsolatedUserData() {
  // Skill synchronization happens in main at startup, independently of the
  // editor profile. Its destination must also be disposable before launching.
  isolatedDirectory('KADR_AGENT_SKILLS_DIR')
  return isolatedDirectory('KADR_USER_DATA')
}

export async function assertIsolatedEditor(evalJs, { blank = true } = {}) {
  const expected = requireIsolatedUserData()
  const info = await evalJs(`(async () => {
    const scan = await window.kadr.storageScan([], null)
    const project = window.kadrEditor.useEditor.getState().project
    return { proxies: scan.groups.find(g => g.id === 'proxies')?.dir,
      clips: project.tracks.reduce((n, t) => n + t.clips.length, 0) }
  })()`)
  assert.equal(typeof info.proxies, 'string', 'running editor must expose its storage roots')
  assert.equal(realpathSync(dirname(info.proxies)), expected,
    'CDP target uses a different profile: refusing to edit or launch an assistant')
  if (blank) assert.equal(info.clips, 0, 'start the suite with a blank project in the disposable profile')
  return expected
}

// The generated table uses JSON-compatible TOML strings. Parse just the bridge
// argv needed by this fixture, without treating CLI input as executable code.
export function bridgeArgs(argv) {
  const overlay = argv.find((arg) => arg.startsWith('mcp_servers.kadr='))
  assert.ok(overlay, 'Codex receives the Kadr MCP server overlay')
  const match = overlay.match(/args\s*=\s*(\[(?:\s*"(?:\\.|[^"\\])*"\s*,?)*\s*\])/)
  assert.ok(match, 'MCP overlay contains a JSON-compatible argv array')
  return JSON.parse(match[1])
}

export async function installAgentFixture(evalJs) {
  const profile = await assertIsolatedEditor(evalJs, { blank: false })
  const configPath = join(profile, 'codex-env.json')
  if (existsSync(configPath) && lstatSync(configPath).isSymbolicLink()) {
    throw new Error('refusing to replace a symlinked Codex test configuration')
  }
  const previous = existsSync(configPath) ? readFileSync(configPath) : null
  const captureDir = mkdtempSync(join(profile, 'e2e-agent-'))
  chmodSync(captureDir, 0o700)
  const children = new Set()
  let restored = false
  const restoreFiles = () => {
    if (restored) return
    restored = true
    for (const child of children) child.kill()
    if (previous === null) rmSync(configPath, { force: true })
    else writeFileSync(configPath, previous, { mode: 0o600 })
    rmSync(captureDir, { recursive: true, force: true })
  }
  process.once('exit', restoreFiles)
  writeFileSync(configPath, JSON.stringify({
    command: process.execPath,
    args: [join(scripts, 'fixtures', 'fake-codex.cjs')],
    // cfg.env has the final say if the editor's launcher set a command override.
    env: { KADR_CODEX_CMD: process.execPath, KADR_E2E_CAPTURE_DIR: captureDir }
  }), { mode: 0o600 })

  const records = () => readdirSync(captureDir).filter((file) => file.endsWith('.json')).map((file) => {
    try { return JSON.parse(readFileSync(join(captureDir, file), 'utf8')) } catch { return null }
  }).filter(Boolean)
  const capture = async (port) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = records().find((item) => bridgeArgs(item.argv).at(-1) === String(port))
      if (record) return record
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('fake Codex did not start: refusing to use a real CLI or guess session credentials')
  }
  const activeRecords = () => records().filter(({ pid }) => {
    try { process.kill(pid, 0); return true } catch { return false }
  })
  return {
    capture,
    activeRecords,
    activeSessions: () => activeRecords().length,
    async startMcp(port) {
      const record = await capture(port)
      const child = spawn(process.execPath, [resolve(scripts, '..', 'electron', 'mcp-bridge.cjs'), String(port)], {
        cwd: resolve(scripts, '..'), stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, KADR_BRIDGE_TOKEN: record.token }
      })
      children.add(child)
      child.once('exit', () => children.delete(child))
      return child
    },
    async restore() {
      try { await evalJs('window.kadr.claudeClose()') } finally {
        process.off('exit', restoreFiles)
        restoreFiles()
      }
    }
  }
}
