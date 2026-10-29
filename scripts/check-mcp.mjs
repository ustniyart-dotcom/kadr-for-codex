// Real MCP stdio handshake/tools/calls against a local fake editor. No Electron,
// GPU, user config, credentials, model calls or paid APIs are used.
// Run: node scripts/check-mcp.mjs
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { assertIsolatedEditor, bridgeArgs, installAgentFixture } from './e2e-agent-fixture.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'electron', 'mcp-bridge.cjs')
const TOKEN = 'test-only-session-secret'
const EXPECTED_TOOLS = [
  'kadr_state', 'kadr_eval', 'kadr_snapshot', 'kadr_sheet', 'kadr_model_import',
  'kadr_fragment_media', 'kadr_models', 'kadr_check', 'kadr_typecheck', 'kadr_export',
  'kadr_transcribe', 'kadr_fragment_create', 'kadr_beats', 'kadr_audio_react',
  'kadr_sounds', 'kadr_sound_add', 'kadr_sound_label', 'kadr_neon_wave',
  'kadr_voice_speak', 'kadr_voice_check', 'kadr_voice_verdict', 'kadr_voice_mark',
  'kadr_voice_regenerate', 'kadr_voice_learn'
]

async function fixture(t, { window = {}, timeout = 5000, legacyToken = false, handler } = {}) {
  const calls = []
  const http = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(404).end(); return }
    assert.equal(req.url, '/eval')
    assert.equal(req.headers['x-kadr-token'], TOKEN)
    assert.equal(req.headers.origin, undefined)
    let body = ''
    for await (const chunk of req) body += chunk
    const { code } = JSON.parse(body)
    calls.push(code)
    if (handler && await handler({ code, req, res, calls })) return
    try {
      const value = await vm.runInNewContext(`(async () => { ${code}\n })()`, { window }, { timeout: 1000 })
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: value === undefined ? null : value }))
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e) }))
    }
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const env = { ...process.env, KADR_BRIDGE_TIMEOUT_MS: String(timeout) }
  delete env.KADR_BRIDGE_TOKEN
  if (!legacyToken) env.KADR_BRIDGE_TOKEN = TOKEN
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, String(http.address().port), ...(legacyToken ? [TOKEN] : [])],
    cwd: root, env, stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr.on('data', (chunk) => { stderr += chunk })
  const client = new Client({ name: 'kadr-bridge-regression', version: '1.0.0' })
  t.after(async () => {
    await client.close()
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
    assert.equal(stderr, '', 'stdio server must not leak diagnostics or credentials on successful runs')
  })
  await client.connect(transport)
  const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 8000 })
  return { client, call, calls, window }
}

const value = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text)
  return JSON.parse(result.content[0].text)
}
const error = (result, pattern) => {
  assert.equal(result.isError, true, 'failures must be MCP tool errors')
  const message = result.content[0].text
  assert.match(message, pattern)
  assert.ok(!message.includes(TOKEN), 'never include the session secret in an error')
  return message
}

test('startup rejects missing authentication, invalid ports and invalid deadlines', () => {
  const env = { ...process.env }
  delete env.KADR_BRIDGE_TOKEN
  delete env.KADR_BRIDGE_TIMEOUT_MS
  for (const [args, overrides] of [
    [['1234'], {}], [['0', TOKEN], {}], [['65536', TOKEN], {}],
    [['1.5', TOKEN], {}], [['1234', TOKEN], { KADR_BRIDGE_TIMEOUT_MS: 'NaN' }]
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5000
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /usage:/)
    assert.ok(!result.stderr.includes(TOKEN))
  }
})

