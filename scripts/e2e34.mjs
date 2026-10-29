// Test: the two locks reported from outside (issues #11 and #13).
//
// #11 — one panel open must spawn exactly ONE Codex session. openSession is
// async and closeSession is instant, so a close that overtook an in-flight open
// used to leave the spawned pty orphaned; React StrictMode's double mount made
// that happen on every panel open in dev, and two ptys wrote into one xterm.
//
// #13 — kadr:// streams any absolute path with bypassCSP + ACAO:*, which the
// media elements need. The fragment dev server, though, serves pages on another
// origin with no node access, and those could read any file. Every URL now
// carries a per-run capability token that only the preload knows.
//
// Launch app + suite with the same disposable KADR_USER_DATA under os.tmpdir().
import WebSocket from 'ws'
import { writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { assertIsolatedEditor, bridgeArgs, installAgentFixture, requireIsolatedUserData } from './e2e-agent-fixture.mjs'

const PORT = process.env.KADR_CDP_PORT || 9777
requireIsolatedUserData()
const CANARY_DIR = '/tmp/kadr-test/issue13'
const CANARY = `${CANARY_DIR}/canary.txt`

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
async function evalJs(expression, { timeout = 300000 } = {}) {
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
    await new Promise((r) => setTimeout(r, 500))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

mkdirSync(CANARY_DIR, { recursive: true })
writeFileSync(CANARY, 'CANARY-e2e34-outside-any-project\n')

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
await assertIsolatedEditor(evalJs)

const fixture = await installAgentFixture(evalJs)
try {
  // ---------------------------------------------------------------- issue #11
  check('no Codex session before the panel is opened', fixture.activeSessions() === 0)

  const opened = await evalJs(`(async () => {
    const b = document.querySelector('.claude-btn')
    if (!b || !b.textContent.includes('Codex')) throw new Error('no Codex button')
    b.click()
    await new Promise((r) => setTimeout(r, 4000))
    return !!document.querySelector('.claude-panel')
  })()`)
  check('the panel mounts', opened)
  const afterOpen = fixture.activeSessions()
  // StrictMode mounts the panel twice in dev; both mounts must share one session
  check('one panel open spawns exactly ONE session (issue #11)', afterOpen === 1, `sessions=${afterOpen}`)

  const closed = await evalJs(`(async () => {
    document.querySelector('.claude-panel .claude-close').click()
    await new Promise((r) => setTimeout(r, 2500))
    return !document.querySelector('.claude-panel')
  })()`)
  await new Promise((r) => setTimeout(r, 1500))
  check('closing the panel leaves no session behind', closed && fixture.activeSessions() === 0, `sessions=${fixture.activeSessions()}`)

  // the same race without React in the picture: a close that overtakes the
  // in-flight open (a fast panel toggle) must not leak the spawned pty either
  await evalJs(`(async () => {
    window.kadr.claudeOpen(80, 24, null)
    window.kadr.claudeClose()
    await new Promise((r) => setTimeout(r, 5000))
    return 1
  })()`)
  await new Promise((r) => setTimeout(r, 1500))
  check('a close overtaking an in-flight open leaks nothing', fixture.activeSessions() === 0, `sessions=${fixture.activeSessions()}`)

  // and the ordinary path still works
  const reopened = await evalJs(`window.kadr.claudeOpen(80, 24, null)`)
  await new Promise((r) => setTimeout(r, 1500))
  check('a plain open still starts one working session', reopened.ok === true && fixture.activeSessions() === 1,
    `ok=${reopened.ok} port=${reopened.port} sessions=${fixture.activeSessions()}`)
  await evalJs(`window.kadr.claudeClose()`)
  await new Promise((r) => setTimeout(r, 1500))
  check('and closing it kills that session', fixture.activeSessions() === 0)

  // A project switch must invalidate the old assistant and its capability:
  // old instructions/cwd must never silently edit a newly opened project.
  await evalJs(`(async () => {
    document.querySelector('.claude-btn').click()
    await new Promise(r => setTimeout(r, 3000))
    return true
  })()`)
  const beforeSwitch = fixture.activeRecords()
  check('project-switch fixture has exactly one live assistant', beforeSwitch.length === 1)
  const oldPort = Number(bridgeArgs(beforeSwitch[0].argv)[1])
  await evalJs(`(async () => {
    const st = window.kadrEditor.useEditor.getState()
    st.setProject({ ...st.project, id: 'e2e34-new-' + Date.now(), name: 'new test project' }, null)
    await new Promise(r => setTimeout(r, 4000))
    return true
  })()`)
  const afterSwitch = fixture.activeRecords()
  check('opening a different project replaces the assistant with one fresh session',
    afterSwitch.length === 1 && afterSwitch[0].pid !== beforeSwitch[0].pid &&
    Number(bridgeArgs(afterSwitch[0].argv)[1]) !== oldPort)
  const oldBridgeClosed = await fetch(`http://127.0.0.1:${oldPort}/`, { signal: AbortSignal.timeout(1500) })
    .then(() => false, () => true)
  check('the previous project bridge no longer accepts requests', oldBridgeClosed)
  await evalJs(`(async () => {
    document.querySelector('.claude-close').click()
    await new Promise(r => setTimeout(r, 2000))
    return true
  })()`)
  check('the replacement assistant is also cleaned up', fixture.activeSessions() === 0)

  // Optional lifecycle-only run: the media capability checks below need the
  // synthetic a.mp4 and an installed Remotion workspace/GPU-capable display.
  if (process.env.KADR_E2E_AGENT_ONLY !== '1') {
  // ---------------------------------------------------------------- issue #13
  const media = await evalJs(`(async () => {
    const url = window.kadr.fileUrl('/tmp/kadr-test/a.mp4')
    const withToken = await fetch(url).then(async (r) => ({ status: r.status, bytes: (await r.arrayBuffer()).byteLength }))
    const bare = url.split('?')[0]
    const noToken = await fetch(bare).then((r) => r.status)
    const badToken = await fetch(bare + '?t=' + 'f'.repeat(48)).then((r) => r.status)
    return { hasToken: /\\?t=[0-9a-f]{48}$/.test(url), withToken, noToken, badToken }
  })()`)
  check('fileUrl carries a 48-hex capability token', media.hasToken)
  check('the editor still reads its media through kadr://', media.withToken.status === 200 && media.withToken.bytes > 100000,
    `status=${media.withToken.status} bytes=${media.withToken.bytes}`)
  check('kadr:// without the token is refused', media.noToken === 403, `status=${media.noToken}`)
  check('kadr:// with a wrong token is refused', media.badToken === 403, `status=${media.badToken}`)

  // decoding must still work end to end: a composited frame with real content
  // proves the media element loaded AND its pixels reached GL untainted
  const frame = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    st().setProject({ ...st().project, width: 640, height: 360, fps: 30, tracks: [], assets: [] }, null)
    st().addTrack('video'); st().addTrack('audio')
    const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
    const id = E.uid(); st().addAsset({ id, ...asset })
    st().insertClipFromAsset(id, null, 0)
    st().setPlayhead(1)
    await new Promise((r) => setTimeout(r, 2500))
    const cv = document.querySelector('canvas')
    const g = document.createElement('canvas')
    g.width = cv.width; g.height = cv.height
    g.getContext('2d').drawImage(cv, 0, 0)
    const d = g.getContext('2d').getImageData(0, 0, g.width, g.height).data
    let max = 0, sum = 0
    for (let i = 0; i < d.length; i += 4) { const v = Math.max(d[i], d[i+1], d[i+2]); if (v > max) max = v; sum += v }
    return { max, mean: Math.round(sum / (d.length / 4)) }
  })()`)
  check('video still decodes and composites (not a black frame)', frame.max > 60 && frame.mean > 10,
    `max=${frame.max} mean=${frame.mean}`)

  // the real threat: a page served by the fragment dev server — another origin,
  // no node access — must not be able to read files through kadr://
  const server = await evalJs(`(async () => {
    const u = await window.kadrEditor.ensureFragmentServer()
    document.getElementById('e2e34frame')?.remove()
    const f = document.createElement('iframe')
    f.id = 'e2e34frame'
    f.style.cssText = 'position:fixed;left:-9999px;width:10px;height:10px'
    f.src = u + '/'
    document.body.appendChild(f)
    await new Promise((res) => { f.onload = res; setTimeout(res, 10000) })
    return u
  })()`, { timeout: 180000 })

  let iframeTarget = null
  for (let i = 0; i < 20 && !iframeTarget; i++) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
    iframeTarget = list.find((t) => t.url.startsWith(server))
    if (!iframeTarget) await new Promise((r) => setTimeout(r, 500))
  }
  check('the fragment page is reachable for the probe', !!iframeTarget, server)
  if (iframeTarget) {
    const fws = new WebSocket(iframeTarget.webSocketDebuggerUrl)
    await new Promise((r, j) => { fws.on('open', r); fws.on('error', j) })
    const fEval = (expression) => new Promise((resolve, reject) => {
      const msgId = ++id
      const onMsg = (raw) => {
        const msg = JSON.parse(raw)
        if (msg.id !== msgId) return
        fws.off('message', onMsg)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result.result.value)
      }
      fws.on('message', onMsg)
      fws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
    const origin = await fEval('location.origin')
    const privileged = await fEval("typeof require + '/' + typeof window.kadr")
    const read = await fEval(`(async () => { try {
      const r = await fetch('kadr://media${CANARY}')
      return r.status + ':' + (await r.text()).trim()
    } catch (e) { return 'THREW:' + String(e) } })()`)
    fws.close()
    check('the probe really runs on the fragment origin without node access',
      origin === server && privileged === 'undefined/undefined', `${origin} ${privileged}`)
    check('a fragment page cannot read files through kadr:// (issue #13)',
      !read.includes('CANARY'), read.slice(0, 60))
  }
  await evalJs(`(() => { document.getElementById('e2e34frame')?.remove(); return 1 })()`)
  }
} finally {
  await fixture.restore()
  try { unlinkSync(CANARY) } catch { /* gone */ }
  ws.close()
}
console.log('e2e34 finished')
