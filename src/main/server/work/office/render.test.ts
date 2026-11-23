import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FormatsRequestSchemas } from '@shared/contract-work-formats'
import { formats } from '../formats'
import { convertersOf, JobRunner, NoConverterError, NotReadyError, pressOf, type LinkedHost } from '../formats/jobs'
import { statePath } from '../formats/tools'
import type { Caller } from '../modules'
import { isPasswordLocked, OfficeError, type OfficeCarrier, type RenderAsk, type RenderDone } from './carrier'
import { RENDER_CHUNK, comCarrier, type HelperProcess } from './com/carrier'
import { TC_OFFICE_CS } from './com/source'
import { FakeOffice } from './fake'
import { office } from './index'
import { macCarrier, renderFolder, SCRIPTS } from './mac'
import type { Osa } from './osa'
import { officeConverters, pairName, RENDER_PAIRS, RENDER_PROVEN, RENDER_WORDS, renderOptions, type RenderDeps, type RenderPlace } from './render'

/** A file as a password-locked .docx, .xlsx or .pptx is: an OLE compound file, not a zip. */
const LOCKED_HEAD = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/**
 * Office as a renderer: the five converters over a fake carrier (an Office in memory that draws a stand-in file),
 * through the real job runner, between two runners whose link passes the request's own validation; the Windows
 * carrier's render over a stand-in helper speaking tc-office's frames; the Mac's over a recorded osascript, its
 * scripts in a sandbox. The recorded COM surface (RecordedCom.cs) runs only in the Windows rig (com/rig.test.ts).
 */

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-office-render-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const ALL = new Set(RENDER_PAIRS.map(pairName))
const PROVEN_EVERYWHERE: Record<RenderPlace, ReadonlySet<string>> = { mac: ALL, windows: ALL, vm: ALL }

/** A host's userData with an empty toolchain: Office pairs need no tool. */
function host(name: string): string {
  const dataDir = join(root, name)
  mkdirSync(join(dataDir, 'work-tools'), { recursive: true })
  writeFileSync(statePath(dataDir), JSON.stringify({ platform: 'linux-x64', at: 1, tools: {} }))
  return dataDir
}

/** The fake Office, drawing: each render writes a file that says what was asked, and is logged. */
class DrawingOffice extends FakeOffice {
  readonly renders: RenderAsk[] = []
  running = true
  failRender: OfficeError | null = null
  /** what a render writes, by default a line naming it */
  body: (ask: RenderAsk) => Buffer = (ask) => Buffer.from(`${ask.app} ${ask.to} of ${readFileSync(ask.input, 'utf8')}`)
  async apps() {
    return (await super.apps()).map((a) => ({ ...a, running: this.running }))
  }
  async render(ask: RenderAsk): Promise<RenderDone> {
    this.renders.push(ask)
    if (this.failRender) throw this.failRender
    writeFileSync(ask.output, this.body(ask))
    return ask.to === 'pdf' ? { pages: 3 } : ask.to === 'png' ? { width: ask.width, height: 1080 } : { seconds: 60 }
  }
}

interface Vm {
  state: string
  installed?: boolean
  licensed?: boolean | null
  woken: number
  touched?: number
}

function deps(place: RenderPlace | null, carrier: OfficeCarrier | null, vm: Vm = { state: 'awake', woken: 0 }, proven = PROVEN_EVERYWHERE): RenderDeps {
  return {
    place: () => place,
    carrier: () => carrier,
    vm: {
      state: () => (vm.state === 'gone' ? null : { state: vm.state, cannot: null }),
      office: () => (vm.installed === false ? { installed: false, licensed: null } : { installed: true, licensed: vm.licensed ?? true }),
      wake: async () => {
        vm.woken++
        vm.state = 'awake'
      },
      touch: () => void (vm.touched = (vm.touched ?? 0) + 1)
    },
    proven,
    touchMs: 10
  }
}

const runnerOf = (name: string, d: RenderDeps, links: LinkedHost[] = [], forwardMax?: number): JobRunner =>
  new JobRunner({ host: name, dataDir: host(name), converters: convertersOf([{ id: 'office', ensure() {}, convert: officeConverters(d) }]), log: () => {}, links: () => links, ...(forwardMax ? { forwardMax } : {}) })

function file(name: string, text = 'his file'): string {
  const p = join(root, name)
  writeFileSync(p, text)
  return p
}

/** A link whose every request is first parsed by the method's own request schema, as the server does, then passed through JSON. */
function validated(id: string, far: JobRunner, calls: string[] = []): LinkedHost {
  return {
    id,
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push(method)
      const schema = FormatsRequestSchemas.find((s) => s.shape.method.value === method)
      if (!schema) throw new Error(`unknown method ${method}`)
      const req = schema.parse({ id: '1', method, params: JSON.parse(JSON.stringify(params ?? {})) }) as unknown as { params: never }
      const answer = method === 'work.formats.tools' ? await far.report() : await far.serveForwarded(req.params)
      return JSON.parse(JSON.stringify(answer)) as T
    }
  }
}

