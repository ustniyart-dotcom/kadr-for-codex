// Autosave policy/lifecycle without Electron: run the actual module with a
// controlled store and IPC boundary. No user projects or settings are touched.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let state = { project: { tracks: [{ clips: [{}] }] }, projectPath: '/edits/first.kadr' }
const writes = [], warnings = []
let block = null
let fail = false
const oldWindow = globalThis.window
globalThis.__kadrAutosaveStore = { getState: () => state }
globalThis.__kadrAutosaveWarn = (...args) => warnings.push(args)
globalThis.window = { kadr: { autosaveProject: async (project, path) => {
  writes.push({ project, path })
  if (block) await block
  if (fail) throw new Error('synthetic disk full')
  return `${path}.autosave`
} } }
let checks = 0
const pass = (name) => { checks++; console.log(`PASS  ${name}`) }
try {
  // Only imports at the state/IPC boundary are substituted. The policy is
  // compiled from the production file, not reimplemented in this check.
  const src = readFileSync(join(root, 'src/engine/autosave.ts'), 'utf8')
    .replace("import { useEditor } from '@/state/store'", 'const useEditor = globalThis.__kadrAutosaveStore')
    .replace("import { logWarn } from './log'", 'const logWarn = globalThis.__kadrAutosaveWarn')
  const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
  const { activity, autosaveNow } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
  activity.claude = true
  await autosaveNow()
  assert.equal(writes.length, 1)
  pass('an open assistant panel still gets a recovery snapshot')
  await autosaveNow()
  assert.equal(writes.length, 1)
  pass('unchanged project and destination are not rewritten')
  state = { ...state, projectPath: '/edits/save-as.kadr' }
  await autosaveNow()
  assert.equal(writes.length, 2)
  assert.equal(writes.at(-1).path, '/edits/save-as.kadr')
  pass('Save As gets recovery in the new destination without a further edit')

  state = { ...state, project: { tracks: [{ clips: [{ label: 'new' }] }] } }
  activity.exporting = true
  await autosaveNow()
  assert.equal(writes.length, 2)
  activity.exporting = false
  activity.voiceCheck = true
  await autosaveNow()
  assert.equal(writes.length, 2)
  activity.voiceCheck = false
  await autosaveNow()
  assert.equal(writes.length, 3)
  pass('export/voice analysis defer writes and the next tick saves changes')

  state = { ...state, project: { tracks: [{ clips: [{ label: 'slow write' }] }] } }
  let release
  block = new Promise((resolve) => { release = resolve })
  const first = autosaveNow()
  await autosaveNow()
  assert.equal(writes.length, 4)
  state = { ...state, project: { tracks: [{ clips: [{ label: 'edited while saving' }] }] } }
  release()
  await first
  block = null
  await autosaveNow()
  assert.equal(writes.length, 5)
  assert.equal(writes.at(-1).project.tracks[0].clips[0].label, 'edited while saving')
  pass('overlapping ticks cannot race the recovery file; intervening edits remain dirty')

  state = { ...state, project: { tracks: [{ clips: [{ label: 'retry' }] }] } }
  fail = true
  await autosaveNow()
  assert.equal(warnings.length, 1)
  fail = false
  await autosaveNow()
  assert.equal(writes.length, 7)
  pass('a failed save is reported and retried on the next tick')

  state = { project: { tracks: [{ clips: [] }] }, projectPath: null }
  await autosaveNow()
  assert.equal(writes.length, 7)
  pass('an empty new project does not create a recovery file')
  console.log(`\ncheck-autosave: ${checks} passed`)
} finally {
  if (oldWindow === undefined) delete globalThis.window
  else globalThis.window = oldWindow
  delete globalThis.__kadrAutosaveStore
  delete globalThis.__kadrAutosaveWarn
}