test('stdio initializes with host-neutral guidance and all 24 annotated tools', async (t) => {
  const { client, call } = await fixture(t)
  assert.equal(client.getServerVersion().name, 'kadr')
  assert.match(client.getInstructions(), /LIVE video project/)
  assert.match(client.getInstructions(), /kadr-editor/)
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort())
  for (const tool of tools) assert.ok(tool.annotations, `${tool.name} supplies approval hints`)
  assert.equal(tools.find((tool) => tool.name === 'kadr_state').annotations.readOnlyHint, true)
  assert.equal(tools.find((tool) => tool.name === 'kadr_eval').annotations.readOnlyHint, false)
  assert.equal(tools.find((tool) => tool.name === 'kadr_voice_speak').annotations.openWorldHint, true)
  assert.equal(value(await call('kadr_eval', { code: 'return 42' })), 42)
  assert.equal(value(await call('kadr_eval', { code: 'return undefined' })), null)
  assert.deepEqual(value(await call('kadr_eval', { code: 'return { text: "Привет 👋", nested: [0, false, null] }' })),
    { text: 'Привет 👋', nested: [0, false, null] })
})

test('legacy token argument still authenticates older clients', async (t) => {
  const { call } = await fixture(t, { legacyToken: true })
  assert.equal(value(await call('kadr_eval', { code: 'return true' })), true)
})

test('state omits binary media blobs while preserving compact project information', async (t) => {
  const { call } = await fixture(t, { window: {
    kadrEditor: {
      useEditor: { getState: () => ({
        project: { name: 'live project', tracks: [], assets: [{ id: 'a', path: '/tmp/a.mp4', waveform: 'large', thumbnail: 'large', thumbnailEnd: 'large' }] },
        projectPath: '/tmp/project.kadr', selection: ['a'], playhead: 2
      }) },
      PRESETS: [{ id: 'mp4', name: 'MP4', container: 'mp4' }], placeDefects: () => []
    }
  } })
  const state = value(await call('kadr_state'))
  assert.deepEqual(state.project.assets, [{ id: 'a', path: '/tmp/a.mp4', hasWaveform: true, hasThumbnail: true }])
  assert.equal(state.projectPath, '/tmp/project.kadr')
  assert.deepEqual(state.selection, ['a'])
})

test('HTTP, malformed envelope and renderer exceptions return explicit tool failures', async (t) => {
  const { call } = await fixture(t, { handler: ({ code, res }) => {
    if (code === 'http403') { res.writeHead(403).end(); return true }
    if (code === 'http500') { res.writeHead(500).end('internal failure'); return true }
    if (code === 'malformed') { res.end('{broken'); return true }
    if (code === 'noEnvelope') { res.end('{}'); return true }
    if (code === 'emptyError') { res.end('{"error":""}'); return true }
    return false
  } })
  for (const [code, pattern] of [
    ['http403', /stale token/], ['http500', /HTTP 500/],
    ['malformed', /invalid editor response/], ['noEnvelope', /expected an ok or error/],
    ['emptyError', /Error:/], ['throw new Error("renderer failed")', /renderer failed/]
  ]) error(await call('kadr_eval', { code }), pattern)
  assert.equal(value(await call('kadr_eval', { code: 'return "still connected"' })), 'still connected')
})

test('a broken response is bounded and reports unknown completion instead of hanging', async (t) => {
  const { call } = await fixture(t, { handler: ({ code, res }) => {
    if (code !== 'interrupt') return false
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"ok":')
    setImmediate(() => res.destroy())
    return true
  } })
  error(await call('kadr_eval', { code: 'interrupt' }), /may still be running or may already have completed/)
  assert.equal(value(await call('kadr_eval', { code: 'return 2' })), 2)
})

test('wall-clock timeout returns a recoverable error without retrying the operation', async (t) => {
  const { call, calls } = await fixture(t, { timeout: 150, handler: ({ code }) => code === 'neverCompletes' })
  error(await call('kadr_eval', { code: 'neverCompletes' }), /timed out after 150 ms/)
  assert.equal(calls.filter((code) => code === 'neverCompletes').length, 1)
  assert.equal(value(await call('kadr_eval', { code: 'return 3' })), 3)
})

test('UTF-8 result and response bounds reject oversize data without breaking MCP', async (t) => {
  const { call } = await fixture(t)
  // Below 4 million characters, above 4 million UTF-8 bytes.
  error(await call('kadr_eval', { code: 'return "я".repeat(2_100_000)' }), /result exceeds 4 MB/)
  error(await call('kadr_eval', { code: 'return "x".repeat(9_000_000)' }), /response exceeds 8 MiB/)
  assert.equal(value(await call('kadr_eval', { code: 'return 4' })), 4)
})