const owner: Caller = { kind: 'local' } as Caller
const thread: Caller = { kind: 'model', sessionId: 's1' } as Caller

describe('the five pairs', () => {
  it('are registered by the office module, named as the structural pairs are, beside LibreOffice with no clash', () => {
    expect((office.convert ?? []).map((c) => `${c.from}→${c.to}`)).toEqual(['docx→pdf+word', 'xlsx→pdf+excel', 'pptx→pdf+powerpoint', 'pptx→png+powerpoint', 'pptx→mp4+powerpoint'])
    const logged: string[] = []
    const all = convertersOf([formats, office], (l) => logged.push(l))
    expect(logged).toEqual([])
    for (const p of RENDER_PAIRS) expect(all.get(`${p.from}→${p.to}`)?.ready).toBeTypeOf('function')
    // each converter is an app, not a tool on disk
    for (const c of office.convert ?? []) expect(c.needs).toBeUndefined()
  })

  it('are offered by no Mac and no Windows PC until their own live proof passes there', async () => {
    expect(RENDER_PROVEN.mac.size).toBe(0)
    expect(RENDER_PROVEN.windows.size).toBe(0)
    const fake = new DrawingOffice()
    for (const place of ['mac', 'windows'] as const) {
      const runner = runnerOf(place, deps(place, fake, undefined, RENDER_PROVEN))
      expect(await runner.pairs()).toEqual([])
      await expect(runner.convert({ from: 'docx', to: 'pdf+word', input: file('a.docx') })).rejects.toBeInstanceOf(NoConverterError)
    }
    expect(fake.renders).toEqual([])
  })

  it('offers on the VM exactly the pairs its proof passed: all five, proven there', async () => {
    expect(RENDER_PROVEN.vm).toEqual(ALL)
    const runner = runnerOf('box', deps('vm', new DrawingOffice(), { state: 'awake', woken: 0 }, RENDER_PROVEN))
    expect((await runner.pairs()).map((p) => `${p.from}→${p.to}`).sort()).toEqual([...RENDER_PROVEN.vm].sort())
  })
})

describe('a render', () => {
  it('draws a copy in the job’s own folder, never his file, and answers one file per pair', async () => {
    const fake = new DrawingOffice()
    const runner = runnerOf('box', deps('vm', fake))
    const ins = { docx: file('Report.docx', 'words'), xlsx: file('Budget.xlsx', 'cells'), pptx: file('Deck.pptx', 'slides') }
    const beside = readdirSync(root).sort()
    for (const p of RENDER_PAIRS) {
      const done = await runner.convert({ from: p.from, to: p.to, input: ins[p.from as keyof typeof ins] })
      expect(done.output.endsWith(`.${p.out}`)).toBe(true)
      expect(readFileSync(done.output, 'utf8')).toBe(`${p.app} ${p.out} of ${readFileSync(ins[p.from as keyof typeof ins], 'utf8')}`)
    }
    expect(fake.renders.map((r) => [r.app, r.to])).toEqual(RENDER_PAIRS.map((p) => [p.app, p.out]))
    for (const r of fake.renders) {
      expect(Object.values(ins)).not.toContain(r.input)
      expect(r.input).toMatch(/[\\/]work-tools[\\/]jobs[\\/][^\\/]+[\\/]tmp[\\/]input\.(docx|xlsx|pptx)$/)
      // the VM may start an app there, hidden; it is nobody's desktop
      expect(r.start).toBe(true)
    }
    // nothing new beside his files
    expect(readdirSync(root).sort()).toEqual(beside)
    // the copies went with their jobs
    for (const r of fake.renders) expect(existsSync(r.input)).toBe(false)
    expect(readFileSync(ins.docx, 'utf8')).toBe('words')
  })

  it('takes one slide and a width for a PNG, seconds and a height for a video, and refuses a wrong one in words', async () => {
    const fake = new DrawingOffice()
    const runner = runnerOf('box', deps('vm', fake))
    const deck = file('Deck.pptx')
    await runner.convert({ from: 'pptx', to: 'png+powerpoint', input: deck })
    await runner.convert({ from: 'pptx', to: 'png+powerpoint', input: deck, options: { slide: 4, width: 1920 } })
    await runner.convert({ from: 'pptx', to: 'mp4+powerpoint', input: deck, options: { secondsPerSlide: 2, height: 1080 } })
    expect(fake.renders.map(({ slide, width, seconds, height }) => ({ slide, width, seconds, height }))).toEqual([
      { slide: 1, width: 1920, seconds: undefined, height: undefined },
      { slide: 4, width: 1920, seconds: undefined, height: undefined },
      { slide: undefined, width: undefined, seconds: 2, height: 1080 }
    ])
    await expect(runner.convert({ from: 'pptx', to: 'png+powerpoint', input: deck, options: { width: 90_000 } })).rejects.toThrow('width is at most 8192 pixels')
    await expect(runner.convert({ from: 'pptx', to: 'png+powerpoint', input: deck, options: { slide: 0 } })).rejects.toThrow('slide is from 1')
    await expect(runner.convert({ from: 'pptx', to: 'mp4+powerpoint', input: deck, options: { height: 333 } })).rejects.toThrow('height is 480, 720, 1080 or 2160')
    expect(renderOptions(RENDER_PAIRS[0]!, { anything: 1 })).toEqual({})
    expect(fake.renders).toHaveLength(3)
  })
})

