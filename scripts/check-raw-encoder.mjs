// Exercise the real encoder wrappers against a real child-process pipe.
// The child copies bytes instead of encoding video, so this check needs
// neither ffmpeg nor Electron/a display. It can also close stdin mid-frame.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'kadr-raw-check-'))
const fixture = join(dir, 'encoder.cjs')
await writeFile(fixture, `
const { createWriteStream } = require('node:fs');
if (process.env.KADR_ENCODER_TEST_MODE === 'exit') {
  process.stdin.once('data', () => process.exit(7));
} else {
  setTimeout(() => process.stdin.pipe(createWriteStream(process.argv.at(-1))), 80);
}
`)

// Replace only the executable at the OS boundary. Everything in ffmpeg.ts
// and preload.ts, including stream handling and lifecycle, runs unchanged.
const children = new Set()
globalThis.__kadrTestChildren = children
async function load(entry) {
  const result = await build({
    entryPoints: [join(root, entry)], bundle: true, write: false,
    platform: 'node', format: 'esm', logLevel: 'silent',
    alias: { '@shared': join(root, 'shared') },
    plugins: [{
      name: 'encoder-test-boundaries',
      setup(b) {
        b.onResolve({ filter: /^child_process$/ }, () => ({ path: 'process', namespace: 'test' }))
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
        b.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({
          contents: path === 'process' ? `
            import * as cp from 'node:child_process';
            export const execFile = cp.execFile;
            export const spawn = (_bin, args, opts) => {
              const missing = process.env.KADR_ENCODER_TEST_MODE === 'missing';
              const child = cp.spawn(missing ? ${JSON.stringify(join(dir, 'missing-encoder'))} : process.execPath,
                missing ? args : [${JSON.stringify(fixture)}, ...args], opts);
              const children = globalThis.__kadrTestChildren;
              children.add(child);
              child.once('close', () => children.delete(child));
              return child;
            };
          ` : `
            export const contextBridge = { exposeInMainWorld(name, api) { globalThis[name] = api; } };
            export const ipcRenderer = { sendSync() { return 'test-token'; } };
            export const webUtils = {};
          `,
          loader: 'js'
        }))
      }
    }]
  })
  const out = join(dir, entry.replace(/[\\/]/g, '-') + '.mjs')
  await writeFile(out, result.outputFiles[0].text)
  return import(pathToFileURL(out).href)
}

const opts = { width: 16, height: 16, fps: 30, codec: 'libx264', bitrate: 1_000_000 }
const withTimeout = (promise) => {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('encoder operation hung')), 5000) })
  ]).finally(() => clearTimeout(timer))
}
let checks = 0
const pass = (name) => { checks++; console.log(`PASS  ${name}`) }
const extraFiles = []
const oldMode = process.env.KADR_ENCODER_TEST_MODE
const oldApi = globalThis.kadr
try {
  const { RawVideoEncoder } = await load('electron/ffmpeg.ts')
  await load('electron/preload.ts')
  const direct = globalThis.kadr
  const wrappers = [
    ['main fallback', () => {
      const encoder = new RawVideoEncoder()
      return {
        start: async () => { const out = join(dir, `main-${checks}.mp4`); encoder.start({ ...opts, out }); return out },
        write: (data) => encoder.write(data),
        finish: () => encoder.finish(),
        kill: () => encoder.kill()
      }
    }],
    ['direct preload', () => ({
      start: async () => { const out = await direct.rawEncodeStart(opts); extraFiles.push(out); return out },
      write: (data) => direct.rawEncodeFrame(data),
      finish: () => direct.rawEncodeEnd(),
      kill: () => direct.rawEncodeKill()
    })]
  ]
  for (const [name, make] of wrappers) {
    process.env.KADR_ENCODER_TEST_MODE = 'copy'
    const normal = make()
    try {
      const out = await withTimeout(normal.start())
      const frame = Buffer.alloc(2 * 1024 * 1024, 123)
      await withTimeout(normal.write(frame))
      frame.fill(0) // the resolved write must have released the buffer
      await withTimeout(normal.finish())
      assert.deepEqual(await readFile(out), Buffer.alloc(frame.length, 123))
      pass(`${name}: writes preserve bytes before buffer reuse`)
    } finally { normal.kill() }

    process.env.KADR_ENCODER_TEST_MODE = 'exit'
    const failed = make()
    try {
      await withTimeout(failed.start())
      await assert.rejects(withTimeout(failed.write(Buffer.alloc(16 * 1024 * 1024))), /EPIPE|closed|destroyed|gone|ECONNRESET/)
      await assert.rejects(withTimeout(failed.finish()), /exited 7/)
      pass(`${name}: closed pipe rejects pending frame and finish without a hang/crash`)
    } finally { failed.kill() }

    process.env.KADR_ENCODER_TEST_MODE = 'copy'
    const cancelled = make()
    try {
      await withTimeout(cancelled.start())
      const pending = cancelled.write(Buffer.alloc(16 * 1024 * 1024))
      const rejected = assert.rejects(withTimeout(pending), /EPIPE|closed|destroyed|gone|ECONNRESET/)
      cancelled.kill()
      await rejected
      pass(`${name}: cancellation rejects a frame under backpressure`)
    } finally { cancelled.kill() }
  }

  // A killed process can report `close` after the next export has started.
  // Its handler must not clear the new encoder's shared preload reference.
  process.env.KADR_ENCODER_TEST_MODE = 'copy'
  const firstOut = await withTimeout(direct.rawEncodeStart(opts))
  extraFiles.push(firstOut)
  const oldChild = [...children].at(-1)
  const oldClosed = new Promise((resolve) => oldChild.once('close', resolve))
  direct.rawEncodeKill()
  const nextStart = direct.rawEncodeStart(opts)
  const [nextOut] = await withTimeout(Promise.all([nextStart, oldClosed]))
  extraFiles.push(nextOut)
  await withTimeout(direct.rawEncodeFrame(Buffer.alloc(1024, 37)))
  await withTimeout(direct.rawEncodeEnd())
  assert.deepEqual(await readFile(nextOut), Buffer.alloc(1024, 37))
  pass('direct preload: a late close from a cancelled export cannot clear its replacement')

  process.env.KADR_ENCODER_TEST_MODE = 'missing'
  await assert.rejects(withTimeout(direct.rawEncodeStart(opts)), /ENOENT/)
  // Both promises observe the same launch failure; neither waits for frames.
  await assert.rejects(withTimeout(direct.rawEncodeEnd()), /ENOENT|exited/)
  pass('direct preload: missing executable settles start and finish')
  console.log(`\ncheck-raw-encoder: ${checks} passed`)
} finally {
  for (const child of children) child.kill('SIGKILL')
  if (oldMode === undefined) delete process.env.KADR_ENCODER_TEST_MODE
  else process.env.KADR_ENCODER_TEST_MODE = oldMode
  if (oldApi === undefined) delete globalThis.kadr
  else globalThis.kadr = oldApi
  delete globalThis.__kadrTestChildren
  await Promise.all(extraFiles.map((p) => rm(p, { force: true })))
  await rm(dir, { recursive: true, force: true })
}
