// Test: embedded Codex integration — PTY terminal session (with an
// offline fake CLI instead of a real model), the editor HTTP bridge,
// and the MCP stdio server end-to-end (initialize → tools/list → kadr_state
// → kadr_eval mutation with undo entry).
import WebSocket from 'ws'
import http from 'http'
import { assertIsolatedEditor, bridgeArgs, installAgentFixture, requireIsolatedUserData } from './e2e-agent-fixture.mjs'

const PORT = process.env.KADR_CDP_PORT || 9777
requireIsolatedUserData()

async function getPageWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('CDP target not found')
}

let id = 0
let ws
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id !== msgId) return
      ws.off('message', onMsg)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}
async function rawEval(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error('JS exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}
async function evalJs(expression, { timeout = 120000 } = {}) {
  const key = `k${Date.now()}_${++id}`
  await rawEval(
    `window.__e2e = window.__e2e || {};` +
    `(async () => { try { window.__e2e.${key} = JSON.stringify({ ok: await (${expression}) }) }` +
    ` catch (e) { window.__e2e.${key} = JSON.stringify({ err: String((e && e.message) || e) }) } })(); 0`
  )
  const t0 = Date.now()
  for (;;) {
    const raw = await rawEval(`window.__e2e.${key} ?? null`)
    if (raw !== null) {
      const r = JSON.parse(raw)
      if ('err' in r) throw new Error('JS exception: ' + r.err)
      return r.ok
    }
    if (Date.now() - t0 > timeout) throw new Error('eval timeout')
    await new Promise((r) => setTimeout(r, 300))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

await assertIsolatedEditor(evalJs)
const fixture = await installAgentFixture(evalJs)

try {
  // give the page a name marker to read back through the bridges
  await evalJs(`(async () => {
    const st = window.kadrEditor.useEditor.getState()
    window.kadrEditor.useEditor.setState({ project: { ...st.project, name: 'mcp-test-project' } })
    return true
  })()`)

  // 1) PTY session: open, type a command, see its output
  const opened = await evalJs(`(async () => {
    window.__cl = ''
    window.__clOff = window.kadr.onClaudeData((d) => { window.__cl += d })
    const r = await window.kadr.claudeOpen(100, 30, null)
    return r
  })()`)
  check('terminal session opens (offline fake Codex)', opened.ok === true && opened.port > 0,
    JSON.stringify(opened))

  const capture = await fixture.capture(opened.port)
  check('Codex receives the session-scoped MCP overlay',
    capture.argv.includes('--no-daemon') && bridgeArgs(capture.argv)[1] === String(opened.port))
  check('Codex launch does not supply a permissions bypass',
    !capture.argv.some((arg) => /dangerously-bypass|yolo|skip-permissions/.test(arg)))

  // /eval runs arbitrary JS in the page, which holds window.kadr (file writes,
  // pty spawn), so the socket carries a per-session secret handed to the MCP
  // server through an environment variable, never a command argument.
  const TOKEN = capture.token
  check('the session token is in the environment and absent from command arguments',
    typeof TOKEN === 'string' && TOKEN.length >= 32 && !capture.argv.some((arg) => arg.includes(TOKEN)))

  const echoed = await evalJs(`(async () => {
    window.kadr.claudeInput('KADR_42\\n')
    await new Promise(r => setTimeout(r, 1200))
    return window.__cl.includes('KADR_E2E_ECHO:KADR_42')
  })()`)
  check('pty round-trip works (typed command echoes back)', echoed === true)

  // 2) editor HTTP bridge: eval from outside the page
  const post = (headers) => new Promise((resolve) => {
    const body = JSON.stringify({
      code: 'return window.kadrEditor.useEditor.getState().project.name'
    })
    const req = http.request(
      { host: '127.0.0.1', port: opened.port, path: '/eval', method: 'POST',
        headers: { 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body), ...headers } },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let parsed = null
          try { parsed = JSON.parse(data) } catch { /* empty body */ }
          resolve({ status: res.statusCode, body: parsed })
        })
      }
    )
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }))
    req.end(body)
  })

  const bridged = await post({ 'x-kadr-token': TOKEN })
  check('editor HTTP bridge evaluates in the page', bridged.body?.ok === 'mcp-test-project',
    JSON.stringify(bridged))

  // anything on this machine can reach 127.0.0.1 — including a web page, which
  // can POST cross-origin without being able to read the reply. Neither gets in.
  const noToken = await post({})
  check('bridge refuses /eval without the session token', noToken.status === 403,
    `status=${noToken.status}`)
  const wrongToken = await post({ 'x-kadr-token': 'f'.repeat(48) })
  check('bridge refuses /eval with a wrong token', wrongToken.status === 403,
    `status=${wrongToken.status}`)
  const fromPage = await post({ 'x-kadr-token': TOKEN, Origin: 'http://localhost:5621' })
  check('bridge refuses /eval that carries a browser Origin', fromPage.status === 403,
    `status=${fromPage.status}`)

  // 3) MCP stdio server: handshake + tools + live state + mutation
  const mcp = await fixture.startMcp(opened.port)
  const pending = new Map()
  let buf = ''
  mcp.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg)
          pending.delete(msg.id)
        }
      } catch { /* partial */ }
    }
  })
  let mcpId = 0
  const mcpCall = (method, params) => new Promise((resolve, reject) => {
    const i = ++mcpId
    const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(method + ' timeout')) } }, 20000)
    pending.set(i, (result) => { clearTimeout(timer); resolve(result) })
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
  })

  const init = await mcpCall('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'e2e', version: '0' }
  })
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  check('MCP server initializes', init.result?.serverInfo?.name === 'kadr',
    JSON.stringify(init.result?.serverInfo))

  const tools = await mcpCall('tools/list', {})
  const names = (tools.result?.tools ?? []).map((t) => t.name).sort()
  check('MCP exposes kadr tools',
    JSON.stringify(names) === JSON.stringify(
      ['kadr_audio_react', 'kadr_beats', 'kadr_check', 'kadr_eval', 'kadr_export',
       'kadr_fragment_create', 'kadr_fragment_media', 'kadr_model_import', 'kadr_models',
       'kadr_neon_wave', 'kadr_sheet', 'kadr_snapshot', 'kadr_sound_add', 'kadr_sound_label',
       'kadr_sounds', 'kadr_state', 'kadr_transcribe', 'kadr_typecheck',
       'kadr_voice_check', 'kadr_voice_learn', 'kadr_voice_mark', 'kadr_voice_regenerate',
       'kadr_voice_speak', 'kadr_voice_verdict']),
    names.join(','))

  const state = await mcpCall('tools/call', { name: 'kadr_state', arguments: {} })
  const stText = state.result?.content?.[0]?.text ?? ''
  const stObj = JSON.parse(stText)
  check('kadr_state returns the live project',
    stObj.project?.name === 'mcp-test-project' && Array.isArray(stObj.exportPresets) && stObj.exportPresets.length > 0,
    `name=${stObj.project?.name}, presets=${stObj.exportPresets?.length}`)

  const mut = await mcpCall('tools/call', {
    name: 'kadr_eval',
    arguments: { code:
      `const st = window.kadrEditor.useEditor.getState()
       st.addTrack('video')
       return window.kadrEditor.useEditor.getState().project.tracks.length` }
  })
  const tracksAfter = JSON.parse(mut.result?.content?.[0]?.text ?? 'null')
  const undoOk = await evalJs(`(async () => {
    const st = window.kadrEditor.useEditor.getState()
    const label = st.past[st.past.length - 1]?.label
    st.undo()
    return { label, tracks: window.kadrEditor.useEditor.getState().project.tracks.length }
  })()`)
  check('kadr_eval mutates the project with an undo entry',
    typeof tracksAfter === 'number' && !!undoOk.label && undoOk.tracks === tracksAfter - 1,
    JSON.stringify({ tracksAfter, ...undoOk }))

  mcp.kill()

  // 4) session teardown
  const closed = await evalJs(`(async () => {
    await window.kadr.claudeClose()
    window.__clOff()
    await new Promise(r => setTimeout(r, 300))
    return true
  })()`)
  const portDead = await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: opened.port, path: '/eval', method: 'POST', timeout: 1500 },
      () => resolve(false)
    )
    req.on('error', () => resolve(true))
    req.on('timeout', () => { req.destroy(); resolve(true) })
    req.end('{}')
  })
  check('closing the session kills pty and bridge port', closed === true && portDead === true)
} finally {
  await fixture.restore()
  ws.close()
}

console.log('e2e22 finished')