describe('each refusal, in words', () => {
  it('"not open": his Mac’s or PC’s app that is shut is never started; one shut mid-job says so', async () => {
    const fake = new DrawingOffice()
    fake.running = false
    const runner = runnerOf('mac', deps('mac', fake))
    expect(await runner.pairs()).toEqual(RENDER_PAIRS.map((p) => ({ from: p.from, to: p.to, state: 'not open' })))
    await expect(runner.convert({ from: 'pptx', to: 'pdf+powerpoint', input: file('d.pptx'), here: true })).rejects.toMatchObject({ code: 'not-ready', state: 'not open' })
    expect(fake.renders).toEqual([])
    // open at the ask, shut by the render
    fake.running = true
    fake.failRender = new OfficeError('Microsoft PowerPoint is not open. (-600)', 'not-running')
    const err = await runner.convert({ from: 'pptx', to: 'pdf+powerpoint', input: file('d.pptx') }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotReadyError)
    expect(err).toMatchObject({ state: 'not open', message: 'PowerPoint is not open on this Mac.' })
    expect(RENDER_WORDS.notOpen('word', 'windows')).toBe('Word is not open on this PC.')
  })

  it('"asleep": a sleeping VM is never woken for a job nobody pressed for, a thread’s or a forged one', async () => {
    const fake = new DrawingOffice()
    const vm: Vm = { state: 'asleep', woken: 0 }
    const runner = runnerOf('box', deps('vm', fake, vm))
    expect(await runner.pairs()).toEqual(RENDER_PAIRS.map((p) => ({ from: p.from, to: p.to, state: 'asleep' })))
    const input = file('a.docx')
    await expect(runner.convert({ from: 'docx', to: 'pdf+word', input })).rejects.toMatchObject({ code: 'not-ready', state: 'asleep' })
    // a thread can make no press, and JSON that says it pressed is not one
    expect(pressOf(thread)).toBeUndefined()
    await expect(runner.convert({ from: 'docx', to: 'pdf+word', input, pressed: pressOf(thread) })).rejects.toMatchObject({ state: 'asleep' })
    await expect(runner.convert({ from: 'docx', to: 'pdf+word', input, pressed: JSON.parse('{"pressed":true}') })).rejects.toMatchObject({ state: 'asleep' })
    await expect(runner.convert({ from: 'docx', to: 'pdf+word', input, options: { pressed: true } })).rejects.toMatchObject({ state: 'asleep' })
    expect(vm.woken).toBe(0)
    expect(fake.renders).toEqual([])
    // his own press wakes it, once, and the render runs
    const done = await runner.convert({ from: 'docx', to: 'pdf+word', input, pressed: pressOf(owner) })
    expect(vm.woken).toBe(1)
    expect(readFileSync(done.output, 'utf8')).toBe('word pdf of his file')
  })

  it('"asleep" said by the converter itself when the VM fell asleep between the ask and the run', async () => {
    const vm: Vm = { state: 'awake', woken: 0 }
    const d = deps('vm', new DrawingOffice(), vm)
    const [word] = officeConverters(d)
    vm.state = 'asleep'
    const dir = mkdtempSync(join(root, 'job-'))
    await expect(word!.run({ from: 'docx', to: 'pdf+word', input: file('a.docx'), output: join(dir, 'a.pdf') }, { tmp: dir, signal: new AbortController().signal } as never)).rejects.toMatchObject({ state: 'asleep', message: RENDER_WORDS.asleep() })
    expect(RENDER_WORDS.asleep()).toBe('Windows is asleep, and only his own press wakes it.')
    expect(vm.woken).toBe(0)
  })

  it('busy: a dialog in the app, or an app that stopped answering, reads as busy', async () => {
    const fake = new DrawingOffice()
    const runner = runnerOf('box', deps('vm', fake))
    fake.failRender = new OfficeError('Office is busy with a dialog: try again once it is closed.', 'busy')
    await expect(runner.convert({ from: 'docx', to: 'pdf+word', input: file('a.docx') })).rejects.toMatchObject({ code: 'busy', message: 'Word is busy with a dialog: try again once it is closed.' })
    // nobody can close a dialog in the VM's hidden app: a stall there says to try again
    fake.failRender = new OfficeError('Office did not answer render.run within 1200 s: a dialog may be open in it.')
    await expect(runner.convert({ from: 'xlsx', to: 'pdf+excel', input: file('a.xlsx') })).rejects.toMatchObject({ code: 'busy', message: 'Excel in the Windows VM stopped answering: try again in a minute.' })
    // the VM never says "not open": an app there that cannot be reached is busy
    fake.failRender = new OfficeError('PowerPoint is open but not reachable: it may be starting.', 'not-running')
    const err = await runner.convert({ from: 'pptx', to: 'pdf+powerpoint', input: file('a.pptx') }).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(NotReadyError)
    expect(err).toMatchObject({ code: 'busy', message: 'PowerPoint is busy with a dialog: try again once it is closed.' })
    // on his Mac a stall is a dialog he can close
    const mac = new DrawingOffice()
    mac.failRender = new OfficeError('Microsoft Word did not answer within 100 s: a dialog may be open in it on this Mac.', 'busy')
    await expect(runnerOf('mac', deps('mac', mac)).convert({ from: 'docx', to: 'pdf+word', input: file('a.docx') })).rejects.toMatchObject({ message: 'Word is busy with a dialog: try again once it is closed.' })
  })

  it('a password-locked file is refused before any app, on every carrier, before the VM wakes or the copy is sent', async () => {
    const locked = join(root, 'Locked.pptx')
    writeFileSync(locked, Buffer.concat([LOCKED_HEAD, Buffer.alloc(504)]))
    expect(isPasswordLocked(locked)).toBe(true)
    expect(isPasswordLocked(file('plain.pptx', 'PK\u0003\u0004 a zip'))).toBe(false)
    expect(isPasswordLocked(file('short.pptx', 'x'))).toBe(false)
    const words = 'This file is locked with a password; open it in PowerPoint to check it.'
    for (const place of ['vm', 'mac', 'windows'] as const) {
      const fake = new DrawingOffice()
      const vm: Vm = { state: 'asleep', woken: 0 }
      const t0 = Date.now()
      await expect(runnerOf(place, deps(place, fake, vm)).convert({ from: 'pptx', to: 'mp4+powerpoint', input: locked, pressed: pressOf(owner) })).rejects.toMatchObject({ code: 'refused', message: words })
      expect(Date.now() - t0).toBeLessThan(2000)
      expect(fake.renders).toEqual([])
      expect(vm.woken).toBe(0)
    }
    expect(RENDER_WORDS.locked('word')).toBe('This file is locked with a password; open it in Word to check it.')
  })

  it('a render counts as use of the VM for as long as it runs, so its idle sleep cannot cut it short', async () => {
    let finish!: () => void
    const fake = new DrawingOffice()
    const slow = fake.render.bind(fake)
    fake.render = async (ask) => {
      await new Promise<void>((resolve) => (finish = resolve))
      return slow(ask)
    }
    const vm: Vm = { state: 'awake', woken: 0 }
    const job = runnerOf('box', deps('vm', fake, vm)).convert({ from: 'pptx', to: 'mp4+powerpoint', input: file('Deck.pptx') })
    await vi.waitFor(() => expect(vm.touched ?? 0).toBeGreaterThanOrEqual(4))
    finish()
    await job
    const after = vm.touched
    await new Promise((r) => setTimeout(r, 50))
    expect(vm.touched).toBe(after)
    // his Mac has no idle sleep to hold off
    const mac: Vm = { state: 'awake', woken: 0 }
    await runnerOf('mac', deps('mac', new DrawingOffice(), mac)).convert({ from: 'docx', to: 'pdf+word', input: file('a.docx') })
    expect(mac.touched).toBeUndefined()
  })

  it('"none": no VM, no Office in it, an Office with no licence, Work off, or no app on the PC', async () => {
    for (const vm of [{ state: 'gone', woken: 0 }, { state: 'none', woken: 0 }, { state: 'setting-up', woken: 0 }, { state: 'awake', installed: false, woken: 0 }, { state: 'awake', licensed: false, woken: 0 }]) {
      const runner = runnerOf('box', deps('vm', new DrawingOffice(), vm))
      expect(await runner.pairs()).toEqual([])
      await expect(runner.convert({ from: 'docx', to: 'pdf+word', input: file('a.docx'), pressed: pressOf(owner) })).rejects.toBeInstanceOf(NoConverterError)
      expect(vm.woken).toBe(0)
    }
    expect(await runnerOf('off', deps(null, new DrawingOffice())).pairs()).toEqual([])
    // a carrier with no Word at all
    const bare = new DrawingOffice()
    bare.failRender = new OfficeError('No Word is in reach: it is not installed on this PC.', 'not-installed')
    const err = await runnerOf('pc', deps('windows', bare)).convert({ from: 'docx', to: 'pdf+word', input: file('a.docx') }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NoConverterError)
    expect((err as Error).message).toBe('No Word is in reach: it is not installed on this PC.')
    bare.failRender = new OfficeError('Class not registered.', 'not-installed')
    await expect(runnerOf('pc', deps('windows', bare)).convert({ from: 'docx', to: 'pdf+word', input: file('a.docx') })).rejects.toThrow(/^No Word is in reach\.$/)
    expect(RENDER_WORDS.none('powerpoint')).toBe('No PowerPoint is in reach.')
  })
})

