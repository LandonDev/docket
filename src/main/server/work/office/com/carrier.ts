import { closeSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs'
import { extname } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { OFFICE_APPS, type OfficeAllowed, type OfficeApp, type OfficeAppState, type OfficeCell } from '@shared/contract-work-office'
import { errorText } from '@shared/work/ids'
import { isPasswordLocked, lockedWords, OfficeError, type OfficeCarrier, type RenderAsk, type RenderDone } from '../carrier'
import { spawnHelper } from './helper'

/**
 * The Windows carrier (docs/agents/work-office.md "Windows"): every verb is
 * one request to tc-office.exe, the helper that drives Excel, Word,
 * PowerPoint and classic Outlook by COM in his own session (helper.ts,
 * native/tc-office-win/TcOffice.cs). One JSON object per line each way; one
 * helper for the app's life, started on the first call and again after it
 * stops. Like the Mac's, it drives only the apps he started, save `open` and a render in the Windows VM (which
 * may start one hidden, render.ts).
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
  /** after it exits and its pipes have closed, so every answer it wrote has been read */
  once(event: 'close', fn: (code: number | null) => void): unknown
  once(event: 'error', fn: (err: Error) => void): unknown
}

export interface ComDeps {
  start?: () => Promise<HelperProcess>
  /** a call's answer, at most; the helper is stopped past it (Office sits on a modal dialog) */
  timeoutMs?: number
  /** the same for a send, which may wait on a prompt in Outlook for him */
  sendTimeoutMs?: number
  log?: (line: string) => void
}

export const COM_TIMEOUT_MS = 120_000
/** A render's own call: PowerPoint takes its time over a video (the helper itself gives up at 15 minutes). */
export const RENDER_TIMEOUT_MS = 20 * 60_000
/** A render's copy and result cross the helper's wire in chunks of this many bytes (the helper takes at most 4 MiB). */
export const RENDER_CHUNK = 2 * 1024 * 1024
export const SEND_TIMEOUT_MS = 30 * 60_000
const READY_MS = 30_000

type Frame =
  | { event: 'ready'; version: number; pid?: number }
  | { event: 'changed'; book: string; sheet: string; address: string }
  | { event: 'remote'; book: string }
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { code?: string; message?: string; hresult?: string } }

export type ChangeFn = (book: string, sheet: string, address: string) => void

const CODES = new Set<OfficeError['code']>(['not-installed', 'not-running', 'not-allowed', 'needs-consent', 'not-found', 'busy', 'refused', 'failed'])

/** The verbs that send: a mail, an invitation, an answer. */
const sends = (verb: string, args: unknown): boolean => {
  const a = (args ?? {}) as { send?: boolean; e?: { attendees?: unknown[] } }
  return (verb === 'mail' && a.send === true) || (verb === 'createEvent' && !!a.e?.attendees?.length) || verb === 'answerEvent'
}
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
  /** One request at a time, as the helper runs them: a call's time starts when it is sent. */
  private tail: Promise<unknown> = Promise.resolve()
  readonly listeners = new Set<ChangeFn>()

  constructor(private readonly deps: Required<Pick<ComDeps, 'start' | 'timeoutMs' | 'sendTimeoutMs' | 'log'>>) {}

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
        proc.once('close', (code) => stop(new OfficeError(`tc-office stopped (${code ?? 'killed'}).`, up ? 'failed' : 'not-installed')))
        proc.stdin?.on('error', (err) => stop(new OfficeError(`tc-office failed: ${err.message}`, up ? 'failed' : 'not-installed')))
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

  private send(c: Conn, verb: string, args: unknown, timeoutMs?: number): Promise<unknown> {
    if (c.dead) return Promise.reject(new OfficeError('tc-office stopped.'))
    const id = this.next++
    const sending = sends(verb, args)
    const ms = sending ? this.deps.sendTimeoutMs : (timeoutMs ?? this.deps.timeoutMs)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(id)
        reject(
          new OfficeError(
            sending
              ? `Outlook has not said within ${Math.round(ms / 60_000)} minutes whether it sent this (a prompt may be waiting in Outlook): look in Sent before sending it again.`
              : `Office did not answer ${verb} within ${Math.round(ms / 1000)} s: a dialog may be open in it.`
          )
        )
        // A helper stuck on a modal app answers nothing more: the next call starts a fresh one.
        this.drop(c, new OfficeError(`tc-office was stopped: Office did not answer ${verb}.`))
      }, ms)
      c.pending.set(id, { resolve, reject, timer })
      c.proc.stdin!.write(`${JSON.stringify({ id, verb, args })}\n`)
    })
  }

  /** Runs after every call before it, so its time counts from when the helper takes it up. */
  private queued<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => undefined)
    return run
  }

  call<T>(verb: string, args: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    return this.queued(async () => (await this.send(await this.open(), verb, args, opts.timeoutMs)) as T)
  }

  /** Tell a running helper to start or stop listening; a stopped one is told at its next start. */
  watch(on: boolean): void {
    void this.queued(() => (this.conn && !this.conn.dead ? this.send(this.conn, 'watch', { on }) : Promise.resolve())).catch(() => undefined)
  }

  stop(): void {
    if (this.conn) this.drop(this.conn, new OfficeError('tc-office was stopped.'))
  }
}

