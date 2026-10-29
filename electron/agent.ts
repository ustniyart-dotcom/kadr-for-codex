// Embedded Codex CLI, connected to the live editor via an authenticated local
// MCP bridge. The model/authentication/settings remain the user's own Codex.
import { app, BrowserWindow, ipcMain } from 'electron'
import type { Server } from 'http'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { isAbsolute, join } from 'path'
import type { IPty } from 'node-pty'
import { codexArguments, parseAgentConfig, resolveExecutable, sessionEnvironment, terminalSize } from './agentConfig'
import { closeBridge, startBridge } from './agentBridge'
import { syncAgentSkills } from './agentSkills'
import { rememberSession, forgetSession, sweepOwnedSessions } from './agentSessions'

interface Session {
  pty: IPty
  server: Server
  port: number
  recordPath: Promise<string | null>
}

let session: Session | null = null
let sessionGen = 0
let sessionChain: Promise<unknown> = Promise.resolve()
let shuttingDown = false

const sessionDirectory = () => join(app.getPath('userData'), 'agent-sessions')

export async function sweepStaleSessions(): Promise<number> {
  return sweepOwnedSessions(sessionDirectory())
}

/** JS evaluated in the page (async function body) → JSON result. */
async function evalInPage(win: BrowserWindow, code: string, contextKey: string): Promise<string> {
  const wrapped = `(async () => {
    try {
      if (window.kadrEditor.agentContextKey() !== ${JSON.stringify(contextKey)}) {
        throw new Error('Kadr project changed; use the new session before editing.')
      }
      const r = await (async () => { ${code}\n })()
      return JSON.stringify({ ok: r === undefined ? null : r })
    } catch (e) {
      return JSON.stringify({ error: String((e && (e.stack || e.message)) || e) })
    }
  })()`
  return win.webContents.executeJavaScript(wrapped, true)
}

async function userConfig() {
  const path = join(app.getPath('userData'), 'codex-env.json')
  try { return parseAgentConfig(JSON.parse(await fs.readFile(path, 'utf8'))) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function spawnSession(
  win: BrowserWindow,
  cols: number,
  rows: number,
  cwd: string | null
): Promise<{ ok: boolean; port?: number; error?: string }> {
  killSession()
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined
  try {
    const cfg = await userConfig()
    const env = sessionEnvironment(process.env, cfg.env)
    const command = env.KADR_CODEX_CMD || cfg.command || 'codex'
    // An unsaved project gets a small scratch workspace, not all of HOME as
    // the implicit writable workspace. A stale saved-project path is an error.
    const dir = cwd || join(app.getPath('userData'), 'agent-workspace')
    if (!cwd) await fs.mkdir(dir, { recursive: true })
    if (!isAbsolute(dir) || !(await fs.stat(dir)).isDirectory()) {
      throw new Error(`Codex workspace is not an absolute directory: ${dir}`)
    }
    const bin = await resolveExecutable(command, env, dir, app.getPath('home'))
    if (!bin) {
      throw new Error(`Codex executable not found: ${command}. Install Codex CLI and sign in with codex login, or set command in codex-env.json to its absolute path.`)
    }
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
      throw new Error('Use a native Codex executable, or set command to node.exe and args to the Codex JavaScript entry point; shell .cmd/.bat wrappers are not executed.')
    }
    const contextKey: unknown = await win.webContents.executeJavaScript('window.kadrEditor.agentContextKey()')
    if (typeof contextKey !== 'string') throw new Error('Kadr project context is not ready')
    bridge = await startBridge((code) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('Kadr editor window closed')
      return evalInPage(win, code, contextKey)
    })
    env.KADR_BRIDGE_TOKEN = bridge.token
    const args = codexArguments({
      // Electron can run its bundled Node without relying on a GUI app PATH.
      bridgeCommand: process.execPath,
      bridgePath: join(app.getAppPath(), 'electron', 'mcp-bridge.cjs'),
      port: bridge.port,
      extraArgs: cfg.args,
      timeoutMs: env.KADR_BRIDGE_TIMEOUT_MS
    })
    // Native import is lazy: a broken/rebuilt node-pty must not break editing.
    const pty = await import('node-pty')
    const wrapper =
      `(trap '' HUP; while kill -0 ${process.pid} 2>/dev/null; do sleep 3; done; ` +
      `kill -HUP -$$ 2>/dev/null; sleep 2; kill -9 -$$ 2>/dev/null) & exec "$0" "$@"`
    const p = process.platform === 'win32'
      ? pty.spawn(bin, args, { name: 'xterm-256color', ...terminalSize(cols, rows), cwd: dir, env })
      : pty.spawn('/bin/sh', ['-c', wrapper, bin, ...args], {
        name: 'xterm-256color', ...terminalSize(cols, rows), cwd: dir, env
      })
    const mine: Session = { pty: p, server: bridge.server, port: bridge.port,
      recordPath: rememberSession(sessionDirectory(), p.pid).catch((err) => {
        console.warn('[agent] could not record session ownership:', err)
        return null
      }) }
    session = mine
    p.onData((data) => {
      if (session === mine && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('claude:data', data) // stable IPC name for existing clients
      }
    })
    p.onExit(({ exitCode }) => {
      if (session !== mine) return
      killSession() // also terminate descendants/the POSIX watchdog on natural exit
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('claude:exit', exitCode)
    })
    return { ok: true, port: bridge.port }
  } catch (err) {
    if (bridge) closeBridge(bridge.server)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function killSession() {
  if (!session) return
  const current = session
  session = null
  const pid = current.pty.pid
  if (process.platform === 'win32') {
    // No negative POSIX process-group IDs on Windows. Only this PTY's tree.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {
      void current.recordPath.then(forgetSession)
    })
    try { current.pty.kill() } catch { /* already gone */ }
  } else {
    try { process.kill(-pid, 'SIGHUP') } catch { try { current.pty.kill() } catch { /* gone */ } }
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
      // Keep ownership until escalation. If Electron dies before this timer,
      // the next launch can still reap a child that ignored SIGHUP.
      void current.recordPath.then(forgetSession)
    }, 1500).unref()
  }
  closeBridge(current.server)
}

