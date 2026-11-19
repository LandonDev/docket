import { randomBytes } from 'node:crypto'
import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { EDITOR_PATHS, FULL_ROUTE, editorPage, editorPageCsp, lookupSocketOf, type FullLookup } from '../../sheets/fullEditor/wire'
import { BASE_HEADERS, refuseUpgrade, sendText, type PublicRoute, type RouteCtx } from './route'

/**
 * `…/w/full/<token>/*`: the owner's full editor, by a per-open token, never a
 * guest (architecture §8.1, §12.1; docs/agents/work-sheets.md, "The full
 * editor"). Main mints the token when the owner presses the switch; this
 * route asks main what it opens and answers 404 for anything else, so a
 * token that ended, or never was, reaches nothing. The page is ours: it
 * loads ONLYOFFICE's api.js with the config main signed. Everything under it
 * goes to the docservice's Unix socket, its editor paths only, with the
 * token's prefix in `X-Forwarded-Host` so the editor's links come back here.
 */

const FOUND_MS = 5000
const MISSING_MS = 1000
const looked = new Map<string, { at: number; found: FullLookup | null }>()

/** What a token opens, from main; cached a few seconds, since an editor loads hundreds of files. */
export async function lookupToken(ctx: RouteCtx, token: string, now = Date.now()): Promise<FullLookup | null> {
  const hit = looked.get(token)
  if (hit && now - hit.at < (hit.found ? FOUND_MS : MISSING_MS)) return hit.found
  const found = await new Promise<FullLookup | null>((resolve) => {
    const req = request({ socketPath: lookupSocketOf(ctx.config().socketPath), path: `/lookup/${token}`, method: 'GET', timeout: 5000 }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? (JSON.parse(Buffer.concat(chunks).toString()) as FullLookup) : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end()
  })
  if (looked.size > 256) looked.clear()
  looked.set(token, { at: now, found })
  return found
}

/** The request's headers as the docservice should see them: our token's prefix as its host, nothing of the caller's credentials. */
export function forwardedHeaders(headers: IncomingHttpHeaders, token: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || k === 'cookie' || k === 'authorization' || k.startsWith('x-forwarded-') || k.startsWith('cf-')) continue
    out[k] = v
  }
  const proto = headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  out['x-forwarded-host'] = `${headers.host ?? 'localhost'}/w/full/${token}`
  out['x-forwarded-proto'] = proto
  return out
}

/** What answers from the docservice carry here: framed only by this origin (the editor's own frames), no referrer, nothing sniffed. */
const PROXIED_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
}

function pathAndQuery(req: IncomingMessage, rest: string): string {
  const q = (req.url ?? '').indexOf('?')
  return q < 0 ? rest : rest + (req.url ?? '').slice(q)
}

export const fullEditorRoute: PublicRoute = {
  name: 'the full editor',
  milestone: 40,
  match: FULL_ROUTE,

  async http(req, res, ctx, m) {
    const token = m[1]!
    const rest = m[2] ?? '/'
    const found = await lookupToken(ctx, token)
    if (!found) return sendText(res, 404, 'not found')
    if (rest === '/') {
      if (req.method !== 'GET') return sendText(res, 405, 'GET only')
      const nonce = randomBytes(16).toString('base64')
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': editorPageCsp(nonce) })
      res.end(editorPage({ token, nonce, title: found.title, config: found.config }))
      return
    }
    if (!EDITOR_PATHS.test(rest)) return sendText(res, 404, 'not found')
    await new Promise<void>((resolve) => {
      const up = request({ socketPath: found.socket, path: pathAndQuery(req, rest), method: req.method, headers: forwardedHeaders(req.headers, token) }, (answer) => {
        const headers = { ...answer.headers }
        delete headers['x-frame-options']
        res.writeHead(answer.statusCode ?? 502, { ...headers, ...PROXIED_HEADERS })
        answer.pipe(res)
        answer.on('end', resolve)
        answer.on('error', () => resolve())
      })
      up.on('error', (err) => {
        ctx.log(`/w/full: ${err.message}`)
        if (!res.headersSent) sendText(res, 502, 'the full editor is not answering')
        else res.destroy()
        resolve()
      })
      res.on('close', () => up.destroy())
      req.pipe(up)
    })
  },

  upgrade(req, socket, head, ctx, m) {
    const token = m[1]!
    const rest = m[2] ?? '/'
    void lookupToken(ctx, token).then((found) => {
      if (!found || !EDITOR_PATHS.test(rest)) return refuseUpgrade(socket, 404, 'not found')
      const up = connect(found.socket)
      up.on('error', () => socket.destroy())
      socket.on('error', () => up.destroy())
      up.once('connect', () => {
        const lines = [`${req.method ?? 'GET'} ${pathAndQuery(req, rest)} HTTP/1.1`]
        for (const [k, v] of Object.entries(forwardedHeaders(req.headers, token))) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`)
        up.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head.length) up.write(head)
        up.pipe(socket)
        socket.pipe(up)
      })
    })
  }
}
