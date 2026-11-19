import type { Readable, Writable } from 'node:stream'
import { OFFICE_APPS, type OfficeAllowed, type OfficeApp, type OfficeAppState, type OfficeCell } from '@shared/contract-work-office'
import { errorText } from '@shared/work/ids'
import { OfficeError, type OfficeCarrier } from '../carrier'
import { spawnHelper } from './helper'

/**
 * The Windows carrier (docs/agents/work-office.md "Windows"): every verb is
 * one request to tc-office.exe, the helper that drives Excel, Word,
 * PowerPoint and classic Outlook by COM in his own session (helper.ts,
 * native/tc-office-win/TcOffice.cs). One JSON object per line each way; one
 * helper for the app's life, started on the first call and again after it
 * stops. Like the Mac's, it drives only the apps he started, save `open`.
 *
 * Excel tells the helper of every change he makes in a sheet (SheetChange,
 * with its range) and of a co-author's edits merged into a workbook
 * (AfterRemoteChange, with no range: sheet ''). Those reach `changes`
 * listeners, and the Excel helper reads the blocks again at once. The safety
 * pass still runs for what no event reports (formatting).
 */

/** What the carrier needs of a helper process: the Node child, or a stand-in in tests. */
export interface HelperProcess {
  stdin: Writable | null
  stdout: Readable | null
  stderr?: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', fn: (code: number | null) => void): unknown
  once(event: 'error', fn: (err: Error) => void): unknown
}

export interface ComDeps {
  start?: () => Promise<HelperProcess>
  /** a call's answer, at most; the helper is stopped past it (Office sits on a modal dialog) */
  timeoutMs?: number
  log?: (line: string) => void
}

export const COM_TIMEOUT_MS = 120_000
const READY_MS = 30_000

type Frame =
  | { event: 'ready'; version: number; pid?: number }
  | { event: 'changed'; book: string; sheet: string; address: string }
  | { event: 'remote'; book: string }
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { code?: string; message?: string; hresult?: string } }

export type ChangeFn = (book: string, sheet: string, address: string) => void

const CODES = new Set<OfficeError['code']>(['not-installed', 'not-running', 'not-allowed', 'needs-consent', 'not-found', 'busy', 'failed'])
/** RPC_E_CALL_REJECTED and RPC_E_SERVERCALL_RETRYLATER: the app is busy (a dialog, a cell in edit), past the helper's own retries. */
const BUSY = /^0x8001(0001|010A)$/i

/** The helper's failure in words, with COM's busy codes as a retry. */
export function comError(e: { code?: string; message?: string; hresult?: string }): OfficeError {
  if (e.hresult && BUSY.test(e.hresult)) return new OfficeError(e.message || 'Office is busy: try again in a moment.', 'busy')
  const code = CODES.has(e.code as OfficeError['code']) ? (e.code as OfficeError['code']) : 'failed'
  return new OfficeError(e.message || 'tc-office failed.', code)
}

const APP_OF: Record<string, OfficeApp> = {
  workbooks: 'excel',
  readRange: 'excel',
  writeRange: 'excel',
  documents: 'word',
  readDocument: 'word',
  editDocument: 'word',
  presentations: 'powerpoint',
  readSlides: 'powerpoint',
  replaceSlideText: 'powerpoint'
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** One helper process and the calls in flight to it. */
interface Conn {
  proc: HelperProcess
  pending: Map<number, Pending>
  /** set once it has stopped, or was given up on: nothing more is sent to it */
  dead: boolean
}

/** The helper of the moment: started on the first call, replaced after it stops. */
class Link {
  private conn: Conn | null = null
  private opening: Promise<Conn> | null = null
  private next = 1
  readonly listeners = new Set<ChangeFn>()

  constructor(private readonly deps: Required<Pick<ComDeps, 'start' | 'timeoutMs' | 'log'>>) {}

  /** Done with `c`: its calls fail with `err`, and the next call starts a fresh helper. */
  private drop(c: Conn, err: Error): void {
    if (c.dead) return
    c.dead = true
    if (this.conn === c) this.conn = null
    c.proc.kill()
    for (const p of c.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    c.pending.clear()
  }

  private open(): Promise<Conn> {
    if (this.conn && !this.conn.dead) return Promise.resolve(this.conn)
    this.opening ??= (async () => {
      let proc: HelperProcess
      try {
        proc = await this.deps.start()
      } catch (err) {
        // Nothing reached Office: a plain refusal, so a LifeOS row fails rather than waiting as sent.
        throw new OfficeError(`tc-office could not start: ${errorText(err)}`, 'not-installed')
      }
      const c: Conn = { proc, pending: new Map(), dead: false }
      return await new Promise<Conn>((resolve, reject) => {
        let buf = ''
        let up = false
        const stop = (err: Error) => {
          clearTimeout(timer)
          this.drop(c, err)
          if (!up) reject(err)
        }
        const timer = setTimeout(() => stop(new OfficeError('tc-office did not start in time.', 'not-installed')), READY_MS)
        proc.once('error', (err) => stop(new OfficeError(`tc-office failed: ${err.message}`, up ? 'failed' : 'not-installed')))
        // A call in flight when it stops may have reached Office: not a plain refusal.
        proc.once('exit', (code) => stop(new OfficeError(`tc-office stopped (${code ?? 'killed'}).`, up ? 'failed' : 'not-installed')))
        proc.stderr?.setEncoding('utf8').on('data', (d: string) => d.split('\n').filter((l) => l.trim()).forEach((l) => this.deps.log(`office: ${l.trim()}`)))
        proc.stdout!.setEncoding('utf8').on('data', (d: string) => {
          buf += d
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (line) this.frame(c, line, () => {
              up = true
              clearTimeout(timer)
              this.conn = c
              resolve(c)
            })
          }
        })
      })
    })().finally(() => (this.opening = null))
    return this.opening
  }

  private frame(c: Conn, line: string, ready: () => void): void {
    let f: Frame
    try {
      f = JSON.parse(line) as Frame
    } catch {
      this.deps.log(`office: not a frame: ${line.slice(0, 200)}`)
      return
    }
    if ('event' in f) {
      if (f.event === 'ready' && this.conn !== c && !c.dead) {
        ready()
        if (this.listeners.size) this.send(c, 'watch', { on: true }).catch(() => undefined)
      } else if (f.event === 'changed') for (const area of f.address.split(',')) for (const fn of this.listeners) fn(f.book, f.sheet, area)
      else if (f.event === 'remote') for (const fn of this.listeners) fn(f.book, '', '')
      return
    }
    const p = c.pending.get(f.id)
    if (!p) return
    c.pending.delete(f.id)
    clearTimeout(p.timer)
    if (f.ok) p.resolve(f.value)
    else p.reject(comError(f.error))
  }

  private send(c: Conn, verb: string, args: unknown): Promise<unknown> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(id)
        reject(new OfficeError(`Office did not answer ${verb} within ${Math.round(this.deps.timeoutMs / 1000)} s: a dialog may be open in it.`))
        // A helper stuck on a modal app answers nothing more: the next call starts a fresh one.
        this.drop(c, new OfficeError(`tc-office was stopped: Office did not answer ${verb}.`))
      }, this.deps.timeoutMs)
      c.pending.set(id, { resolve, reject, timer })
      c.proc.stdin!.write(`${JSON.stringify({ id, verb, args })}\n`)
    })
  }

  async call<T>(verb: string, args: unknown): Promise<T> {
    return (await this.send(await this.open(), verb, args)) as T
  }

  /** Tell a running helper to start or stop listening; a stopped one is told at its next start. */
  watch(on: boolean): void {
    if (this.conn && !this.conn.dead) this.send(this.conn, 'watch', { on }).catch(() => undefined)
  }

  stop(): void {
    if (this.conn) this.drop(this.conn, new OfficeError('tc-office was stopped.'))
  }
}