test('oversize requests are rejected before the editor sees them', async (t) => {
  const { call, calls } = await fixture(t)
  error(await call('kadr_eval', { code: `/*${'я'.repeat(2_100_000)}*/ return 1` }), /request exceeds 4 MiB/)
  assert.equal(calls.length, 0)
})

test('incomplete/reversed/negative ranges fail before any editing or full-project fallback', async (t) => {
  const { call, calls } = await fixture(t)
  for (const [tool, args] of [
    ['kadr_export', { outputPath: '/tmp/render.mp4', start: 1 }],
    ['kadr_export', { outputPath: '/tmp/render.mp4', start: 3, end: 2 }],
    ['kadr_beats', { end: 3, clear: true }],
    ['kadr_beats', { start: -1, end: 3 }],
    ['kadr_transcribe', {}],
    ['kadr_transcribe', { assetId: 'a', start: 0, end: 3 }],
    ['kadr_transcribe', { start: 2, end: 2 }],
    ['kadr_fragment_create', { name: 'intro', start: 5, end: 3 }],
    ['kadr_model_import', { paths: ['/tmp/model.glb'], insert: { start: 5, end: 3 } }],
    ['kadr_neon_wave', { start: -1, end: 1 }],
    ['kadr_voice_mark', { start: 3, end: 2 }]
  ]) error(await call(tool, args), /start|assetId/)
  assert.equal(calls.length, 0)
})

test('schema boundaries reject values that contradict their tool contract', async (t) => {
  const { call, calls } = await fixture(t)
  for (const [tool, args] of [
    ['kadr_snapshot', { t: -1 }], ['kadr_sheet', { times: [-1] }],
    ['kadr_sounds', { limit: -2 }], ['kadr_sounds', { limit: 1.5 }],
    ['kadr_sound_add', { id: 'sound', gain: 3 }],
    ['kadr_voice_check', { minConfidence: 2 }],
    ['kadr_transcribe', { assetId: 'a', maxWords: -2 }],
    ['kadr_voice_verdict', { ids: [], defect: true }]
  ]) error(await call(tool, args), /validation|Invalid|Too|small|big/i)
  assert.equal(calls.length, 0)
})

test('export preserves the requested range/path and reports failures instead of success', async (t) => {
  let received
  let fail = false
  const { call } = await fixture(t, { window: { kadrEditor: {
    PRESETS: [{ id: 'mp4', container: 'mp4' }], useEditor: { getState: () => ({ project: {} }) },
    startExport: (project, preset, path, progress, range) => {
      received = { path, range }
      return { done: fail ? Promise.reject(new Error('render failed')) : Promise.resolve() }
    }
  } } })
  const path = '/tmp/файл "quoted".mp4'
  const result = value(await call('kadr_export', { outputPath: path, start: 1, end: 2 }))
  assert.deepEqual(result, { written: path, preset: 'mp4' })
  assert.deepEqual(JSON.parse(JSON.stringify(received)), { path, range: { start: 1, end: 2 } })
  value(await call('kadr_export', { outputPath: path }))
  assert.equal(received.range, null)
  fail = true
  error(await call('kadr_export', { outputPath: path }), /render failed/)
})

test('voice marks require an unambiguous voice-over and a range fully inside one clip', async (t) => {
  const project = {
    voiceRuns: [{ assetId: 'a' }, { assetId: 'b' }],
    tracks: [{ clips: [{ assetId: 'a', start: 2, duration: 4 }, { assetId: 'b', start: 2, duration: 4 }] }],
    defects: [{ id: 'new', src: [1, 2], phrase: { t0: 0, t1: 3, text: 'phrase' } }]
  }
  let edits = 0
  const { call } = await fixture(t, { window: { kadrEditor: {
    useEditor: { getState: () => ({ project }) }, projectToSrc: (clip, time) => time - clip.start,
    addUserDefect: async (assetId, start, end) => {
      assert.equal(assetId, 'a'); assert.equal(start, 1); assert.equal(end, 2)
      edits++; return 'new'
    }
  } } })
  error(await call('kadr_voice_mark', { start: 3, end: 4 }), /exactly one voice-over/)
  error(await call('kadr_voice_mark', { assetId: 'a', start: 1, end: 3 }), /inside exactly one clip/)
  assert.equal(edits, 0)
  assert.equal(value(await call('kadr_voice_mark', { assetId: 'a', start: 3, end: 4 })).id, 'new')
  assert.equal(edits, 1)
  project.tracks[0].clips.push({ assetId: 'a', start: 2, duration: 4 })
  error(await call('kadr_voice_mark', { assetId: 'a', start: 3, end: 4 }), /inside exactly one clip/)
  assert.equal(edits, 1)
})

