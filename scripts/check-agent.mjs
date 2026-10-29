// Offline regressions for the Codex adapter: no Electron UI, model calls or
// real user configuration. All files, skills, sockets and child processes
// belong to this temporary test directory.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const repository = join(dirname(fileURLToPath(import.meta.url)), '..')
async function load(path) {
  const result = await build({ entryPoints: [join(repository, path)], bundle: true,
    platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
}
const [config, bridgeModule, skills, sessions, context] = await Promise.all([
  load('electron/agentConfig.ts'), load('electron/agentBridge.ts'),
  load('electron/agentSkills.ts'), load('electron/agentSessions.ts'), load('shared/agentContext.ts')
])
const temp = await fs.mkdtemp(join(tmpdir(), 'kadr-agent-check-'))
let failures = 0
let passed = 0
const test = async (name, run) => {
  try { await run(); passed++; console.log(`PASS ${name}`) } catch (err) {
    failures++; console.error(`FAIL ${name}: ${err.message}`)
  }
}
const exists = async (path) => fs.access(path).then(() => true, () => false)
const children = []
let bridge

try {
  await test('bad configuration is rejected instead of silently launching defaults', () => {
    for (const value of [null, [], '', { command: '' }, { command: 4 }, { command: 'bad\0path' },
      { args: '--model foo' }, { args: [4] }, { env: [] }, { env: { BAD: 5 } }, { env: { 'BAD=NAME': 'x' } }]) {
      assert.throws(() => config.parseAgentConfig(value))
    }
  })
  await test('valid custom executable, flags and environment survive parsing', () => {
    const value = { command: '/path with spaces/codex', args: ['--model', 'chosen-by-user'], env: { HTTPS_PROXY: 'user-proxy' } }
    assert.deepEqual(config.parseAgentConfig(value), value)
  })
  await test('session environment retains user auth/settings and drops only parent session markers', () => {
    const env = config.sessionEnvironment({ CODEX_HOME: '/user/custom-state', OPENAI_API_KEY: 'test-key',
      CODEX_THREAD_ID: 'old-thread', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/user/custom-claude',
      CODEX_SANDBOX_NETWORK_DISABLED: '1', PATH: '/old', UNDEFINED: undefined }, { PATH: '/chosen' })
    assert.equal(env.CODEX_HOME, '/user/custom-state')
    assert.equal(env.OPENAI_API_KEY, 'test-key')
    assert.equal(env.CLAUDE_CONFIG_DIR, '/user/custom-claude')
    assert.equal(env.CODEX_SANDBOX_NETWORK_DISABLED, '1')
    assert.equal(env.PATH, '/chosen')
    assert.equal(env.CODEX_THREAD_ID, undefined)
    assert.equal(env.CLAUDECODE, undefined)
    assert.equal(Object.hasOwn(env, 'UNDEFINED'), false)
  })
  const bins = join(temp, 'bin with spaces')
  await fs.mkdir(bins)
  const executable = join(bins, 'codex')
  await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await test('executable lookup uses the configured PATH and handles spaces', async () => {
    assert.equal(await config.resolveExecutable('codex', { PATH: bins }, temp, temp), executable)
    assert.equal(await config.resolveExecutable(executable, { PATH: '' }, temp, temp), executable)
  })
  await test('executable lookup never evaluates command injection syntax', async () => {
    const sentinel = join(temp, 'should-not-exist')
    assert.equal(await config.resolveExecutable(`missing; touch ${sentinel}`, { PATH: bins }, temp, temp), null)
    assert.equal(await exists(sentinel), false)
  })
  await test('directories and non-executable files cannot masquerade as a CLI', async () => {
    await fs.mkdir(join(bins, 'directory'))
    await fs.writeFile(join(bins, 'not-executable'), 'test', { mode: 0o600 })
    assert.equal(await config.resolveExecutable('directory', { PATH: bins }, temp, temp), null)
    if (process.platform !== 'win32') assert.equal(await config.resolveExecutable('not-executable', { PATH: bins }, temp, temp), null)
  })
  const launch = { bridgeCommand: '/path with spaces/Electron', bridgePath: '/path/"quoted"/bridge.cjs', port: 12345 }
  const args = config.codexArguments({ ...launch, extraArgs: ['--model', 'chosen-by-user'] })
  await test('Codex launch preserves model choice and has scoped MCP settings without bypass flags', () => {
    assert.deepEqual(args.slice(0, 2), ['--model', 'chosen-by-user'])
    assert.ok(args.includes('--no-daemon'))
    assert.match(args.at(-1), /^mcp_servers\.kadr=\{ /)
    assert.match(args.at(-1), /env_vars = \["KADR_BRIDGE_TOKEN", "KADR_BRIDGE_TIMEOUT_MS"\]/)
    assert.match(args.at(-1), /tool_timeout_sec = 3615/)
    for (const flag of ['--mcp-config', '--append-system-prompt', '--yolo', '--dangerously-bypass-approvals-and-sandbox', '--ask-for-approval', '--sandbox']) {
      assert.ok(!args.includes(flag), `unexpected flag ${flag}`)
    }
  })
  await test('timeout/port validation matches the MCP bridge before a session is launched', () => {
    for (const timeoutMs of ['0', '-1', 'nope', 'Infinity', '0.5', '86400001']) {
      assert.throws(() => config.codexArguments({ ...launch, timeoutMs }))
    }
    for (const port of [0, 65536, NaN, 2.3]) assert.throws(() => config.codexArguments({ ...launch, port }))
    assert.match(config.codexArguments({ ...launch, timeoutMs: '7200000' }).at(-1), /tool_timeout_sec = 7215/)
  })
  await test('PTY sizes reject nonfinite/fractional/extreme dimensions', () => {
    assert.deepEqual(config.terminalSize(NaN, Infinity), { cols: 80, rows: 24 })
    assert.deepEqual(config.terminalSize(-40, 2), { cols: 20, rows: 5 })
    assert.deepEqual(config.terminalSize(80.8, 1e9), { cols: 80, rows: 5000 })
  })
  // Optional integration check against an installed Codex CLI. `mcp get` only
  // parses/prints configuration; it never starts the MCP server or a model.
  if (process.env.KADR_CODEX_TEST_BIN) await test('real Codex accepts escaped TOML and replaces only the Kadr server', async () => {
    const { stdout } = await promisify(execFile)(process.env.KADR_CODEX_TEST_BIN, [
      '-c', 'mcp_servers.kadr.url="https://unused.invalid/mcp"',
      ...config.codexArguments(launch), 'mcp', 'get', 'kadr', '--json'
    ], { cwd: temp })
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.transport.type, 'stdio')
    assert.equal(parsed.transport.command, launch.bridgeCommand)
    assert.deepEqual(parsed.transport.args, [launch.bridgePath, '12345'])
    assert.equal(parsed.tool_timeout_sec, 3615)
  })

  let evaluations = 0
  bridge = await bridgeModule.startBridge(async (code) => {
    evaluations++
    if (code === 'throw') throw new Error('test renderer failure')
    return JSON.stringify({ ok: code })
  })
  const post = (body, headers = {}) => fetch(`http://127.0.0.1:${bridge.port}/eval`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body
  })
  const auth = { 'x-kadr-token': bridge.token }
  await test('bridge is loopback-only and rejects missing/wrong credentials before evaluation', async () => {
    assert.equal(bridge.server.address().address, '127.0.0.1')
    assert.equal((await post('{"code":"x"}')).status, 403)
    assert.equal((await post('{"code":"x"}', { 'x-kadr-token': 'wrong' })).status, 403)
    assert.equal(evaluations, 0)
  })
  await test('browser Origin is refused even with a valid token', async () => {
    assert.equal((await post('{"code":"x"}', { ...auth, Origin: 'http://localhost:3000' })).status, 403)
    assert.equal((await post('{"code":"x"}', { ...auth, Origin: 'null' })).status, 403)
    assert.equal(evaluations, 0)
  })
  await test('malformed bodies cannot be coerced into executable JavaScript', async () => {
    for (const raw of ['bad json', 'null', '[]', '{"code":3}', '{"code":"   "}']) {
      assert.equal((await post(raw, auth)).status, 400)
    }
    assert.equal(evaluations, 0)
  })
  await test('request limit counts bytes and prevents an oversized call from executing', async () => {
    const response = await post(JSON.stringify({ code: 'я'.repeat(bridgeModule.MAX_BRIDGE_REQUEST_BYTES / 2 + 1) }), auth)
    assert.equal(response.status, 413)
    assert.equal(evaluations, 0)
  })
  await test('authorized request and renderer failure retain the explicit result envelope', async () => {
    assert.deepEqual(await (await post('{"code":"works"}', auth)).json(), { ok: 'works' })
    const failure = await (await post('{"code":"throw"}', auth)).json()
    assert.match(failure.error, /test renderer failure/)
    assert.equal(evaluations, 2)
  })
  await test('closing a bridge revokes its listening endpoint', async () => {
    bridgeModule.closeBridge(bridge.server)
    await assert.rejects(post('{"code":"closed"}', auth))
    assert.equal(evaluations, 2)
    bridge = undefined
  })

  const source = join(temp, 'shipped')
  const installed = join(temp, '.agents', 'skills')
  await fs.mkdir(source)
  await fs.mkdir(installed, { recursive: true })
  const skill = (name, version = '1') => `---\nname: ${name}\ndescription: Test Kadr skill\n---\n<!-- managed by Kadr -->\n${version}\n`
  await fs.writeFile(join(source, 'editor.md'), skill('kadr-editor'))
  await test('skill sync installs valid metadata and is idempotent', async () => {
    assert.deepEqual(await skills.syncAgentSkills(source, installed), [])
    const path = join(installed, 'kadr-editor', 'SKILL.md')
    const before = await fs.stat(path)
    assert.equal(await fs.readFile(path, 'utf8'), skill('kadr-editor'))
    await skills.syncAgentSkills(source, installed)
    assert.equal((await fs.stat(path)).mtimeMs, before.mtimeMs)
  })
  await test('a user-owned skill with the same name is never overwritten', async () => {
    const path = join(installed, 'kadr-editor', 'SKILL.md')
    await fs.writeFile(path, 'user custom instructions')
    assert.ok((await skills.syncAgentSkills(source, installed)).length)
    assert.equal(await fs.readFile(path, 'utf8'), 'user custom instructions')
  })
  await test('linked skill directories and linked SKILL.md targets are preserved', async () => {
    await fs.mkdir(join(temp, 'external'))
    await fs.writeFile(join(temp, 'external', 'SKILL.md'), skill('kadr-music', 'user'))
    await fs.writeFile(join(source, 'music.md'), skill('kadr-music', 'new'))
    await fs.symlink(join(temp, 'external'), join(installed, 'kadr-music'), 'dir')
    await fs.mkdir(join(installed, 'kadr-motion'))
    await fs.writeFile(join(source, 'motion.md'), skill('kadr-motion', 'new'))
    await fs.symlink(join(temp, 'external', 'SKILL.md'), join(installed, 'kadr-motion', 'SKILL.md'))
    await skills.syncAgentSkills(source, installed)
    assert.equal(await fs.readFile(join(temp, 'external', 'SKILL.md'), 'utf8'), skill('kadr-music', 'user'))
    assert.ok((await fs.lstat(join(installed, 'kadr-music'))).isSymbolicLink())
    assert.ok((await fs.lstat(join(installed, 'kadr-motion', 'SKILL.md'))).isSymbolicLink())
  })
  await test('retiring a managed skill preserves user additions beside it', async () => {
    const stale = join(installed, 'kadr-retired')
    await fs.mkdir(stale)
    await fs.writeFile(join(stale, 'SKILL.md'), skill('kadr-retired'))
    await fs.writeFile(join(stale, 'notes.md'), 'my notes')
    await skills.syncAgentSkills(source, installed)
    assert.equal(await exists(join(stale, 'SKILL.md')), false)
    assert.equal(await fs.readFile(join(stale, 'notes.md'), 'utf8'), 'my notes')
  })
  await test('empty or invalid shipped metadata cannot erase installed skills', async () => {
    const blank = join(temp, 'blank')
    await fs.mkdir(blank)
    const stale = join(installed, 'kadr-keep')
    await fs.mkdir(stale)
    await fs.writeFile(join(stale, 'SKILL.md'), skill('kadr-keep'))
    await skills.syncAgentSkills(blank, installed)
    await fs.writeFile(join(blank, 'bad.md'), `text before metadata\n${skill('kadr-keep')}`)
    await skills.syncAgentSkills(blank, installed)
    assert.equal(await fs.readFile(join(stale, 'SKILL.md'), 'utf8'), skill('kadr-keep'))
  })
  await test('agent binding changes for another project/folder but not a same-folder Save As', () => {
    const key = context.agentContextKey
    assert.notEqual(key('one', '/edits/a.kadr'), key('two', '/edits/a.kadr'))
    assert.notEqual(key('one', '/edits/a.kadr'), key('one', '/other/a.kadr'))
    assert.notEqual(key('one', null), key('one', '/edits/a.kadr'))
    assert.equal(key('one', '/edits/a.kadr'), key('one', '/edits/b.kadr'))
    assert.equal(key('one', 'C:\\a.kadr'), key('one', 'C:\\b.kadr'))
  })

  if (process.platform === 'linux') {
    const records = join(temp, 'sessions')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    children.push(child)
    await once(child, 'spawn')
    const path = await sessions.rememberSession(records, child.pid)
    assert.ok(path)
    const original = JSON.parse(await fs.readFile(path, 'utf8'))
    await test('startup never kills a recorded helper whose owning editor is alive', async () => {
      assert.equal(await sessions.sweepOwnedSessions(records), 0)
      assert.equal(child.exitCode, null)
      assert.equal(await exists(path), true)
      process.kill(child.pid, 0)
    })
    await test('a stale record for a reused child PID never kills the replacement', async () => {
      const reused = { ...original, ownerStarted: '0', childStarted: '0' }
      const stale = join(records, `${child.pid}-0.json`)
      await fs.writeFile(stale, JSON.stringify(reused))
      assert.equal(await sessions.sweepOwnedSessions(records), 0)
      process.kill(child.pid, 0)
      assert.equal(await exists(stale), false)
    })
    await test('an exact owned orphan group is reaped and its record retired', async () => {
      // A different owner start time simulates the old editor's death/PID reuse.
      await fs.writeFile(path, JSON.stringify({ ...original, ownerStarted: '0' }))
      const ended = once(child, 'exit')
      assert.equal(await sessions.sweepOwnedSessions(records), 1)
      await ended
      assert.equal(child.signalCode, 'SIGKILL')
      assert.equal(await exists(path), false)
    })
  }
} finally {
  if (bridge) bridgeModule.closeBridge(bridge.server)
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await fs.rm(temp, { recursive: true, force: true })
}

console.log(`\n${passed} passed; ${failures} failed`)
process.exitCode = failures ? 1 : 0