describe('between hosts', () => {
  it('a Mac with no proven pair sends the job to the box, through the request’s own validation, and the PDF comes back', async () => {
    const fake = new DrawingOffice()
    const box = runnerOf('box', deps('vm', fake))
    const calls: string[] = []
    const mac = runnerOf('mac', deps('mac', new DrawingOffice(), undefined, RENDER_PROVEN), [validated('box', box, calls)])
    const done = await mac.convert({ from: 'pptx', to: 'pdf+powerpoint', input: file('Deck.pptx', 'twelve slides') })
    expect(done.ranOn).toBe('box')
    expect(readFileSync(done.output, 'utf8')).toBe('powerpoint pdf of twelve slides')
    expect(calls).toEqual(['work.formats.tools', 'work.formats.convert'])
    // the options cross; the far side drew its own copy of its own input
    await mac.convert({ from: 'pptx', to: 'png+powerpoint', input: file('Deck.pptx'), options: { slide: 3, width: 1920 } })
    expect(fake.renders.at(-1)).toMatchObject({ slide: 3, width: 1920, start: true })
  })

  it('a forwarded job carries no press: the box’s sleeping VM is passed over and nothing wakes', async () => {
    const vm: Vm = { state: 'asleep', woken: 0 }
    const box = runnerOf('box', deps('vm', new DrawingOffice(), vm))
    const mac = runnerOf('mac', deps('mac', new DrawingOffice(), undefined, RENDER_PROVEN), [validated('box', box)])
    const err = await mac.convert({ from: 'docx', to: 'pdf+word', input: file('a.docx'), pressed: pressOf(owner), options: { pressed: true } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotReadyError)
    expect((err as NotReadyError).state).toBe('asleep')
    expect((err as Error).message).toContain('on box')
    expect(vm.woken).toBe(0)
  })

  it("a shared library's file renders only where it is: never carried to the box", async () => {
    const box = runnerOf('box', deps('vm', new DrawingOffice()))
    const calls: string[] = []
    const mac = runnerOf('mac', deps('mac', new DrawingOffice(), undefined, RENDER_PROVEN), [validated('box', box, calls)])
    await expect(mac.convert({ from: 'docx', to: 'pdf+word', input: file('Teams.docx'), shared: true })).rejects.toThrow("a shared library's file is never carried to another host")
    expect(calls).toEqual([])
  })

  it('a result over the cap that would cross hosts fails in words, and none of it is kept', async () => {
    const fake = new DrawingOffice()
    fake.body = () => Buffer.alloc(4096, 1)
    const box = runnerOf('box', deps('vm', fake), [], 1024)
    const mac = runnerOf('mac', deps('mac', new DrawingOffice(), undefined, RENDER_PROVEN), [validated('box', box)], 1024)
    await expect(mac.convert({ from: 'pptx', to: 'mp4+powerpoint', input: file('Deck.pptx') })).rejects.toThrow('the mp4 is 0 MB; a job carried back to another host takes at most 0 MB')
    // none of it kept on either side
    const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : [])
    expect(files(join(root, 'box', 'work-tools', 'jobs'))).toEqual([])
    expect(files(join(root, 'mac', 'work-tools', 'jobs'))).toEqual([])
  })
})

