// Provider-specific launch configuration, kept independent of Electron so it
// can be checked without a display, a signed-in account, or model requests.
import { constants, promises as fs } from 'fs'
import { delimiter, isAbsolute, join, resolve } from 'path'

export interface AgentConfig {
  command?: string
  /** Extra Codex CLI arguments; the Kadr MCP connection is always appended. */
  args?: string[]
  env?: Record<string, string>
}

export function parseAgentConfig(value: unknown): AgentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('codex-env.json must contain an object')
  }
  const cfg = value as Record<string, unknown>
  const string = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0')
  if (cfg.command !== undefined && (!string(cfg.command) || !cfg.command.trim())) {
    throw new Error('codex-env.json: command must be a non-empty executable path/name')
  }
  if (cfg.args !== undefined && (!Array.isArray(cfg.args) || !cfg.args.every(string))) {
    throw new Error('codex-env.json: args must be an array of strings')
  }
  if (cfg.env !== undefined && (!cfg.env || typeof cfg.env !== 'object' || Array.isArray(cfg.env) ||
    !Object.entries(cfg.env).every(([key, val]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && string(val)))) {
    throw new Error('codex-env.json: env must map environment variable names to strings')
  }
  return { command: cfg.command as string | undefined, args: cfg.args as string[] | undefined,
    env: cfg.env as Record<string, string> | undefined }
}

/** Do not replace CODEX_HOME, credentials, model choices, or approval policy. */
export function sessionEnvironment(
  inherited: NodeJS.ProcessEnv,
  extra: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) if (value !== undefined) env[key] = value
  // These describe the parent conversation, not the independent UI session.
  // Config variables (including CLAUDE_CONFIG_DIR) are deliberately retained.
  for (const key of [
    'CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_BRIDGE_SESSION',
    'CLAUDE_PID', 'CLAUDE_EFFORT'
  ]) delete env[key]
  return { ...env, ...extra }
}

/** Resolve one executable, never interpolate user configuration into a shell. */
export async function resolveExecutable(
  command: string,
  env: Record<string, string>,
  cwd: string,
  home: string,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  if (!command || command.includes('\0')) return null
  const direct = isAbsolute(command) || /[/\\]/.test(command)
  const paths = direct ? [resolve(cwd, command)] : [
    ...(env.PATH || env.Path || '').split(delimiter).filter(Boolean).map((p) => resolve(cwd, p, command)),
    // Finder-launched macOS apps often do not inherit the login shell PATH.
    ...(platform === 'darwin' ? [
      join(home, '.local', 'bin', command), join(home, '.npm-global', 'bin', command),
      join('/opt/homebrew/bin', command), join('/usr/local/bin', command)
    ] : [])
  ]
  for (const candidate of new Set(paths)) {
    const candidates = platform === 'win32' && !/\.[^/\\]+$/.test(candidate)
      ? ['.exe', '.com'].map((ext) => candidate + ext) : [candidate]
    for (const path of candidates) {
      try {
        if (!(await fs.stat(path)).isFile()) continue
        await fs.access(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
        return path
      } catch { /* try the next PATH entry */ }
    }
  }
  return null
}

/** JSON string escaping is also valid for TOML basic strings. No shell involved. */
const tomlString = (value: string) => JSON.stringify(value)

export function codexArguments(options: {
  bridgeCommand: string
  bridgePath: string
  port: number
  extraArgs?: string[]
  timeoutMs?: string
}): string[] {
  const { bridgeCommand, bridgePath, port, extraArgs = [] } = options
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid bridge port')
  const timeoutMs = options.timeoutMs === undefined ? 3_600_000 : Number(options.timeoutMs)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
    throw new Error('KADR_BRIDGE_TIMEOUT_MS must be an integer from 1 to 86400000')
  }
  // Replace only this named server's table: a pre-existing URL/config for
  // "kadr" must not be combined with a new stdio transport. Other servers and
  // all normal user settings remain in Codex's own configuration stack.
  const mcp = '{ ' + [
    `command = ${tomlString(bridgeCommand)}`,
    `args = [${[bridgePath, String(port)].map(tomlString).join(', ')}]`,
    'env = { ELECTRON_RUN_AS_NODE = "1" }',
    'env_vars = ["KADR_BRIDGE_TOKEN", "KADR_BRIDGE_TIMEOUT_MS"]',
    'enabled = true',
    'startup_timeout_sec = 30',
    // Leave enough time for the bridge to return its outcome-unknown error.
    `tool_timeout_sec = ${Math.ceil(timeoutMs / 1000) + 15}`
  ].join(', ') + ' }'
  // --no-daemon keeps the ephemeral token and child lifetime scoped to this
  // terminal. MCP initialization instructions provide context without
  // replacing developer_instructions or starting a paid model turn.
  return [...extraArgs, '--no-daemon', '-c', `mcp_servers.kadr=${mcp}`]
}

export function terminalSize(cols: number, rows: number): { cols: number; rows: number } {
  const bounded = (n: number, min: number, fallback: number) => Number.isFinite(n)
    ? Math.max(min, Math.min(5000, Math.floor(n))) : fallback
  return { cols: bounded(cols, 20, 80), rows: bounded(rows, 5, 24) }
}
