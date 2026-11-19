import { ConvexClient, ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import type { LifeosClient } from './ctx'

/**
 * How the host reaches LifeOS's Convex backend. Two ways in: an open call
 * with no identity (`auth:token`, `auth:pairStart`, `auth:pairClaim`), over
 * HTTP; and the owner's live connection, the Convex client over its
 * WebSocket, authenticated by a JWT the session trades for when the client
 * asks (`fetchToken`), refreshed before it ends. Functions are named as
 * Convex names them, `module:function`. Tests pass a fake of this interface.
 */
export interface LifeosTransport {
  open<T>(fn: string, args: Record<string, unknown>): Promise<T>
  /** `onAuthLost`: the client is left with no identity (a refresh gave it none), which Convex never retries by itself. */
  connect(fetchToken: (force: boolean) => Promise<string | null>, onAuthLost: () => void): OwnerConnection
}

export interface OwnerConnection extends LifeosClient {
  /** A live query: `on` with each new value, `onError` when it fails. */
  watch<T>(fn: string, args: Record<string, unknown>, on: (value: T) => void, onError: (err: Error) => void): () => void
  /** Whether the socket is up now. */
  live(): boolean
  close(): void
}

/** How a call to LifeOS failed, for the state a screen draws. */
export type LifeosFault = 'refused' | 'unreachable' | 'error'

/** A LifeOS function's own refusal carries `data.code` (ConvexError); a socket or a 5xx is unreachable. */
export function faultOf(err: unknown): LifeosFault {
  const data = (err as { data?: unknown } | null)?.data
  const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined
  if (code === 'invalid-token') return 'refused'
  if (code !== undefined || typeof data === 'string') return 'error'
  const message = err instanceof Error ? `${err.name} ${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err)
  if (/TypeError|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|TimeoutError|aborted|socket|network|502|503|504|Bad Gateway|Service Unavailable/i.test(message)) return 'unreachable'
  return 'error'
}

/** Words for a fault that never carry a secret: the error's first line, redacted. */
export const faultWords = (err: unknown): string => redact((err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 240))

/** Anything that looks like a LifeOS device token (`lo_`), a key (`lob_`), a pairing poll secret (`lop_`) or a JWT, blanked. Every line this pillar logs goes through it. */
export const redact = (line: string): string =>
  line.replace(/\blo[bp]?_[A-Za-z0-9_-]{8,}/g, '[secret]').replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]')

const TIMEOUT_MS = 15_000
// redirect 'error': a body that carries the device token never follows a redirect to another address.
const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) })

/** Convex's own console lines are dropped but errors, which go to `log` redacted. */
const loggerOf = (log: (line: string) => void) => ({
  log: () => {},
  logVerbose: () => {},
  warn: (...args: unknown[]) => log(redact(`convex: ${args.map(String).join(' ')}`)),
  error: (...args: unknown[]) => log(redact(`convex: ${args.map(String).join(' ')}`))
})

const ref = (kind: 'query' | 'mutation' | 'action', fn: string) => makeFunctionReference<typeof kind>(fn) as never

/** The real transport: LifeOS's Convex deployment at `url`. */
export function convexTransport(url: string, log: (line: string) => void): LifeosTransport {
  const http = new ConvexHttpClient(url, { logger: false, fetch: timedFetch, skipConvexDeploymentUrlCheck: true })
  return {
    open: (fn, args) => http.action(ref('action', fn), args as never) as Promise<never>,
    connect(fetchToken, onAuthLost) {
      const client = new ConvexClient(url, { logger: loggerOf(log), skipConvexDeploymentUrlCheck: true, unsavedChangesWarning: false })
      client.setAuth(
        ({ forceRefreshToken }) => fetchToken(forceRefreshToken).then((t) => t ?? undefined),
        (authenticated) => !authenticated && onAuthLost()
      )
      return {
        query: (fn, args = {}) => client.query(ref('query', fn), args as never) as Promise<never>,
        mutation: (fn, args = {}) => client.mutation(ref('mutation', fn), args as never) as Promise<never>,
        action: (fn, args = {}) => client.action(ref('action', fn), args as never) as Promise<never>,
        watch: (fn, args, on, onError) => client.onUpdate(ref('query', fn), args as never, (v: unknown) => on(v as never), onError),
        live: () => client.connectionState().isWebSocketConnected,
        close: () => void client.close().catch(() => {})
      }
    }
  }
}