/** A stand-in tc-office: the render verbs over one pipe pair, a job folder of its own in memory. */
function helper(opts: { draw?: (args: Record<string, unknown>) => { ok: true; value: unknown } | { ok: false; error: Record<string, string> }; delay?: (verb: string) => number; failGetAt?: number } = {}) {
  const seen: { verb: string; args: Record<string, unknown> }[] = []
  let input = Buffer.alloc(0)
  let output = Buffer.alloc(0)
  const start = async (): Promise<HelperProcess> => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let buf = ''
    stdin.setEncoding('utf8').on('data', (d: string) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, nl)) as { id: number; verb: string; args: Record<string, unknown> }
        buf = buf.slice(nl + 1)
        seen.push({ verb: req.verb, args: req.verb === 'render.put' ? { ...req.args, data: `${String(req.args.data).length} chars` } : req.args })
        let answer: { ok: true; value: unknown } | { ok: false; error: Record<string, string> } = { ok: true, value: null }
        if (req.verb === 'render.begin') answer = { ok: true, value: { job: 'f'.repeat(32) } }
        if (req.verb === 'render.put') input = Buffer.concat([input, Buffer.from(String(req.args.data), 'base64')])
        if (req.verb === 'render.run') {
          answer = opts.draw?.(req.args) ?? { ok: true, value: { pages: 3 } }
          if (answer.ok) {
            output = Buffer.concat([Buffer.from('%PDF of '), input])
            answer = { ok: true, value: { ...(answer.value as object), bytes: output.length } }
          }
        }
        if (req.verb === 'render.get') {
          const at = Number(req.args.offset)
          answer = opts.failGetAt !== undefined && at >= opts.failGetAt ? { ok: false, error: { code: 'failed', message: 'the link dropped' } } : { ok: true, value: { data: output.subarray(at, at + Number(req.args.length)).toString('base64'), size: output.length } }
        }
        if (req.verb === 'readRange') answer = { ok: true, value: { values: [], formulas: [], formats: [] } }
        const line = `${JSON.stringify({ id: req.id, ...answer })}\n`
        const wait = opts.delay?.(req.verb) ?? 0
        if (wait) setTimeout(() => stdout.write(line), wait)
        else stdout.write(line)
      }
    })
    setImmediate(() => stdout.write(`${JSON.stringify({ event: 'ready', version: 1 })}\n`))
    return { stdin, stdout, kill: () => true, once: () => undefined }
  }
  return { start, seen, input: () => input }
}

