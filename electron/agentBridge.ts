import { createServer, type Server } from 'http'
import { randomBytes } from 'crypto'

export const MAX_BRIDGE_REQUEST_BYTES = 4 * 1024 * 1024

/** Local authenticated capability: deliberately not a remotely exposed API. */
export function startBridge(evaluate: (code: string) => Promise<string>):
  Promise<{ server: Server; port: number; token: string }> {
  const token = randomBytes(24).toString('hex')
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/eval') {
        res.writeHead(404).end()
        return
      }
      // Browser origins, including the fragment iframe, may never use this
      // route. A custom auth header also prevents a simple cross-origin POST.
      if (req.headers.origin !== undefined || req.headers['x-kadr-token'] !== token) {
        res.writeHead(403).end()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      let rejected = false
      req.on('error', () => { rejected = true })
      req.on('data', (chunk: Buffer) => {
        if (rejected) return
        size += chunk.length
        if (size > MAX_BRIDGE_REQUEST_BYTES) {
          rejected = true
          chunks.length = 0
          res.writeHead(413, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: 'Kadr bridge request exceeds 4 MiB' }))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', async () => {
        if (rejected) return
        let code: unknown
        try { code = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.code } catch { /* below */ }
        if (typeof code !== 'string' || !code.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: 'Expected JSON with a non-empty string code' }))
          return
        }
        try {
          const out = await evaluate(code)
          if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'application/json' }).end(out)
        } catch (err) {
          if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: String(err) }))
        }
      })
    })
    server.headersTimeout = 10_000
    server.requestTimeout = 30_000
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve({ server, port: addr.port, token })
      else reject(new Error('bridge listen failed'))
    })
  })
}

export function closeBridge(server: Server): void {
  server.close()
  // Close in-flight authenticated clients too; an obsolete session must not
  // keep its capability alive after the UI was closed or a spawn failed.
  server.closeAllConnections()
}
