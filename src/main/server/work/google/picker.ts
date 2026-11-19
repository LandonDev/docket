import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DatabaseSync } from 'node:sqlite'
import { DRIVE_FILE } from './client'
import { GOOGLE_KINDS, type GoogleKind } from '@shared/contract-work-google'

/**
 * Google's desktop Picker (docs/agents/work-google.md "Picking a file"):
 * opened in the system browser with LifeOS's Google client id and
 * `trigger_onepick=true`, as the owner's account. Google sends the browser
 * back to a loopback listener of ours with the ids he picked. A picked file
 * is then reachable with any `drive.file` token of that client, so the
 * tokens LifeOS's worker mints read it. The code Google sends along is never
 * exchanged: no refresh token comes to TempCode.
 */

export const PICK_TIMEOUT_MS = 5 * 60_000
export const CLIENT_ID_SETTING = 'work.google.clientId'

const MIMES: Record<GoogleKind, string> = {
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation'
}

/** LifeOS's Google client id as this host knows it (`work.google.setup`, or the environment), or null. */
export function clientIdOf(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CLIENT_ID_SETTING) as { value?: string } | undefined
    if (row?.value) return row.value
  } catch {
    // No settings table (a test's database).
  }
  return env.TEMP_CODE_GOOGLE_CLIENT_ID || null
}

export function setClientId(db: DatabaseSync, clientId: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(CLIENT_ID_SETTING, clientId)
}

/** The Picker's address. */
export function pickerUrl(o: { clientId: string; account: string; redirect: string; state: string; challenge: string; kinds?: readonly GoogleKind[] }): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  const kinds = o.kinds?.length ? o.kinds : GOOGLE_KINDS
  for (const [k, v] of Object.entries({
    client_id: o.clientId,
    redirect_uri: o.redirect,
    response_type: 'code',
    scope: DRIVE_FILE,
    prompt: 'consent',
    trigger_onepick: 'true',
    allow_multiple: 'true',
    mimetypes: kinds.map((k) => MIMES[k]).join(','),
    login_hint: o.account,
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: 'S256'
  }))
    u.searchParams.set(k, v)
  return u.toString()
}

const page = (line: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TempCode</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:13px/1.5 system-ui,sans-serif;color-scheme:light dark}p{margin:0;width:min(320px,calc(100vw - 48px))}</style></head><body><p>${line}</p></body></html>`

/**
 * Shows the Picker and answers the ids he picked: [] when he closed it. `open` shows a URL in the
 * system browser. Rejects on abort and after five minutes.
 */
export async function pick(o: { clientId: string; account: string; kinds?: readonly GoogleKind[]; open(url: string): Promise<void>; signal?: AbortSignal }): Promise<string[]> {
  const state = randomBytes(16).toString('base64url')
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url')
  let done: (ids: string[]) => void = () => {}
  let failed: (err: Error) => void = () => {}
  const answered = new Promise<string[]>((resolve, reject) => {
    done = resolve
    failed = reject
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET' || url.pathname !== '/picked') {
      res.writeHead(404).end()
      return
    }
    // Only Google's answer to this Picker, carrying its state; any other is ignored and the wait goes on.
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('This page is not for this Picker. Go back to TempCode.'))
      return
    }
    const ids = (url.searchParams.getAll('picked_file_ids').join(',') || '').split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{1,200}$/.test(s))
    const error = url.searchParams.get('error')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page(error ? 'Nothing was picked. You can close this tab.' : 'Picked. You can close this tab and go back to TempCode.'))
    done(error ? [] : ids)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const timer = setTimeout(() => failed(new Error('The Picker was left open for five minutes. Pick again.')), PICK_TIMEOUT_MS)
  const onAbort = () => failed(new Error('Picking was stopped.'))
  o.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await o.open(pickerUrl({ clientId: o.clientId, account: o.account, redirect: `http://127.0.0.1:${port}/picked`, state, challenge, kinds: o.kinds }))
    return await answered
  } finally {
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
    server.close()
    server.closeAllConnections?.()
  }
}