export interface ComCarrier extends OfficeCarrier {
  /** Office as a renderer through the helper's render verbs (render.ts). */
  render(ask: RenderAsk): Promise<RenderDone>
  /** One request on the helper's wire as it stands: for diagnostics and the rig's tests (their `_` verbs). */
  call<T>(verb: string, args: unknown): Promise<T>
  /** Stop the helper (the office module's stop, when Work is turned off; tests); the next call starts it again. */
  stop(): void
}

export function comCarrier(deps: ComDeps = {}): ComCarrier {
  const log = deps.log ?? ((line: string) => console.log(`[office] ${line}`))
  const link = new Link({ start: deps.start ?? spawnHelper, timeoutMs: deps.timeoutMs ?? COM_TIMEOUT_MS, sendTimeoutMs: deps.sendTimeoutMs ?? SEND_TIMEOUT_MS, log })
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
  /**
   * Office as a renderer: the copy goes to the helper in chunks, into a job folder of its own (it names the folder,
   * so a host never names a path on that PC), is drawn there and comes back in chunks; the folder goes after.
   */
  const render = async (ask: RenderAsk): Promise<RenderDone> => {
    const stopped = (): void => {
      if (ask.signal?.aborted) throw new OfficeError('cancelled')
    }
    stopped()
    // Never sent: its app would ask for the password in a dialog, and every Office call there would wait behind it.
    if (isPasswordLocked(ask.input)) throw new OfficeError(lockedWords(ask.app), 'refused')
    const { job } = await call<{ job: string }>('render.begin', { app: ask.app, ext: extname(ask.input).slice(1).toLowerCase() }, ask.app)
    // After a stall the helper is gone or stuck: a render.end would only wait behind it, and a new helper knows no job.
    let stalled = false
    try {
      const fd = openSync(ask.input, 'r')
      try {
        const buf = Buffer.alloc(RENDER_CHUNK)
        for (let offset = 0; ; ) {
          const n = readSync(fd, buf, 0, RENDER_CHUNK, offset)
          if (n <= 0) break
          stopped()
          await link.call('render.put', { job, offset, data: buf.subarray(0, n).toString('base64') })
          offset += n
        }
      } finally {
        closeSync(fd)
      }
      stopped()
      const { bytes, ...done } = await link.call<RenderDone & { bytes: number }>(
        'render.run',
        { job, to: ask.to, start: ask.start === true, ...(ask.slide !== undefined ? { slide: ask.slide } : {}), ...(ask.width !== undefined ? { width: ask.width } : {}), ...(ask.seconds !== undefined ? { seconds: ask.seconds } : {}), ...(ask.height !== undefined ? { height: ask.height } : {}) },
        { timeoutMs: RENDER_TIMEOUT_MS }
      )
      allowedSeen.set(ask.app, 'yes')
      // Written beside the output and renamed whole: a read that fails midway leaves no part of a file where it was asked.
      const part = `${ask.output}.part`
      const out = openSync(part, 'w')
      try {
        try {
          for (let offset = 0; offset < bytes; ) {
            stopped()
            const got = await link.call<{ data: string; size: number }>('render.get', { job, offset, length: RENDER_CHUNK })
            const chunk = Buffer.from(got.data, 'base64')
            if (!chunk.length) throw new OfficeError(`tc-office sent ${offset} of the ${bytes} bytes it rendered.`)
            writeSync(out, chunk)
            offset += chunk.length
          }
        } finally {
          closeSync(out)
        }
        renameSync(part, ask.output)
      } catch (err) {
        rmSync(part, { force: true })
        throw err
      }
      return done
    } catch (err) {
      stalled = err instanceof OfficeError && /did not answer|tc-office (was )?stopped/.test(err.message)
      throw err
    } finally {
      if (!stalled) await link.call('render.end', { job }).catch(() => undefined)
    }
  }
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
    render,
    call: (verb, args) => link.call(verb, args),
    stop: () => link.stop()
  }
}
