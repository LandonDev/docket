import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { OfficeError } from '../carrier'
import { comCarrier, comError, type HelperProcess } from './carrier'

/**
 * The Windows carrier's wire, against a stand-in for tc-office.exe: one JSON
 * object per line each way, the helper's refusals in OfficeError's codes,
 * COM's busy codes as a retry, Excel's change events, and a helper that
 * stops or hangs replaced by a fresh one. The helper itself runs in the rig
 * (rig.test.ts).
 */

type Answer = (verb: string, args: Record<string, unknown>, p: Fake) => unknown

class Fake extends EventEmitter implements HelperProcess {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  seen: { verb: string; args: Record<string, unknown> }[] = []
  killed = false
  constructor(answer: Answer, ready = true) {
    super()
    let buf = ''
    this.stdin.setEncoding('utf8').on('data', (d: string) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, nl)) as { id: number; verb: string; args: Record<string, unknown> }
        buf = buf.slice(nl + 1)
        this.seen.push({ verb: req.verb, args: req.args })
        const a = answer(req.verb, req.args, this)
        if (a === HANG) continue
        this.line(a instanceof Error ? { id: req.id, ok: false, error: JSON.parse(a.message) } : { id: req.id, ok: true, value: a ?? null })
      }
    })
    if (ready) setImmediate(() => this.line({ event: 'ready', version: 1, pid: 7 }))
  }
  line(o: unknown): void {
    this.stdout.write(`${JSON.stringify(o)}\n`)
  }
  kill(): boolean {
    this.killed = true
    setImmediate(() => this.emit('close', null))
    return true
  }
}

const HANG = Symbol('hang')
const refuse = (e: { code?: string; message: string; hresult?: string }) => new Error(JSON.stringify(e))

const make = (answer: Answer, opts: { ready?: boolean; timeoutMs?: number } = {}) => {
  const procs: Fake[] = []
  const log: string[] = []
  const carrier = comCarrier({
    start: async () => {
      const p = new Fake(answer, opts.ready ?? true)
      procs.push(p)
      return p
    },
    timeoutMs: opts.timeoutMs,
    log: (l) => log.push(l)
  })
  return { carrier, procs, log }
}

