import { OfficeError, type OfficeFile } from '../carrier'
import { cloudKey, sameCloudFile } from '../live/address'
import type { AddinKeys } from './keys'

/**
 * Main's side of the add-in relay (docs/agents/work-office.md "The add-in"):
 * the link to the Work service's `/w/office/host`, every add-in on it, and the
 * calls TempCode makes on their files. The relay (routes/office.ts) judges
 * nothing; this decides who is let in.
 */

export type AddinApp = 'excel' | 'word' | 'powerpoint' | 'other'

export interface AddinSession {
  conn: number
  keyId: string
  app: AddinApp
  platform: string
  file: OfficeFile | null
  sheets: { name: string; rows: number; columns: number }[]
  /** when it said hello: the newest wins where one file is open twice */
  since: number
}

/** The link as the hub uses it: a WebSocket in the app, anything that sends text in a test. */
export interface LinkSocket {
  send(text: string): void
}

export const CALL_MS = 30_000
/** A call's arguments as JSON: a write past this goes in parts (the relay takes an add-in's 8 MiB, Excel on the web 5 MB). */
export const CALL_MAX = 4 * 1024 * 1024

const APPS: readonly AddinApp[] = ['excel', 'word', 'powerpoint']

export class AddinHub {
  readonly sessions = new Map<number, AddinSession>()
  private link: LinkSocket | null = null
  private readonly calls = new Map<number, { conn: number; resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private nextCall = 1

  constructor(
    private readonly o: {
      keys: AddinKeys
      /** a change to a workbook by range, someone else's: the Excel helper re-reads what it watches there */
      heard(book: string, sheet: string, address: string): void
      log(line: string): void
      callMs?: number
    }
  ) {}

  /** A new link to the relay; whatever rode the old one is gone. */
  attach(link: LinkSocket): void {
    this.detach()
    this.link = link
  }

  detach(): void {
    this.link = null
    for (const conn of [...this.sessions.keys()]) this.gone(conn)
  }

  private toRelay(m: unknown): void {
    this.link?.send(JSON.stringify(m))
  }

  private toAddin(conn: number, m: unknown): void {
    this.toRelay({ t: 'send', conn, data: m })
  }

  /** One message from the relay. */
  receive(text: string): void {
    let m: { t?: string; conn?: number; first?: Record<string, unknown>; from?: unknown; data?: unknown }
    try {
      m = JSON.parse(text) as typeof m
    } catch {
      return
    }
    if (typeof m.conn !== 'number') return
    if (m.t === 'open' && m.first) return this.hello(m.conn, m.first, typeof m.from === 'string' ? m.from : '?')
    if (m.t === 'close') return this.gone(m.conn)
    if (m.t === 'msg' && m.data && typeof m.data === 'object') this.message(m.conn, m.data as Record<string, unknown>)
  }

  private hello(conn: number, first: Record<string, unknown>, from: string): void {
    const app = APPS.includes(first.app as AddinApp) ? (first.app as AddinApp) : 'other'
    const platform = typeof first.platform === 'string' ? first.platform.slice(0, 20) : 'unknown'
    let keyId: string | null
    let paired: { id: string; key: string } | null = null
    if (first.t === 'pair') {
      paired = this.o.keys.pair(first.code, typeof first.name === 'string' ? first.name : `${app} on ${platform}`, app, from)
      if (!paired) return this.toRelay({ t: 'refuse', conn, code: 4401, reason: 'That code did not work. Ask TempCode for a new one.' })
      keyId = paired.id
    } else {
      keyId = this.o.keys.check(first.key)
      if (!keyId) return this.toRelay({ t: 'refuse', conn, code: 4403, reason: 'TempCode does not know this add-in. Pair it again.' })
    }
    this.sessions.set(conn, { conn, keyId, app, platform, file: null, sheets: [], since: Date.now() })
    // Admitted first, so the add-in's answer to the welcome reaches us.
    this.toRelay({ t: 'admit', conn })
    if (paired) this.toAddin(conn, { t: 'paired', id: paired.id, key: paired.key })
    this.toAddin(conn, { t: 'welcome' })
    this.o.log(`office add-in: ${app} on ${platform} ${paired ? 'paired' : 'connected'}`)
  }

  private message(conn: number, m: Record<string, unknown>): void {
    const s = this.sessions.get(conn)
    if (!s) return
    if (m.t === 'result' && typeof m.id === 'number') {
      const c = this.calls.get(m.id)
      if (!c || c.conn !== conn) return
      this.calls.delete(m.id)
      clearTimeout(c.timer)
      if (typeof m.error === 'string') c.reject(new OfficeError(m.error))
      else c.resolve(m.value)
      return
    }
    if (m.t === 'file') {
      const f = m.file as { key?: unknown; name?: unknown } | undefined
      if (f && typeof f.key === 'string' && f.key && typeof f.name === 'string') s.file = { key: f.key, name: f.name }
      if (Array.isArray(m.sheets)) s.sheets = sheetsOf(m.sheets)
      return
    }
    if (m.t === 'changed' && s.app === 'excel' && s.file && typeof m.sheet === 'string' && typeof m.address === 'string') this.o.heard(s.file.key, m.sheet, m.address.replace(/^.*!/, ''))
  }

  private gone(conn: number): void {
    if (!this.sessions.delete(conn)) return
    for (const [id, c] of this.calls)
      if (c.conn === conn) {
        this.calls.delete(id)
        clearTimeout(c.timer)
        c.reject(new OfficeError('The add-in closed before it answered.', 'not-running'))
      }
  }

  /** Runs `op` in the add-in on `conn`: its answer, or an `OfficeError` with the add-in's words. */
  call(conn: number, op: string, args: unknown): Promise<unknown> {
    if (!this.link || !this.sessions.has(conn)) return Promise.reject(new OfficeError('The add-in is not connected.', 'not-running'))
    if (JSON.stringify(args ?? null).length > CALL_MAX) return Promise.reject(new OfficeError('That is too much for the add-in in one call: write it in parts.'))
    const id = this.nextCall++
    return new Promise((resolve, reject) => {
      const ms = this.o.callMs ?? CALL_MS
      const timer = setTimeout(() => {
        this.calls.delete(id)
        reject(new OfficeError(`The add-in did not answer in ${Math.round(ms / 1000)} s.`))
      }, ms)
      this.calls.set(id, { conn, resolve, reject, timer })
      this.toAddin(conn, { t: 'call', id, op, args })
    })
  }

  /**
   * The add-in that has this file open, the newest where there are two. Its key is `Office.context.document.url`; a
   * key that is another form of that address (a Files tab's `?web=1`, a `/:w:/r` link) finds it too (`sameCloudFile`).
   */
  sessionFor(app: AddinApp, key: string): AddinSession | undefined {
    // The very key first; another form of the address only where none has it.
    const newest = (match: (k: string) => boolean): AddinSession | undefined => {
      let best: AddinSession | undefined
      for (const s of this.sessions.values()) if (s.app === app && s.file && match(s.file.key) && (!best || s.since >= best.since)) best = s
      return best
    }
    return newest((k) => k === key) ?? newest((k) => sameCloudFile(k, key))
  }

  /** Whether any add-in has a file open. */
  anyFile(): boolean {
    return [...this.sessions.values()].some((s) => s.file !== null)
  }

  /** Every file open in an add-in of this app, once each (by `sessionFor`, so two forms of one address are one file). */
  files(app: AddinApp): AddinSession[] {
    // One file once, whatever form of its address each add-in has it under: the newest add-in on it.
    const once = new Map<string, AddinSession>()
    for (const s of this.sessions.values())
      if (s.app === app && s.file) {
        const file = cloudKey(s.file.key) ?? s.file.key
        const was = once.get(file)
        if (!was || s.since >= was.since) once.set(file, s)
      }
    return [...once.values()]
  }

  /** Closes every add-in on a key he removed. */
  kick(keyId: string): void {
    for (const s of this.sessions.values()) if (s.keyId === keyId) this.toRelay({ t: 'refuse', conn: s.conn, code: 4403, reason: 'Removed in TempCode.' })
  }

  /** Key ids with an add-in on them now. */
  live(): Set<string> {
    return new Set([...this.sessions.values()].map((s) => s.keyId))
  }
}

const sheetsOf = (raw: unknown[]): AddinSession['sheets'] =>
  raw.flatMap((x) => {
    const s = x as { name?: unknown; rows?: unknown; columns?: unknown }
    return typeof s.name === 'string' && typeof s.rows === 'number' && typeof s.columns === 'number' ? [{ name: s.name, rows: s.rows, columns: s.columns }] : []
  })
