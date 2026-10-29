// A path in argv proves neither ownership nor that its editor is dead. Keep a
// small ownership record instead of sweeping all matching ffmpeg/MCP processes.
import { promises as fs } from 'fs'
import { join } from 'path'

const KIND = 'kadr-agent-session-v1'
interface ProcessState { group: number; started: string }
interface SessionRecord {
  kind: typeof KIND
  ownerPid: number
  ownerStarted: string
  childPid: number
  childStarted: string
}

async function processState(pid: number): Promise<ProcessState | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    // comm can contain spaces/parentheses; fields after the final ')' begin
    // at state (field 3). starttime is field 22, and disambiguates PID reuse.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const group = Number(fields[2])
    const started = fields[19]
    if (!Number.isInteger(group) || !/^\d+$/.test(started)) throw new Error('Invalid /proc stat')
    return { group, started }
  } catch (err) {
    if (['ENOENT', 'ESRCH'].includes((err as NodeJS.ErrnoException).code || '')) return null
    throw err // unreadable is not evidence that a process is dead
  }
}

export async function rememberSession(directory: string, childPid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null // POSIX watchdog handles macOS
  const owner = await processState(process.pid)
  const child = await processState(childPid)
  if (!owner || !child || child.group !== childPid) return null
  const record: SessionRecord = {
    kind: KIND, ownerPid: process.pid, ownerStarted: owner.started,
    childPid, childStarted: child.started
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${childPid}-${child.started}.json`)
  await fs.writeFile(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
  return path
}

export async function forgetSession(path: string | null): Promise<void> {
  if (path) await fs.unlink(path).catch(() => undefined)
}

export async function sweepOwnedSessions(directory: string): Promise<number> {
  if (process.platform !== 'linux') return 0
  let killed = 0
  const files = await fs.readdir(directory).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  for (const file of files) {
    if (!/^\d+-\d+\.json$/.test(file)) continue
    const path = join(directory, file)
    try {
      if (!(await fs.lstat(path)).isFile()) continue
      const record = JSON.parse(await fs.readFile(path, 'utf8')) as SessionRecord
      if (record.kind !== KIND || !Number.isInteger(record.ownerPid) || record.ownerPid <= 1 ||
        !Number.isInteger(record.childPid) || record.childPid <= 1 ||
        !/^\d+$/.test(record.ownerStarted) || !/^\d+$/.test(record.childStarted) ||
        file !== `${record.childPid}-${record.childStarted}.json`) continue
      const owner = await processState(record.ownerPid)
      if (owner?.started === record.ownerStarted) continue // another LIVE editor
      const child = await processState(record.childPid)
      if (child?.started === record.childStarted && child.group === record.childPid) {
        process.kill(-record.childPid, 'SIGKILL')
        killed++
      }
      // Gone or PID reused: never signal the new owner of the number.
      await forgetSession(path)
    } catch { /* cannot prove ownership/death; preserve the process and record */ }
  }
  return killed
}