export interface ComCarrier extends OfficeCarrier {
  /** One request on the helper's wire as it stands: for diagnostics and the rig's tests (their `_` verbs). */
  call<T>(verb: string, args: unknown): Promise<T>
  /** Stop the helper (Work turned off, tests); the next call starts it again. */
  stop(): void
}

export function comCarrier(deps: ComDeps = {}): ComCarrier {
  const log = deps.log ?? ((line: string) => console.log(`[office] ${line}`))
  const link = new Link({ start: deps.start ?? spawnHelper, timeoutMs: deps.timeoutMs ?? COM_TIMEOUT_MS, log })
  /** What the last call to each app found: COM asks no consent, but Outlook's guard may refuse. */
  const allowedSeen = new Map<OfficeApp, OfficeAllowed>()
  const call = async <T>(verb: string, args: unknown, app: OfficeApp = APP_OF[verb] ?? 'outlook'): Promise<T> => {
    try {
      const v = await link.call<T>(verb, args)
      allowedSeen.set(app, 'yes')
      return v
    } catch (err) {
      if (err instanceof OfficeError && err.code === 'not-allowed') allowedSeen.set(app, 'no')
      throw err
    }
  }
  const mail = (m: unknown, send: boolean) => call<string | null>('mail', { m, send })
  return {
    kind: 'com',
    async apps() {
      try {
        const found = await link.call<{ app: OfficeApp; installed: boolean; running: boolean }[]>('apps', {})
        return found.map((a) => ({ ...a, allowed: allowedSeen.get(a.app) ?? 'unknown' }))
      } catch (err) {
        log(`no Office here: ${errorText(err)}`)
        return OFFICE_APPS.map((app): OfficeAppState => ({ app, installed: false, running: false, allowed: 'unknown' }))
      }
    },
    workbooks: () => call('workbooks', {}),
    readRange: (book, sheet, address) => call('readRange', { book, sheet, address }),
    writeRange: (book, sheet, address, grid: OfficeCell[][]) => call('writeRange', { book, sheet, address, grid }),
    documents: () => call('documents', {}),
    readDocument: (doc) => call('readDocument', { doc }),
    editDocument: (doc, edit, tracked) => call('editDocument', { doc, edit, tracked }),
    presentations: () => call('presentations', {}),
    readSlides: (pres) => call('readSlides', { pres }),
    replaceSlideText: (pres, find, replace) => call('replaceSlideText', { pres, find, replace }),
    accounts: () => call('accounts', {}),
    listMail: (q) => call('listMail', q),
    readMail: (id) => call('readMail', { id }),
    draftMail: async (m) => (await mail(m, false)) ?? '',
    sendMail: async (m) => ({ id: await mail(m, true) }),
    events: (from, to) => call('events', { from, to }),
    createEvent: (e) => call('createEvent', { e }),
    answerEvent: (id, answer, comment) => call('answerEvent', { id, answer, comment }),
    eventByUid: (uid) => call('eventByUid', { uid }),
    open: (app, ref) => call('open', { app, ref }, app),
    changes(fn) {
      // The helper starts with the first call that needs it (a watched block's first read) and listens from then on.
      link.listeners.add(fn)
      if (link.listeners.size === 1) link.watch(true)
      return () => {
        link.listeners.delete(fn)
        if (!link.listeners.size) link.watch(false)
      }
    },
    call: (verb, args) => link.call(verb, args),
    stop: () => link.stop()
  }
}