describe('the Windows carrier’s render (tc-office.exe’s render verbs)', () => {
  it('never sends a password-locked file: refused before render.begin', async () => {
    const h = helper()
    const carrier = comCarrier({ start: h.start, log: () => {} })
    const input = join(root, 'input.pptx')
    writeFileSync(input, Buffer.concat([LOCKED_HEAD, Buffer.alloc(100)]))
    await expect(carrier.render({ app: 'powerpoint', to: 'pdf', input, output: join(root, 'o.pdf'), start: true })).rejects.toMatchObject({ code: 'refused', message: 'This file is locked with a password; open it in PowerPoint to check it.' })
    expect(h.seen).toEqual([])
    carrier.stop()
  })

  it('leaves no part of a result where it was asked when a read fails midway', async () => {
    const h = helper({ failGetAt: RENDER_CHUNK })
    const carrier = comCarrier({ start: h.start, log: () => {} })
    const input = join(root, 'input.pptx')
    writeFileSync(input, Buffer.alloc(RENDER_CHUNK + 10, 1))
    const output = join(root, 'video.mp4')
    await expect(carrier.render({ app: 'powerpoint', to: 'mp4', input, output, start: true })).rejects.toThrow('the link dropped')
    expect(existsSync(output)).toBe(false)
    expect(existsSync(`${output}.part`)).toBe(false)
    expect(h.seen.at(-1)!.verb).toBe('render.end')
    carrier.stop()
  })

  it('gives render.run its own 20 minutes while every other call keeps the 120 s; after a stall it sends no render.end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // the stand-in's frames go on real turns of the loop: wait for a verb to reach it before moving the clock
    const reached = async (h: { seen: { verb: string }[] }, verb: string): Promise<void> => {
      for (let i = 0; i < 200 && !h.seen.some((x) => x.verb === verb); i++) await new Promise((r) => setImmediate(r))
    }
    try {
      const h = helper({ delay: (verb) => (verb === 'render.run' || verb === 'readRange' ? 180_000 : 0) })
      const carrier = comCarrier({ start: h.start, log: () => {} })
      const input = join(root, 'input.pptx')
      writeFileSync(input, 'deck')
      const video = carrier.render({ app: 'powerpoint', to: 'mp4', input, output: join(root, 'v.mp4'), start: true })
      await reached(h, 'render.run')
      await vi.advanceTimersByTimeAsync(181_000)
      await reached(h, 'render.end')
      await expect(video).resolves.toEqual({ pages: 3 })
      const read = carrier.readRange('C:\\b.xlsx', 'Sheet1', 'A1').catch((e: unknown) => e)
      await reached(h, 'readRange')
      await vi.advanceTimersByTimeAsync(121_000)
      expect(await read).toMatchObject({ message: expect.stringContaining('did not answer readRange within 120 s') })
      // a render that stalls past its 20 minutes: the helper is dropped, and no render.end waits behind it
      const h2 = helper({ delay: (verb) => (verb === 'render.run' ? 30 * 60_000 : 0) })
      const c2 = comCarrier({ start: h2.start, log: () => {} })
      const stuck = c2.render({ app: 'powerpoint', to: 'mp4', input, output: join(root, 'w.mp4'), start: true }).catch((e: unknown) => e)
      await reached(h2, 'render.run')
      await vi.advanceTimersByTimeAsync(20 * 60_000 + 1000)
      expect(await stuck).toMatchObject({ message: expect.stringContaining('did not answer render.run within 1200 s') })
      expect(h2.seen.map((x) => x.verb)).not.toContain('render.end')
      carrier.stop()
      c2.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends the copy in chunks into the helper’s own job folder, draws it, reads the result back and ends the job', async () => {
    const h = helper()
    const carrier = comCarrier({ start: h.start, log: () => {} })
    const big = Buffer.alloc(RENDER_CHUNK * 2 + 17, 7)
    const input = join(root, 'input.pptx')
    writeFileSync(input, big)
    const output = join(root, 'out.png')
    const done = await carrier.render({ app: 'powerpoint', to: 'png', input, output, slide: 2, width: 1920, start: true })
    expect(done).toEqual({ pages: 3 })
    expect(h.input().equals(big)).toBe(true)
    expect(readFileSync(output).equals(Buffer.concat([Buffer.from('%PDF of '), big]))).toBe(true)
    expect(h.seen.map((s) => s.verb)).toEqual(['render.begin', 'render.put', 'render.put', 'render.put', 'render.run', 'render.get', 'render.get', 'render.get', 'render.end'])
    expect(h.seen[0]!.args).toEqual({ app: 'powerpoint', ext: 'pptx' })
    expect(h.seen.find((s) => s.verb === 'render.run')!.args).toEqual({ job: 'f'.repeat(32), to: 'png', start: true, slide: 2, width: 1920 })
    // the host names no path on that PC
    expect(JSON.stringify(h.seen)).not.toContain(root)
    carrier.stop()
  })

  it('ends the job when the app refuses, and says busy as the helper said it', async () => {
    const h = helper({ draw: () => ({ ok: false, error: { code: 'busy', message: 'Word is busy with a dialog: try again once it is closed.' } }) })
    const carrier = comCarrier({ start: h.start, log: () => {} })
    const input = join(root, 'input.docx')
    writeFileSync(input, 'x')
    await expect(carrier.render({ app: 'word', to: 'pdf', input, output: join(root, 'o.pdf') })).rejects.toMatchObject({ code: 'busy', message: 'Word is busy with a dialog: try again once it is closed.' })
    expect(h.seen.map((s) => s.verb)).toEqual(['render.begin', 'render.put', 'render.run', 'render.end'])
    expect(h.seen.find((s) => s.verb === 'render.run')!.args.start).toBe(false)
    expect(existsSync(join(root, 'o.pdf'))).toBe(false)
    carrier.stop()
  })
})

