// Paths from a project may use either OS's separators. In particular C:\\file
// must not become C: (which means that drive's current directory).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'shared/paths.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const { dirOf, baseOf } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
for (const [path, dir, base] of [
  ['C:\\video.mp4', 'C:\\', 'video.mp4'],
  ['D:/project.kadr', 'D:/', 'project.kadr'],
  ['c:\\', 'c:\\', ''],
  ['C:\\edits\\my project.kadr', 'C:\\edits', 'my project.kadr'],
  ['\\\\server\\share\\project.kadr', '\\\\server\\share', 'project.kadr'],
  ['/project.kadr', '/', 'project.kadr'],
  ['/Users/editor/project.kadr', '/Users/editor', 'project.kadr'],
  ['relative.kadr', '.', 'relative.kadr'],
  ['edits/relative.kadr', 'edits', 'relative.kadr']
]) {
  assert.equal(dirOf(path), dir)
  assert.equal(baseOf(path), base)
  console.log(`PASS  ${path}`)
}
console.log('\ncheck-paths: 9 passed')
