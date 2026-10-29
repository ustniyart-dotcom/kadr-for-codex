import { promises as fs } from 'fs'
import { join } from 'path'

const SKILL_MARK = '<!-- managed by Kadr'

async function lstatOptional(path: string) {
  try { return await fs.lstat(path) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err // failure to read does not make an existing skill ours to overwrite
  }
}

/** Sync only Kadr-owned SKILL.md files; user folders, symlinks and additions survive. */
export async function syncAgentSkills(srcDir: string, root: string): Promise<string[]> {
  const warnings: string[] = []
  const shipped = new Set<string>()
  await fs.mkdir(root, { recursive: true })
  for (const file of (await fs.readdir(srcDir)).filter((f) => f.endsWith('.md')).sort()) {
    const src = await fs.readFile(join(srcDir, file), 'utf8')
    const frontMatter = src.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
    const name = frontMatter?.match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1]
    if (!name || !name.startsWith('kadr-') || !src.includes(SKILL_MARK)) {
      warnings.push(`${file}: missing Kadr skill metadata; skipped`)
      continue
    }
    shipped.add(name)
    const dir = join(root, name)
    const dst = join(dir, 'SKILL.md')
    const dirInfo = await lstatOptional(dir)
    if (dirInfo && (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())) {
      warnings.push(`${name}: user-owned link/path preserved`)
      continue
    }
    const fileInfo = await lstatOptional(dst)
    if (fileInfo && (!fileInfo.isFile() || fileInfo.isSymbolicLink())) {
      warnings.push(`${name}: user-owned link/path preserved`)
      continue
    }
    const current = fileInfo ? await fs.readFile(dst, 'utf8') : null
    if (current === src) continue
    if (current !== null && !current.includes(SKILL_MARK)) {
      warnings.push(`${name}: user-owned SKILL.md preserved`)
      continue
    }
    await fs.mkdir(dir, { recursive: true })
    const tmp = `${dst}.part-${process.pid}`
    try {
      await fs.writeFile(tmp, src, { mode: 0o600, flag: 'wx' })
      await fs.rename(tmp, dst)
    } finally {
      await fs.rm(tmp, { force: true })
    }
  }
  // Empty or unreadable source must never imply "delete all installed skills".
  if (!shipped.size) return warnings
  for (const dir of await fs.readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.isSymbolicLink() || !dir.name.startsWith('kadr-') || shipped.has(dir.name)) continue
    const path = join(root, dir.name)
    const dst = join(path, 'SKILL.md')
    const info = await lstatOptional(dst)
    if (!info?.isFile() || info.isSymbolicLink()) continue
    if (!(await fs.readFile(dst, 'utf8')).includes(SKILL_MARK)) continue
    await fs.unlink(dst)
    // Remove only an empty directory. Never recursively delete user notes,
    // scripts, references, or other files added alongside the managed skill.
    await fs.rmdir(path).catch(() => undefined)
  }
  return warnings
}
