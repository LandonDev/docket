/**
 * A small Chrome DevTools Protocol client over the runtime's own WebSocket:
 * one browser connection, flat sessions for pages (`Target.attachToTarget`
 * with `flatten`), requests by id, events by method and session.
 */

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void

export class CdpError extends Error {}

export class Cdp {
  private next = 1
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly closers = new Set<() => void>()
  private closed = false

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev) => this.onMessage(String((ev as MessageEvent).data)))
    ws.addEventListener('close', () => this.onClose())
    ws.addEventListener('error', () => this.onClose())
  }

  static open(url: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        ws.close()
        reject(new CdpError('DevTools did not answer in time'))
      }, timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new Cdp(ws))
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new CdpError('DevTools refused the connection'))
      })
    })
  }

  get alive(): boolean {
    return !this.closed
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError('the browser is gone'))
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new CdpError(`${method} took longer than ${timeoutMs} ms`))
      }, timeoutMs)
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  on(method: string, fn: Listener): () => void {
    const set = this.listeners.get(method) ?? new Set()
    set.add(fn)
    this.listeners.set(method, set)
    return () => set.delete(fn)
  }

  onClose(fn?: () => void): void {
    if (fn) {
      this.closers.add(fn)
      return
    }
    if (this.closed) return
    this.closed = true
    for (const w of this.waiting.values()) w.reject(new CdpError('the browser is gone'))
    this.waiting.clear()
    for (const c of this.closers) c()
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
    this.onClose()
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const w = this.waiting.get(msg.id)
      if (!w) return
      this.waiting.delete(msg.id)
      if (msg.error) w.reject(new CdpError(msg.error.message))
      else w.resolve(msg.result ?? {})
      return
    }
    if (msg.method) for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {}, msg.sessionId)
  }
}