describe('the helper’s render region (TcOffice.cs, built only in Windows)', () => {
  it('opens the copy read only with no window, draws it with the app’s own export, closes it unsaved, and keeps the workbook’s print settings', () => {
    expect(TC_OFFICE_CS).toContain('#region Render (SLD2: Office as a renderer)')
    // Word: ReadOnly, not in recent files, Visible false; ExportAsFixedFormat as PDF; Close without saving
    expect(TC_OFFICE_CS).toContain('"Open", input, false, true, false, NoPassword, NoPassword, false, NoPassword, NoPassword, Missing, Missing, false, false, Missing, true)')
    expect(TC_OFFICE_CS).toContain('com.Call(d, "ExportAsFixedFormat", output, 17,')
    expect(TC_OFFICE_CS).toContain('com.Call(d, "Close", 0)')
    // Excel: read only, an open password but no write password (Excel refuses one for a workbook without), IgnorePrintAreas false
    expect(TC_OFFICE_CS).toContain('"Open", input, 0, true, Missing, NoPassword, Missing, true, Missing, Missing, false, false, Missing, false)')
    expect(TC_OFFICE_CS).toContain('com.Call(b, "ExportAsFixedFormat", 0, output, 0, true, false,')
    expect(TC_OFFICE_CS).toContain('com.Call(b, "Close", false)')
    // PowerPoint: ReadOnly, WithWindow false; SaveAs PDF, Slide.Export, CreateVideo
    expect(TC_OFFICE_CS).toContain('"Open", input, -1, 0, 0)')
    expect(TC_OFFICE_CS).toContain('com.Call(p, "SaveAs", output, 32)')
    expect(TC_OFFICE_CS).toContain('"Export", output, "PNG", width, height)')
    expect(TC_OFFICE_CS).toContain('com.Call(p, "CreateVideo", output, false, seconds, tall, 30, 85)')
    // a dialog is busy, in the app's name; an app not open is refused unless the host may start one
    expect(TC_OFFICE_CS).toContain('" is busy with a dialog: try again once it is closed."')
    expect(TC_OFFICE_CS).toContain('if (!start) throw new Refusal("not-running", Short(app) + " is not open on this PC.")')
    // a password-locked file refused before any app; alerts off on every app it starts; Word and Excel its own with start
    expect(TC_OFFICE_CS).toContain('if (Locked(input)) throw new Refusal("refused", LockedWords(j.App));')
    expect(TC_OFFICE_CS).toContain('com.Set(made, "DisplayAlerts", app == "word" ? (object)0 : app == "excel" ? (object)false : 1)')
    expect(TC_OFFICE_CS).toContain('if (running && !(start && app != "powerpoint")) {')
    // what it started is kept by pid, ended when Quit does not end it, and at the next render.begin
    expect(TC_OFFICE_CS).toContain('if (mine) End(j.App, app, pid);')
    expect(TC_OFFICE_CS).toContain('com.Kill(pid);')
    expect(TC_OFFICE_CS).toContain('    EndOrphans();')
    // a video's length is bounded and counts its shown slides
    expect(TC_OFFICE_CS).toContain('public const int VideoMaxSeconds = 30 * 60;')
    expect(TC_OFFICE_CS).toContain('return Obj("seconds", shown * seconds, "height", tall);')
  })
})

