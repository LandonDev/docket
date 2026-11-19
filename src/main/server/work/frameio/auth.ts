import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { vault } from 'aliax-core'
import { ADDON_SERVICE } from '@shared/addonGrant'
import type { FrameTable, MediaProbe } from '@shared/contract-work-media'

/**
 * The Frame.io sign-in (docs/agents/work-frameio.md, "Sign-in"): Adobe IMS
 * OAuth for an OAuth Native App credential, with PKCE and no client secret.
 * The host makes the verifier, hands the person the sign-in address, and
 * takes the code back on its loopback redirect (a browser on this machine)
 * or from the address he pastes (a browser on another one). The tokens are
 * sealed in this host's vault beside LifeOS's device token, as one bare
 * secret no profile walk sees.
 */

export const TOKENS_NAME = '~frameio-tokens'
export const DEFAULT_REDIRECT = 'http://127.0.0.1:7697/frameio/callback'
/** Frame.io's documented user scopes; `offline_access` brings the refresh token. */
export const SCOPES = ['openid', 'email', 'profile', 'offline_access', 'additional_info.roles']

export interface StoredTokens {
  v: 1
  clientId: string
  redirectUri: string
  access: string
  refresh?: string
  /** epoch ms */
  expiresAt: number
  user?: { id: string; name: string; email?: string }
  /** webhook id → its signing secret, which Frame.io gives only when it is made */
  hooks?: Record<string, string>
}

export interface TokenStore {
  read(): StoredTokens | null
  write(t: StoredTokens): void
  clear(): void
}

export const vaultTokens: TokenStore = {
  read() {
    try {
      const raw = vault.readSecret(ADDON_SERVICE, TOKENS_NAME)
      const t = raw ? (JSON.parse(raw) as StoredTokens) : null
      return t?.v === 1 && typeof t.access === 'string' ? t : null
    } catch {
      return null
    }
  },
  write: (t) => vault.saveSecret(ADDON_SERVICE, TOKENS_NAME, JSON.stringify(t)),
  clear: () => vault.deleteProfile(ADDON_SERVICE, TOKENS_NAME)
}

export function memoryTokens(initial: StoredTokens | null = null): TokenStore {
  let held = initial
  return { read: () => held, write: (t) => void (held = t), clear: () => void (held = null) }
}

/** Where Frame.io and Adobe answer, and how they are reached: a test points them at its fake. */
export interface FrameioConfig {
  api: string
  ims: string
  tokens: TokenStore
  fetch: typeof fetch
  /** reads a downloaded rendition; null: the toolchain's ffprobe */
  probe: ((path: string, signal: AbortSignal) => Promise<{ probe: MediaProbe; table?: FrameTable }>) | null
}
export const frameioConfig: FrameioConfig = { api: 'https://api.frame.io/v4', ims: 'https://ims-na1.adobelogin.com', tokens: vaultTokens, fetch: (input, init) => fetch(input, init), probe: null }

/** Changes the config; returns the way back. */
export function configureFrameio(patch: Partial<FrameioConfig>): () => void {
  const was = { ...frameioConfig }
  Object.assign(frameioConfig, patch)
  return () => void Object.assign(frameioConfig, was)
}

const b64url = (b: Buffer): string => b.toString('base64url')
export const challengeOf = (verifier: string): string => b64url(createHash('sha256').update(verifier).digest())

interface Pending {
  state: string
  verifier: string
  clientId: string
  redirectUri: string
  at: number
  listener: Server | null
}

const PENDING_MS = 10 * 60_000

/** One host's sign-in in flight, and the token it keeps fresh. */
export class FrameioAuth {
  private pending: Pending | null = null
  private refreshing: Promise<string | null> | null = null
  error: string | undefined

  constructor(
    private readonly o: {
      /** the signed-in user, read once the tokens are in */
      me(access: string): Promise<{ id: string; name: string; email?: string }>
      changed(): void
      log(line: string): void
    }
  ) {}

  get isPending(): boolean {
    return !!this.pending && Date.now() - this.pending.at < PENDING_MS
  }

