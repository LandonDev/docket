import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import type { PublicRoute } from './route'
import { BASE_HEADERS, sendText } from './route'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

/**
 * A page's own scripts and styles only, from this origin; nothing framed,
 * no form posted elsewhere. A page's meta CSP may only narrow it.
 */
export const HOSTED_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/**
 * `GET …/w/hosted/*`: out/hosted, the pages a browser that is not the app
 * loads (src/hosted, built by electron.vite.config.ts with base /w/hosted/).
 * Files under that folder only; a page is `<name>/` or `<name>/index.html`.
 */
export const hostedRoute: PublicRoute = {
  name: 'the hosted pages',
  milestone: 18,
  match: /^\/w\/hosted(\/.*)?$/,
  async http(req, res, ctx, m) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'read only')
    const root = ctx.config().hostedDir
    let rel: string
    try {
      rel = decodeURIComponent(m[1] ?? '/')
    } catch {
      return sendText(res, 404, 'not found')
    }
    if (rel.includes('\0')) return sendText(res, 404, 'not found')
    if (rel.endsWith('/')) rel += 'index.html'
    const path = normalize(join(root, rel))
    if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) return sendText(res, 404, 'not found')
    try {
      if (!(await stat(path)).isFile()) return sendText(res, 404, 'not found')
      const body = await readFile(path)
      const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Security-Policy': HOSTED_CSP, 'Content-Length': body.length })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch {
      sendText(res, 404, 'not found')
    }
  }
}