describe('the Mac’s render (JXA, unproven and not offered)', () => {
  const recorded = (answer: (script: string, args: Record<string, unknown>) => string) => {
    const calls: { script: string; args: Record<string, unknown> }[] = []
    const osa: Osa = async (_lang, script, args) => {
      const a = JSON.parse(args[0] ?? '{}') as Record<string, unknown>
      calls.push({ script, args: a })
      return answer(script, a)
    }
    return { osa, calls }
  }

  it('renders a copy in the app’s own container, only while the app is open, and removes the copy after', async () => {
    const home = join(root, 'home')
    const r = recorded((_s, a) => {
      writeFileSync(String(a.output), '%PDF')
      return JSON.stringify({ pages: 3 })
    })
    const carrier = macCarrier({ osa: r.osa, installed: () => true, running: async () => true, home })
    const output = join(root, 'out.pdf')
    expect(await carrier.render!({ app: 'word', to: 'pdf', input: file('Report.docx'), output })).toEqual({ pages: 3 })
    expect(readFileSync(output, 'utf8')).toBe('%PDF')
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]!.script).toBe(SCRIPTS.renderWord)
    expect(String(r.calls[0]!.args.input)).toMatch(new RegExp(`^${renderFolder(home, 'word')}/[0-9a-f]{16}/input\\.docx$`))
    expect(readdirSync(renderFolder(home, 'word'))).toEqual([])
  })

  it('never starts an app he has shut: "not open on this Mac", with no script run', async () => {
    const r = recorded(() => 'null')
    const carrier = macCarrier({ osa: r.osa, installed: () => true, running: async () => false, home: join(root, 'home') })
    await expect(carrier.render!({ app: 'powerpoint', to: 'pdf', input: file('d.pptx'), output: join(root, 'o.pdf') })).rejects.toMatchObject({ code: 'not-running', message: 'PowerPoint is not open on this Mac.' })
    expect(r.calls).toEqual([])
  })

  it('keeps the one slide asked for from PowerPoint’s folder of PNGs, sized to the width by sips', async () => {
    const home = join(root, 'home')
    const r = recorded((_s, a) => {
      mkdirSync(String(a.output))
      for (const n of [1, 2, 3, 12]) writeFileSync(join(String(a.output), `Slide${n}.png`), `png ${n}`)
      return JSON.stringify({ pages: 12 })
    })
    const sipped: string[][] = []
    const carrier = macCarrier({ osa: r.osa, installed: () => true, running: async () => true, home, sips: async (args) => void sipped.push(args) })
    expect(await carrier.render!({ app: 'powerpoint', to: 'png', input: file('d.pptx'), output: join(root, 's.png'), slide: 3, width: 1920 })).toEqual({ width: 1920 })
    expect(r.calls[0]!.args.to).toBe('png')
    expect(sipped).toHaveLength(1)
    expect(sipped[0]!.slice(0, 2)).toEqual(['--resampleWidth', '1920'])
    expect(sipped[0]![2]).toMatch(/Slide3\.png$/)
    expect(sipped[0]!.slice(3)).toEqual(['--out', join(root, 's.png')])
    await expect(carrier.render!({ app: 'powerpoint', to: 'png', input: file('d.pptx'), output: join(root, 's.png'), slide: 40 })).rejects.toThrow('The deck has 4 slides; there is no slide 40.')
  })

  it("each app's script opens the copy, saves it as the app itself does, and closes it unsaved even when the save fails", () => {
    const steps: unknown[] = []
    const doc = { fullName: () => '/c/input.docx', name: () => 'input.docx' }
    const word = {
      running: () => true,
      open: (p: unknown) => steps.push(['open', p]),
      documents: Object.assign([doc], {}),
      computeStatistics: () => 3,
      saveAs: (_d: unknown, o: unknown) => steps.push(['saveAs', o]),
      close: (_d: unknown, o: unknown) => steps.push(['close', o])
    }
    const run = (name: keyof typeof SCRIPTS, args: unknown, apps: Record<string, unknown>) =>
      runInNewContext(`${SCRIPTS[name]}\nrun([${JSON.stringify(JSON.stringify(args))}])`, { Application: (n: string) => apps[n], Path: (p: string) => `Path(${p})`, JSON, String, Number, Error, ObjC: { import: () => {}, unwrap: (x: unknown) => x }, $: { NSFileManager: { defaultManager: { displayNameAtPath: () => 'Macintosh HD' } } } })
    expect(JSON.parse(String(run('renderWord', { input: '/c/input.docx', output: '/c/output.pdf' }, { 'Microsoft Word': word })))).toEqual({ pages: 3 })
    expect(steps).toEqual([['open', 'Path(/c/input.docx)'], ['saveAs', { fileName: '/c/output.pdf', fileFormat: 'format PDF' }], ['close', { saving: 'no' }]])
    steps.length = 0
    const deck = { fullName: () => '/c/input.pptx', name: () => 'input.pptx', slides: { length: 12 } }
    const pp = { running: () => true, open: (p: unknown) => steps.push(['open', p]), presentations: [deck], save: () => { throw new Error('no room') }, close: (_d: unknown, o: unknown) => steps.push(['close', o]) }
    expect(() => run('renderPowerPoint', { input: '/c/input.pptx', output: '/c/o.pdf', to: 'pdf' }, { 'Microsoft PowerPoint': pp })).toThrow('no room')
    expect(steps).toEqual([['open', 'Path(/c/input.pptx)'], ['close', { saving: 'no' }]])
    // an app that is not open throws before it opens anything
    expect(() => run('renderExcel', { input: '/c/i.xlsx', output: '/c/o.pdf' }, { 'Microsoft Excel': { running: () => false } })).toThrow('Microsoft Excel is not open. (-600)')
  })
})