function desktopProfile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kadr-e2e-guard-'))
  const profile = join(dir, 'profile')
  const skills = join(dir, 'skills')
  mkdirSync(profile)
  mkdirSync(skills)
  const previous = {
    KADR_USER_DATA: process.env.KADR_USER_DATA,
    KADR_AGENT_SKILLS_DIR: process.env.KADR_AGENT_SKILLS_DIR
  }
  process.env.KADR_USER_DATA = profile
  process.env.KADR_AGENT_SKILLS_DIR = skills
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, profile, config: join(profile, 'codex-env.json') }
}

test('desktop smoke guard refuses a mismatched profile or nonempty project before writing config', async (t) => {
  const { dir, profile, config } = desktopProfile(t)
  await assert.rejects(installAgentFixture(async () => ({ proxies: join(dir, 'proxies'), clips: 0 })),
    /different profile/)
  assert.equal(existsSync(config), false)
  await assert.rejects(assertIsolatedEditor(async () => ({ proxies: join(profile, 'proxies'), clips: 3 })),
    /blank project/)
  assert.equal(existsSync(config), false)
})

test('offline desktop fixture captures only session data and restores its previous configuration', async (t) => {
  const { profile, config } = desktopProfile(t)
  const original = '{ "args": ["--no-alt-screen"] }\n'
  writeFileSync(config, original)
  const fake = await installAgentFixture(async (code) => code.includes('storageScan')
    ? { proxies: join(profile, 'proxies'), clips: 0 } : undefined)
  const cfg = JSON.parse(readFileSync(config, 'utf8'))
  assert.equal(cfg.command, process.execPath)
  assert.equal(cfg.env.KADR_CODEX_CMD, process.execPath)
  const args = ['--no-daemon', '-c', `mcp_servers.kadr={ args = [${JSON.stringify(entry)}, "1234"] }`]
  assert.deepEqual(bridgeArgs(args), [entry, '1234'])
  const child = spawn(cfg.command, [...cfg.args, ...args], {
    env: { ...process.env, ...cfg.env, KADR_BRIDGE_TOKEN: TOKEN }, stdio: ['pipe', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  try {
    const record = await fake.capture(1234)
    assert.equal(record.pid, child.pid)
    assert.equal(record.token, TOKEN)
    assert.deepEqual(Object.keys(record).sort(), ['argv', 'pid', 'token'])
    assert.equal(statSync(join(cfg.env.KADR_E2E_CAPTURE_DIR, `${child.pid}.json`)).mode & 0o777, 0o600)
    child.stdin.write('KADR_42\n')
    for (let i = 0; i < 50 && !output.includes('KADR_E2E_ECHO:KADR_42'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.match(output, /KADR_E2E_READY/)
    assert.match(output, /KADR_E2E_ECHO:KADR_42/)
    assert.ok(!output.includes(TOKEN))
  } finally {
    child.kill()
    if (child.exitCode === null) await once(child, 'exit')
    await fake.restore()
  }
  assert.equal(readFileSync(config, 'utf8'), original)
  assert.equal(existsSync(cfg.env.KADR_E2E_CAPTURE_DIR), false)
})

test('desktop fixture refuses a configuration symlink instead of overwriting its target', async (t) => {
  const { dir, profile, config } = desktopProfile(t)
  const target = join(dir, 'untouched.json')
  writeFileSync(target, 'keep me')
  symlinkSync(target, config)
  await assert.rejects(installAgentFixture(async () => ({ proxies: join(profile, 'proxies'), clips: 0 })),
    /symlinked/)
  assert.equal(readFileSync(target, 'utf8'), 'keep me')
})