// Generation + serialization preserve the upstream StrictMode/fast-close fix:
// a superseded open cannot leave an inaccessible PTY or mix terminal output.
function openSession(win: BrowserWindow, cols: number, rows: number, cwd: string | null) {
  const gen = ++sessionGen
  const job = sessionChain.then(() => gen === sessionGen && !shuttingDown
    ? spawnSession(win, cols, rows, cwd)
    : { ok: false, error: 'superseded' })
  sessionChain = job.catch(() => undefined)
  return job
}

function closeSession(): Promise<void> {
  sessionGen++
  const job = sessionChain.then(killSession)
  sessionChain = job.catch(() => undefined)
  return job
}

async function syncSkills() {
  try {
    const root = process.env.KADR_AGENT_SKILLS_DIR || join(app.getPath('home'), '.agents', 'skills')
    if (!isAbsolute(root)) throw new Error('KADR_AGENT_SKILLS_DIR must be an absolute directory')
    const warnings = await syncAgentSkills(
      join(app.getAppPath(), 'electron', 'skills'),
      root
    )
    for (const warning of warnings) console.warn(`[agent] ${warning}`)
  } catch (err) {
    console.warn('[agent] skill sync failed:', err)
  }
}

export function registerAgentIpc(getWin: () => BrowserWindow | null) {
  // Finish both operations before any open request. The old fire-and-forget
  // sweep could kill the newly opened session; discovery could miss new skills.
  sessionChain = sweepStaleSessions().then(syncSkills).catch((err) => {
    console.warn('[agent] startup preparation failed:', err)
  })
  // IPC names remain compatible with existing editor automation. The provider
  // is now Codex; no Claude configuration or credential files are consulted.
  ipcMain.handle('claude:open', (event, cols: number, rows: number, cwd: string | null) => {
    const win = getWin()
    if (!win || event.sender !== win.webContents) return { ok: false, error: 'no editor window' }
    if (cwd !== null && typeof cwd !== 'string') return { ok: false, error: 'invalid workspace' }
    return openSession(win, cols, rows, cwd)
  })
  ipcMain.on('claude:input', (event, data: string) => {
    if (event.sender !== getWin()?.webContents || typeof data !== 'string') return
    try { session?.pty.write(data) } catch { /* session closed between input events */ }
  })
  ipcMain.on('claude:resize', (event, cols: number, rows: number) => {
    if (event.sender !== getWin()?.webContents) return
    const size = terminalSize(cols, rows)
    try { session?.pty.resize(size.cols, size.rows) } catch { /* dying */ }
  })
  ipcMain.handle('claude:close', (event) => {
    if (event.sender !== getWin()?.webContents) return
    return closeSession()
  })
  app.on('before-quit', () => {
    shuttingDown = true
    killSession()
    void closeSession()
  })
}