  /** The Adobe sign-in address. A loopback redirect on this machine gets a one-shot listener for the answer. */
  start(clientId: string, redirectUri = DEFAULT_REDIRECT): string {
    this.cancel()
    const p: Pending = { state: b64url(randomBytes(16)), verifier: b64url(randomBytes(48)), clientId, redirectUri, at: Date.now(), listener: null }
    this.pending = p
    this.error = undefined
    const url = new URL('/ims/authorize/v2', frameioConfig.ims)
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.join(','),
      response_type: 'code',
      code_challenge: challengeOf(p.verifier),
      code_challenge_method: 'S256',
      state: p.state
    }).toString()
    p.listener = this.listen(p)
    this.o.changed()
    return url.toString()
  }

  cancel(): void {
    this.pending?.listener?.close()
    this.pending = null
  }

  /** The address the browser ended on: its code, checked against the sign-in's state, becomes the tokens. */
  async finish(address: string): Promise<void> {
    const p = this.pending
    if (!p || Date.now() - p.at > PENDING_MS) throw new Error('No Frame.io sign-in is waiting. Start it again.')
    let q: URLSearchParams
    try {
      q = new URL(address.trim()).searchParams
    } catch {
      throw new Error('That is not the address the sign-in ended on.')
    }
    if (q.get('error')) throw new Error(`Adobe said: ${q.get('error_description') ?? q.get('error')}`)
    const code = q.get('code')
    if (!code || q.get('state') !== p.state) throw new Error('That address is not from this sign-in.')
    this.cancel()
    try {
      const t = await this.token({ grant_type: 'authorization_code', client_id: p.clientId, code, code_verifier: p.verifier, redirect_uri: p.redirectUri })
      const stored: StoredTokens = { v: 1, clientId: p.clientId, redirectUri: p.redirectUri, ...t, hooks: frameioConfig.tokens.read()?.hooks ?? {} }
      stored.user = await this.o.me(stored.access)
      frameioConfig.tokens.write(stored)
      this.error = undefined
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      this.o.changed()
    }
  }

  signOut(): void {
    this.cancel()
    frameioConfig.tokens.clear()
    this.o.changed()
  }

  /** A token good for at least another minute, refreshed when it is not. */
  async access(): Promise<string> {
    const t = frameioConfig.tokens.read()
    if (!t) throw new Error('Frame.io is not signed in on this host.')
    if (t.expiresAt - Date.now() > 60_000) return t.access
    const fresh = await this.refresh()
    if (!fresh) throw new Error('The Frame.io sign-in ran out. Sign in again.')
    return fresh
  }

  /** A new access token from the refresh token, once at a time; null when there is none or Adobe refuses it. */
  refresh(): Promise<string | null> {
    this.refreshing ??= (async () => {
      const t = frameioConfig.tokens.read()
      if (!t?.refresh) return null
      try {
        const fresh = await this.token({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh })
        // What is stored now, not what was read before the wait: a webhook's secret may have been saved meanwhile.
        const now = frameioConfig.tokens.read() ?? t
        frameioConfig.tokens.write({ ...now, ...fresh, refresh: fresh.refresh ?? now.refresh })
        return fresh.access
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err)
        this.o.log(`frameio: refresh failed: ${this.error}`)
        this.o.changed()
        return null
      }
    })().finally(() => (this.refreshing = null))
    return this.refreshing
  }

  private async token(form: Record<string, string>): Promise<{ access: string; refresh?: string; expiresAt: number }> {
    const res = await frameioConfig.fetch(new URL('/ims/token/v3', frameioConfig.ims), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString()
    })
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
    if (!res.ok || !body.access_token) throw new Error(`Adobe refused the sign-in: ${body.error_description ?? body.error ?? res.status}`)
    // Adobe says 24 hours, Frame.io 1; trust what the answer says, and an hour when it says nothing.
    return { access: body.access_token, ...(body.refresh_token ? { refresh: body.refresh_token } : {}), expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
  }

  /** A loopback redirect on this machine: listen for the browser's one request, then close. */
  private listen(p: Pending): Server | null {
    let u: URL
    try {
      u = new URL(p.redirectUri)
    } catch {
      return null
    }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || !u.port) return null
    const server = createServer((req, res) => {
      const at = new URL(req.url ?? '/', p.redirectUri)
      if (at.pathname !== u.pathname) return void res.writeHead(404).end()
      void this.finish(at.toString()).then(
        () => res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Signed in to Frame.io. You can close this tab.'),
        (err) => res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(err instanceof Error ? err.message : String(err))
      )
    })
    server.on('error', (err) => this.o.log(`frameio: the sign-in listener on ${u.host} failed: ${err.message}; paste the address instead`))
    server.listen(Number(u.port), u.hostname === 'localhost' ? '127.0.0.1' : u.hostname)
    server.unref()
    setTimeout(() => server.close(), PENDING_MS).unref()
    return server
  }
}