describe('the Windows carrier', () => {
  it('starts one helper on the first call and sends each verb with its arguments as one line', async () => {
    const { carrier, procs } = make((verb, args) => (verb === 'readRange' ? { values: [[1]], formulas: [['']], formats: [['General']] } : verb === 'mail' ? (args.send ? null : 'draft-1') : null))
    expect(procs).toHaveLength(0)
    await expect(carrier.readRange('C:\\b.xlsx', 'Sheet1', 'A1')).resolves.toEqual({ values: [[1]], formulas: [['']], formats: [['General']] })
    await carrier.writeRange('C:\\b.xlsx', 'Sheet1', 'A1:B1', [[2, '=A1']])
    await expect(carrier.draftMail({ to: ['a@x.com'], cc: [], bcc: [], subject: 's', html: '<b>h</b>' })).resolves.toBe('draft-1')
    await expect(carrier.sendMail({ to: ['a@x.com'], cc: [], bcc: [], subject: 's', html: '<b>h</b>' })).resolves.toEqual({ id: null })
    await carrier.open('excel', { kind: 'path', path: 'C:\\b.xlsx' })
    expect(procs).toHaveLength(1)
    expect(procs[0].seen).toEqual([
      { verb: 'readRange', args: { book: 'C:\\b.xlsx', sheet: 'Sheet1', address: 'A1' } },
      { verb: 'writeRange', args: { book: 'C:\\b.xlsx', sheet: 'Sheet1', address: 'A1:B1', grid: [[2, '=A1']] } },
      { verb: 'mail', args: { m: { to: ['a@x.com'], cc: [], bcc: [], subject: 's', html: '<b>h</b>' }, send: false } },
      { verb: 'mail', args: { m: { to: ['a@x.com'], cc: [], bcc: [], subject: 's', html: '<b>h</b>' }, send: true } },
      { verb: 'open', args: { app: 'excel', ref: { kind: 'path', path: 'C:\\b.xlsx' } } }
    ])
    expect(carrier.kind).toBe('com')
  })

  it("answers the helper's refusals as OfficeErrors with its code, and COM's busy codes as busy", async () => {
    const { carrier } = make((verb) =>
      verb === 'workbooks'
        ? refuse({ code: 'not-running', message: 'Microsoft Excel is not open.' })
        : verb === 'documents'
          ? refuse({ code: 'failed', message: 'Microsoft Word answered: rejected', hresult: '0x8001010A' })
          : refuse({ code: 'weird', message: 'odd' })
    )
    await expect(carrier.workbooks()).rejects.toMatchObject({ code: 'not-running', message: 'Microsoft Excel is not open.' })
    await expect(carrier.documents()).rejects.toMatchObject({ code: 'busy' })
    await expect(carrier.accounts()).rejects.toMatchObject({ code: 'failed', message: 'odd' })
    expect(comError({ hresult: '0x80010001' })).toMatchObject({ code: 'busy', message: 'Office is busy: try again in a moment.' })
    expect(comError({ code: 'not-allowed', message: 'guard' })).toBeInstanceOf(OfficeError)
  })

  it('reports apps with what the last call found allowed, and Outlook refused once its guard says no', async () => {
    const { carrier } = make((verb) =>
      verb === 'apps' ? [{ app: 'excel', installed: true, running: true }, { app: 'outlook', installed: true, running: true }] : verb === 'readMail' ? refuse({ code: 'not-allowed', message: 'guard' }) : []
    )
    expect(await carrier.apps()).toEqual([
      { app: 'excel', installed: true, running: true, allowed: 'unknown' },
      { app: 'outlook', installed: true, running: true, allowed: 'unknown' }
    ])
    await carrier.workbooks()
    await expect(carrier.readMail('1')).rejects.toMatchObject({ code: 'not-allowed' })
    expect((await carrier.apps()).map((a) => a.allowed)).toEqual(['yes', 'no'])
  })

  it('says no Office is here when the helper cannot start, and a call then refuses plainly (nothing reached Office)', async () => {
    const log: string[] = []
    const carrier = comCarrier({ start: () => Promise.reject(new Error('csc: not found')), log: (l) => log.push(l) })
    expect((await carrier.apps()).every((a) => !a.installed)).toBe(true)
    expect(log[0]).toContain('csc: not found')
    await expect(carrier.sendMail({ to: ['a@x.com'], cc: [], bcc: [], subject: 's', html: '' })).rejects.toMatchObject({ code: 'not-installed', message: 'tc-office could not start: csc: not found' })
  })

  it('fails the calls in flight when the helper stops, as an unclear end, and starts a fresh one for the next call', async () => {
    const { carrier, procs } = make((verb, _a, p) => (verb === 'mail' ? (setImmediate(() => p.emit('close', 3)), HANG) : ['a@x.com']))
    await expect(carrier.sendMail({ to: ['a@x.com'], cc: [], bcc: [], subject: 's', html: '' })).rejects.toMatchObject({ code: 'failed', message: 'tc-office stopped (3).' })
    await expect(carrier.accounts()).resolves.toEqual(['a@x.com'])
    expect(procs).toHaveLength(2)
  })

  it('gives up on a call Office never answers, stops that helper, and the next call gets a fresh one', async () => {
    const { carrier, procs } = make((verb) => (verb === 'readSlides' ? HANG : []), { timeoutMs: 50 })
    await expect(carrier.readSlides('C:\\d.pptx')).rejects.toThrow(/did not answer readSlides within 0 s/)
    expect(procs[0].killed).toBe(true)
    await vi.waitFor(async () => expect(await carrier.presentations()).toEqual([]))
    expect(procs).toHaveLength(2)
  })

  it('refuses plainly when the helper never says it is ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { carrier, procs } = make(() => [], { ready: false })
      const call = carrier.accounts()
      await vi.waitFor(() => expect(procs).toHaveLength(1))
      vi.advanceTimersByTime(30_001)
      await expect(call).rejects.toMatchObject({ code: 'not-installed', message: 'tc-office did not start in time.' })
      expect(procs[0].killed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("hands Excel's changes to listeners area by area, asks the helper to listen only while someone does, and again after a restart", async () => {
    const { carrier, procs } = make(() => null)
    const heard: string[] = []
    const off = carrier.changes!((book, sheet, address) => heard.push(`${book}|${sheet}|${address}`))
    await carrier.workbooks()
    await vi.waitFor(() => expect(procs[0].seen.map((s) => s.verb)).toEqual(['watch', 'workbooks']))
    expect(procs[0].seen[0].args).toEqual({ on: true })
    procs[0].line({ event: 'changed', book: 'C:\\b.xlsx', sheet: 'Sheet1', address: 'A1:B2,D4' })
    await vi.waitFor(() => expect(heard).toEqual(['C:\\b.xlsx|Sheet1|A1:B2', 'C:\\b.xlsx|Sheet1|D4']))
    // A co-author's merge comes with no range: no sheet.
    procs[0].line({ event: 'remote', book: 'https://contoso.sharepoint.com/Plan.xlsx' })
    await vi.waitFor(() => expect(heard.at(-1)).toBe('https://contoso.sharepoint.com/Plan.xlsx||'))

    procs[0].emit('close', 0)
    await carrier.workbooks()
    await vi.waitFor(() => expect(procs[1].seen.map((s) => s.verb)).toEqual(['watch', 'workbooks']))
    off()
    await vi.waitFor(() => expect(procs[1].seen.at(-1)).toEqual({ verb: 'watch', args: { on: false } }))
  })

  it("logs the helper's stderr and a line that is not a frame, and goes on", async () => {
    const { carrier, procs, log } = make(() => ['a@x.com'])
    await carrier.accounts()
    procs[0].stderr.write('tc-office: no SheetChange events: x\n')
    procs[0].stdout.write('garbage\n')
    await expect(carrier.accounts()).resolves.toEqual(['a@x.com'])
    await vi.waitFor(() => expect(log).toEqual(['office: tc-office: no SheetChange events: x', 'office: not a frame: garbage']))
  })
})
