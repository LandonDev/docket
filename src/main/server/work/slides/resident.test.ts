import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { LIBREOFFICE_CONVERTERS } from '../formats'
import { convertersOf, JobRunner } from '../formats/jobs'
import { Toolchain } from '../formats/tools'
import {
  bundledPython,
  createResident,
  IDLE_MS,
  JOB_MS,
  MEMORY_CAP,
  ResidentUnavailable,
  START_MS,
  STOP_MS,
  sumGroupRss,
  type Clock,
  type ResidentChild,
  type ResidentDeps
} from './resident'
import { RESIDENT_PY } from './residentScript'

/**
 * The resident LibreOffice (resident.ts): its lifecycle against a fake
 * process always; behind TEMP_CODE_WORK_TOOLS_DATA (a userData whose
 * toolchain has LibreOffice and PyMuPDF, `/srv/agents/temp-code-data` on the
 * box) one slide through the real thing against the same page of the whole
 * deck, pixel for pixel.
 */

// ── the fake ─────────────────────────────────────────────────────────

class FakeClock implements Clock {
  t = 0
  private timers: Array<{ at: number; fn: () => void; id: number }> = []
  private n = 0
  now = (): number => this.t
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.n
    this.timers.push({ at: this.t + ms, fn, id })
    return id
  }
  clearTimeout = (h: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== h)
  }
  async advance(ms: number): Promise<void> {
    const until = this.t + ms
    for (;;) {
      const due = this.timers.filter((x) => x.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((x) => x !== due)
      this.t = due.at
      due.fn()
      await flush()
    }
    this.t = until
    await flush()
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

type Reply = 'ok' | 'hang' | 'crash' | 'error'

class FakeChild extends EventEmitter implements ResidentChild {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  sent: Array<{ id: number; input: string; output: string; page: number | null }> = []
  ended = false
  exited = false
  constructor(
    readonly pid: number,
    readonly cmd: string,
    readonly args: string[],
    readonly env: NodeJS.ProcessEnv,
    private reply: () => Reply,
    /** what the driver says first: ready, or a start error */
    ready: boolean
  ) {
    super()
    setImmediate(() => (ready ? this.say({ ready: true, startup: 0.1 }) : (this.say({ error: 'soffice exited with 1 before it listened' }), this.exit(2))))
  }
  stdinEvents = new EventEmitter()
  stdin = {
    on: (event: 'error', fn: (err: Error) => void): void => void this.stdinEvents.on(event, fn),
    write: (s: string): void => {
      const job = JSON.parse(s) as FakeChild['sent'][number]
      this.sent.push(job)
      const r = this.reply()
      setImmediate(() => {
        if (r === 'ok') {
          writeFileSync(job.output, '%PDF fake')
          this.say({ id: job.id, ok: true, slides: 12, open: 0.2, export: 0.03 })
        } else if (r === 'error') this.say({ id: job.id, error: 'IOException: no such deck' })
        else if (r === 'crash') this.exit(null, 'SIGSEGV')
      })
    },
    end: (): void => {
      this.ended = true
      setImmediate(() => this.exit(0))
    }
  }
  say(obj: unknown): void {
    if (!this.exited) this.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`))
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, signal)
  }
}

let scratch: string
const scratches: string[] = []
afterEach(() => {
  for (const d of scratches.splice(0)) rmSync(d, { recursive: true, force: true })
})

function harness(o: { replies?: Reply[]; rss?: number; ready?: boolean[]; platform?: NodeJS.Platform } = {}) {
  scratch = mkdtempSync(join(tmpdir(), 'tc-resident-'))
  scratches.push(scratch)
  const folder = join(scratch, 'data', 'resident')
  const pipeRoot = join(scratch, 'tmp')
  mkdirSync(pipeRoot)
  const clock = new FakeClock()
  const children: FakeChild[] = []
  const kills: Array<[number, string]> = []
  const replies = [...(o.replies ?? [])]
  const readies = [...(o.ready ?? [])]
  const logs: string[] = []
  /** The pids still alive each time a new process was started: empty when no two ever ran at once. */
  const spawnedWhileAlive: number[] = []
  const soffice = '/opt/lo/program/soffice'
  const deps: ResidentDeps = {
    soffice: () => soffice,
    folder,
    platform: o.platform ?? 'linux',
    clock,
    pipeRoot,
    uid: 1000,
    exists: (p) => p === '/opt/lo/program/python' || existsSync(p),
    rss: async () => o.rss ?? 300 * 1024 ** 2,
    log: (l) => logs.push(l),
    kill: (pid, sig) => {
      kills.push([pid, sig])
      const c = children.find((x) => x.pid === pid)
      setImmediate(() => c?.exit(null, sig))
    },
    spawn: (cmd, args, opts) => {
      for (const alive of children.filter((x) => !x.exited)) spawnedWhileAlive.push(alive.pid)
      const c = new FakeChild(100 + children.length, cmd, args, opts.env, () => replies.shift() ?? 'ok', readies.shift() ?? true)
      children.push(c)
      return c
    }
  }
  const resident = createResident(deps)
  const out = (name: string): string => join(scratch, `${name}.pdf`)
  return { resident, clock, children, kills, folder, pipeRoot, logs, out, spawnedWhileAlive }
}

const rejection = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p
  } catch (err) {
    return err as Error
  }
  throw new Error('it resolved')
}

describe('the resident LibreOffice, with a fake process', () => {
  it('starts once for many jobs and runs them one at a time, in order', async () => {
    const h = harness()
    const jobs = [h.resident.slide('/in/a.pptx', 1, h.out('a')), h.resident.slide('/in/a.pptx', 6, h.out('b')), h.resident.deck('/in/b.pptx', h.out('c'))]
    expect(h.resident.state()).toMatchObject({ phase: 'starting', queued: 2 })
    await flush()
    // The second is not sent before the first is answered.
    const results = await Promise.all(jobs)
    expect(h.children).toHaveLength(1)
    expect(h.children[0].sent.map((j) => [j.input, j.page])).toEqual([
      ['/in/a.pptx', 1],
      ['/in/a.pptx', 6],
      ['/in/b.pptx', null]
    ])
    expect(results[0]).toEqual({ slides: 12, openMs: 200, exportMs: 30 })
    for (const n of ['a', 'b', 'c']) expect(readFileSync(h.out(n), 'utf8')).toBe('%PDF fake')
    // Written beside the output under another name, then moved in: no part file is left.
    expect(readdirSync(scratch).filter((f) => f.includes('.part-'))).toEqual([])
    expect(h.resident.state()).toMatchObject({ phase: 'idle', pid: 100, queued: 0 })
  })

  it('sends a job only once the one before it is answered', async () => {
    const h = harness({ replies: ['hang'] })
    void h.resident.slide('/in/a.pptx', 1, h.out('a')).catch(() => {})
    const second = h.resident.slide('/in/a.pptx', 2, h.out('b'))
    await flush()
    expect(h.children[0].sent).toHaveLength(1)
    expect(h.resident.state()).toMatchObject({ phase: 'busy', queued: 1 })
    await h.clock.advance(JOB_MS)
    await second
    expect(h.children[1].sent.map((j) => j.page)).toEqual([2])
  })

  it('kills the tree when a job has no answer in 10 s, rejects it as unavailable, and starts afresh for the next', async () => {
    const h = harness({ replies: ['hang'] })
    const job = rejection(h.resident.slide('/in/a.pptx', 3, h.out('a')))
    await flush()
    await h.clock.advance(JOB_MS - 1)
    expect(h.kills).toEqual([])
    await h.clock.advance(1)
    const err = await job
    expect(err).toBeInstanceOf(ResidentUnavailable)
    expect((err as ResidentUnavailable).reason).toBe('timeout')
    expect(h.kills).toEqual([[100, 'SIGKILL']])
    expect(existsSync(h.out('a'))).toBe(false)
    await flush()
    expect(h.resident.state().phase).toBe('off')
    await h.resident.slide('/in/a.pptx', 3, h.out('b'))
    expect(h.children).toHaveLength(2)
    expect(h.children[1].sent).toHaveLength(1)
  })

  it('rejects the job in hand as unavailable when the process crashes, and starts afresh for the next', async () => {
    const h = harness({ replies: ['crash'] })
    const err = await rejection(h.resident.slide('/in/a.pptx', 2, h.out('a')))
    expect(err).toBeInstanceOf(ResidentUnavailable)
    expect((err as ResidentUnavailable).reason).toBe('crash')
    expect(h.resident.state().phase).toBe('off')
    await h.resident.slide('/in/a.pptx', 2, h.out('b'))
    expect(h.children).toHaveLength(2)
  })

  it("survives an EPIPE on the driver's stdin: the exit tells the job", async () => {
    const h = harness({ replies: ['hang'] })
    const job = rejection(h.resident.slide('/in/a.pptx', 1, h.out('a')))
    await flush()
    // An EventEmitter throws an 'error' nobody listens for: this one is heard.
    expect(() => h.children[0].stdinEvents.emit('error', new Error('write EPIPE'))).not.toThrow()
    h.children[0].exit(null, 'SIGSEGV')
    expect(((await job) as ResidentUnavailable).reason).toBe('crash')
  })

  it("rejects a job LibreOffice could not draw as unavailable and keeps the process", async () => {
    const h = harness({ replies: ['error'] })
    const err = await rejection(h.resident.slide('/in/a.pptx', 2, h.out('a')))
    expect((err as ResidentUnavailable).reason).toBe('failed')
    expect(err.message).toContain('no such deck')
    await h.resident.slide('/in/a.pptx', 2, h.out('b'))
    expect(h.children).toHaveLength(1)
    expect(h.kills).toEqual([])
  })

  it('rejects as unavailable when the driver cannot start soffice, the jobs behind it too, and tries again on a later job', async () => {
    const h = harness({ ready: [false] })
    const a = h.resident.slide('/in/a.pptx', 1, h.out('a'))
    const b = h.resident.slide('/in/a.pptx', 2, h.out('b'))
    for (const p of [a, b]) {
      const err = await rejection(p)
      expect((err as ResidentUnavailable).reason).toBe('start')
    }
    expect(h.children).toHaveLength(1)
    await h.resident.slide('/in/a.pptx', 1, h.out('c'))
    expect(h.children).toHaveLength(2)
  })

  it('kills a driver that does not listen within the start limit', async () => {
    const h = harness()
    const job = rejection(h.resident.slide('/in/a.pptx', 1, h.out('a')))
    // The ready line never comes.
    h.children[0].say = () => {}
    await h.clock.advance(START_MS)
    const err = await job
    expect((err as ResidentUnavailable).reason).toBe('start')
    expect(h.kills).toEqual([[100, 'SIGKILL']])
  })

  it('stops after ten idle minutes, and a later job starts it again', async () => {
    const h = harness()
    await h.resident.slide('/in/a.pptx', 1, h.out('a'))
    await flush()
    await h.clock.advance(IDLE_MS - 1)
    expect(h.children[0].ended).toBe(false)
    // A job inside the ten minutes starts the count again.
    await h.resident.slide('/in/a.pptx', 1, h.out('b'))
    await flush()
    await h.clock.advance(IDLE_MS - 1)
    expect(h.children[0].ended).toBe(false)
    await h.clock.advance(1)
    // Asked to end soffice itself (stdin closed), not killed.
    expect(h.children[0].ended).toBe(true)
    expect(h.kills).toEqual([])
    expect(h.resident.state()).toMatchObject({ phase: 'off', pid: null })
    await h.resident.slide('/in/a.pptx', 1, h.out('c'))
    expect(h.children).toHaveLength(2)
  })

  it('stops past the memory cap once the job is done, without failing the job', async () => {
    const h = harness({ rss: MEMORY_CAP + 1 })
    await expect(h.resident.slide('/in/a.pptx', 1, h.out('a'))).resolves.toMatchObject({ slides: 12 })
    await flush()
    expect(h.children[0].ended).toBe(true)
    expect(h.logs.some((l) => l.includes('past the cap'))).toBe(true)
    await h.resident.slide('/in/a.pptx', 1, h.out('b'))
    expect(h.children).toHaveLength(2)
  })

  it('keeps running under the cap', async () => {
    const h = harness({ rss: MEMORY_CAP - 1 })
    await h.resident.slide('/in/a.pptx', 1, h.out('a'))
    await flush()
    expect(h.children[0].ended).toBe(false)
  })

  it('kills a driver that does not end within the stop limit', async () => {
    const h = harness()
    await h.resident.slide('/in/a.pptx', 1, h.out('a'))
    h.children[0].stdin.end = () => {}
    const stopped = h.resident.stop()
    await flush()
    expect(h.kills).toEqual([])
    await h.clock.advance(STOP_MS)
    await stopped
    expect(h.kills).toEqual([[100, 'SIGKILL']])
  })

  it('stop() ends an idle process, rejects the jobs waiting and the one in hand, and a later job starts it again', async () => {
    const h = harness()
    await h.resident.stop()
    expect(h.children).toHaveLength(0)
    await h.resident.slide('/in/a.pptx', 1, h.out('a'))
    await h.resident.stop()
    expect(h.children[0].ended).toBe(true)
    expect(h.resident.state().phase).toBe('off')

    const h2 = harness({ replies: ['hang'] })
    const inHand = h2.resident.slide('/in/a.pptx', 1, h2.out('a'))
    const waiting = h2.resident.slide('/in/a.pptx', 2, h2.out('b'))
    await flush()
    await h2.resident.stop()
    for (const p of [inHand, waiting]) {
      const err = await rejection(p)
      expect((err as ResidentUnavailable).reason).toBe('stopped')
    }
    // UNO cannot cancel the job in hand: the tree is killed.
    expect(h2.kills).toEqual([[100, 'SIGKILL']])
    expect(h2.children[0].sent).toHaveLength(1)
    await h2.resident.slide('/in/a.pptx', 3, h2.out('c'))
    expect(h2.children).toHaveLength(2)
  })

  it('drops a job cancelled while it waits, without touching the process', async () => {
    const h = harness({ replies: ['hang'] })
    const first = rejection(h.resident.slide('/in/a.pptx', 1, h.out('a')))
    const ac = new AbortController()
    const second = h.resident.slide('/in/a.pptx', 2, h.out('b'), ac.signal)
    await flush()
    ac.abort()
    const err = await rejection(second)
    expect(err.name).toBe('AbortError')
    expect(h.resident.state().queued).toBe(0)
    expect(h.kills).toEqual([])
    await h.clock.advance(JOB_MS)
    await first
    // The cancelled job was never sent.
    expect(h.children.flatMap((c) => c.sent.map((j) => j.page))).toEqual([1])
    // An already-cancelled signal starts nothing.
    const done = new AbortController()
    done.abort()
    expect((await rejection(h.resident.slide('/in/a.pptx', 1, h.out('c'), done.signal))).name).toBe('AbortError')
  })

  it('answers a job cancelled while it runs at once, lets it run out and drops its picture; the process stays for the next', async () => {
    const h = harness({ replies: ['hang'] })
    const ac = new AbortController()
    const job = h.resident.slide('/in/a.pptx', 1, h.out('a'), ac.signal)
    const next = h.resident.slide('/in/a.pptx', 2, h.out('b'))
    await flush()
    expect(h.children[0].sent).toHaveLength(1)
    ac.abort()
    expect((await rejection(job)).name).toBe('AbortError')
    // UNO cannot cancel it, and a kill would cost the next job a start: nothing is killed, and the next job waits its turn.
    expect(h.kills).toEqual([])
    expect(h.children[0].sent).toHaveLength(1)
    const sent = h.children[0].sent[0]
    writeFileSync(sent.output, '%PDF late')
    h.children[0].say({ id: sent.id, ok: true, slides: 12, open: 0.2, export: 0.03 })
    await next
    expect(h.children).toHaveLength(1)
    expect(h.children[0].sent.map((j) => j.page)).toEqual([1, 2])
    // The cancelled job's picture was dropped, part file and all.
    expect([existsSync(h.out('a')), existsSync(sent.output)]).toEqual([false, false])
  })

  it('kills the process when a cancelled job never answers, as any job that hangs', async () => {
    const h = harness({ replies: ['hang'] })
    const ac = new AbortController()
    const job = h.resident.slide('/in/a.pptx', 1, h.out('a'), ac.signal)
    await flush()
    ac.abort()
    expect((await rejection(job)).name).toBe('AbortError')
    await h.clock.advance(JOB_MS)
    expect(h.kills).toEqual([[100, 'SIGKILL']])
    await h.resident.slide('/in/a.pptx', 1, h.out('b'))
    expect(h.children).toHaveLength(2)
  })

  it('a job asked while the old process is still ending waits for it: two never share the profile', async () => {
    const h = harness()
    await h.resident.slide('/in/a.pptx', 1, h.out('a'))
    const stopping = h.resident.stop()
    const next = h.resident.slide('/in/a.pptx', 2, h.out('b'))
    // Asked to end, not gone yet: nothing new has started.
    expect(h.children).toHaveLength(1)
    expect(h.children[0].exited).toBe(false)
    await next
    await stopping
    expect(h.children).toHaveLength(2)
    expect(h.children[0].exited).toBe(true)
    expect(h.spawnedWhileAlive).toEqual([])
  })

  it('sweeps its own dangling pipe links at the next start, and no one else\'s', async () => {
    const h = harness()
    mkdirSync(h.folder, { recursive: true })
    const dead = join(h.pipeRoot, 'OSL_PIPE_1000_tcrdead')
    const theirs = join(h.pipeRoot, 'OSL_PIPE_1000_tcrtheirs')
    const other = join(h.pipeRoot, 'OSL_PIPE_1000_soffice')
    symlinkSync(join(h.folder, 'pipe-tcrdead'), dead)
    symlinkSync(join(scratch, 'elsewhere'), theirs)
    writeFileSync(other, '')
    await h.resident.slide('/in/a.pptx', 1, h.out('a'))
    const left = readdirSync(h.pipeRoot)
    expect(left).not.toContain('OSL_PIPE_1000_tcrdead')
    expect(left).toEqual(expect.arrayContaining(['OSL_PIPE_1000_tcrtheirs', 'OSL_PIPE_1000_soffice']))
  })

  it('keeps the process when a job is cancelled while it starts, before anything was sent', async () => {
    const h = harness()
    const ac = new AbortController()
    const job = h.resident.slide('/in/a.pptx', 1, h.out('a'), ac.signal)
    ac.abort()
    expect((await rejection(job)).name).toBe('AbortError')
    expect(h.kills).toEqual([])
    expect(h.children[0].sent).toEqual([])
    expect(h.resident.state().phase).toBe('idle')
  })

  it('puts the pipe in a 0700 folder under its own, reached through a link where LibreOffice looks, and removes both at the end', async () => {
    const h = harness()
    await h.resident.slide('/in/a.pptx', 1, h.out('a'))
    const c = h.children[0]
    expect(statSync(h.folder).mode & 0o777).toBe(0o700)
    const pipes = readdirSync(h.folder).filter((f) => f.startsWith('pipe-'))
    expect(pipes).toHaveLength(1)
    const pipeDir = join(h.folder, pipes[0])
    expect(statSync(pipeDir).mode & 0o777).toBe(0o700)
    const tag = pipes[0].slice('pipe-'.length)
    expect(tag).toMatch(/^tcr[0-9a-f]{24}$/)
    const link = join(h.pipeRoot, `OSL_PIPE_1000_${tag}`)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(pipeDir)
    // argv: [-s, -P, script, soffice argv, pipe name, start seconds]
    expect(c.args[4]).toBe(`${tag}/s`)
    const soffice = JSON.parse(c.args[3]) as string[]
    expect(soffice).toContain(`--accept=pipe,name=${tag}/s;urp;StarOffice.ComponentContext`)
    expect(soffice.join(' ')).not.toMatch(/socket|port=/)
    await h.resident.stop()
    await flush()
    expect(existsSync(link)).toBe(false)
    expect(existsSync(pipeDir)).toBe(false)
  })

  it('removes the pipe folder of a run that died with the app at the next start', async () => {
    const h = harness()
    mkdirSync(join(h.folder, 'pipe-tcrold'), { recursive: true })
    await h.resident.slide('/in/a.pptx', 1, h.out('a'))
    expect(existsSync(join(h.folder, 'pipe-tcrold'))).toBe(false)
  })

  it("runs LibreOffice's own Python on the driver, with the hardened profile and options every LibreOffice job gets", async () => {
    const prior = process.env.PYTHONPATH
    process.env.PYTHONPATH = '/planted'
    try {
      const h = harness()
      await h.resident.slide('/in/a.pptx', 1, h.out('a'))
      const c = h.children[0]
      expect(c.cmd).toBe('/opt/lo/program/python')
      expect(c.args.slice(0, 2)).toEqual(['-s', '-P'])
      expect(c.args[2]).toBe(join(h.folder, 'resident.py'))
      expect(readFileSync(join(h.folder, 'resident.py'), 'utf8')).toBe(RESIDENT_PY)
      const soffice = JSON.parse(c.args[3]) as string[]
      expect(soffice.slice(0, 2)).toEqual(['/opt/lo/program/soffice', `-env:UserInstallation=file://${join(h.folder, 'profile')}`])
      expect(soffice).toEqual(expect.arrayContaining(['--headless', '--norestore', '--nologo', '--nodefault']))
      const xcu = readFileSync(join(h.folder, 'profile', 'user', 'registrymodifications.xcu'), 'utf8')
      expect(xcu).toContain('DisableMacrosExecution')
      expect(c.env.PYTHONPATH).toBeUndefined()
    } finally {
      if (prior === undefined) delete process.env.PYTHONPATH
      else process.env.PYTHONPATH = prior
    }
  })

  it('opens each deck hidden, read-only, with macros never run, keeps hidden slides in the export, and closes it', () => {
    expect(RESIDENT_PY).toContain('Hidden=True, ReadOnly=True')
    expect(RESIDENT_PY).toContain("MacroExecutionMode=uno.Any('short', 0)")
    expect(RESIDENT_PY).toContain("{'ExportHiddenSlides': True}")
    expect(RESIDENT_PY).toContain('doc.close(True)')
    expect(RESIDENT_PY).not.toMatch(/socket,|port=/)
  })

  it('refuses a slide that is not a whole number from 1', async () => {
    const h = harness()
    for (const page of [0, -1, 1.5]) expect(await rejection(h.resident.slide('/in/a.pptx', page, h.out('a')))).toBeInstanceOf(RangeError)
    expect(h.children).toHaveLength(0)
  })

  it('is unavailable on Windows and starts nothing', async () => {
    const h = harness({ platform: 'win32' })
    const err = await rejection(h.resident.slide('/in/a.pptx', 1, h.out('a')))
    expect((err as ResidentUnavailable).reason).toBe('unsupported')
    expect(h.resident.state()).toEqual({ phase: 'unsupported', pid: null, queued: 0 })
    expect(h.children).toHaveLength(0)
  })

  it('is unavailable when LibreOffice is not installed', async () => {
    const h = harness()
    const r = createResident({ soffice: () => null, folder: h.folder })
    expect(((await rejection(r.slide('/in/a.pptx', 1, h.out('a')))) as ResidentUnavailable).reason).toBe('start')
  })
})

describe('the helpers', () => {
  it("finds LibreOffice's bundled Python beside soffice on Linux and in the macOS app", () => {
    expect(bundledPython('/t/libreoffice/26.8.3/opt/libreoffice26.8/program/soffice', 'linux')).toBe('/t/libreoffice/26.8.3/opt/libreoffice26.8/program/python')
    expect(bundledPython('/t/LibreOffice.app/Contents/MacOS/soffice', 'darwin')).toBe('/t/LibreOffice.app/Contents/Resources/python')
    expect(bundledPython('C:\\lo\\program\\soffice.exe', 'win32')).toBeNull()
  })

  it("sums a process group's resident memory from ps", () => {
    expect(sumGroupRss('  100  2048\n  101  1024\n 7 99999\n100 1\n', 100)).toBe((2048 + 1) * 1024)
    expect(sumGroupRss('', 100)).toBe(0)
  })
})

// ── the real thing ───────────────────────────────────────────────────

const DATA = process.env.TEMP_CODE_WORK_TOOLS_DATA
const HIDDEN = 3
/** view.ts's RENDER_FILTER, as the canvas draws a deck today: hidden slides kept, so the pages line up. */
const CLI_FILTER = 'impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'

/** A deck of `n` slides, each its own words and shapes; slide HIDDEN is hidden. */
async function scaleDeck(n: number): Promise<Buffer> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  for (let i = 1; i <= n; i++) {
    const s = pptx.addSlide()
    s.addText(`Edit target ${String(i).padStart(3, '0')}`, { x: 0.55, y: 0.36, w: 12, h: 0.7, fontFace: 'Calibri', fontSize: 32 })
    s.addShape(pptx.ShapeType.rect, { x: 0.65, y: 1.7, w: 4.8, h: 3.8, fill: { color: '225B8B' } })
    s.addShape(pptx.ShapeType.ellipse, { x: 6.6 + (i % 5) * 0.3, y: 1.7, w: 3.8, h: 3.8, fill: { color: 'E26A20' }, rotate: (i * 13) % 90 })
    for (let j = 0; j < 4; j++) s.addText(`Text row ${j + 1} of slide ${i}`, { x: 0.95, y: 2.0 + j * 0.65, w: 4.2, h: 0.6, fontFace: 'Calibri', fontSize: 21, color: 'FFFFFF' })
  }
  const zip = await JSZip.loadAsync((await pptx.write({ outputType: 'nodebuffer' })) as Buffer)
  const name = `ppt/slides/slide${HIDDEN}.xml`
  const xml = await zip.file(name)!.async('string')
  zip.file(name, xml.replace('<p:sld ', '<p:sld show="0" '))
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** PyMuPDF: each pair's pages rasterised at 1920 wide and compared sample by sample. */
const COMPARE_PY = String.raw`
import json, sys
import pymupdf
out = []
for a, pa, b, pb in json.loads(sys.argv[1]):
    def pix(path, page):
        with pymupdf.open(path) as doc:
            p = doc[page - 1]
            z = 1920 / p.rect.width
            m = p.get_pixmap(matrix=pymupdf.Matrix(z, z), alpha=False)
            return (m.width, m.height, bytes(m.samples), len(doc))
    wa, ha, sa, na = pix(a, pa)
    wb, hb, sb, nb = pix(b, pb)
    if (wa, ha) != (wb, hb):
        diff = -1
    elif sa == sb:
        diff = 0
    else:
        diff = sum(1 for i in range(0, len(sa), 3) if sa[i:i+3] != sb[i:i+3])
    # samples that are not white: something was drawn
    ink = len(sa) - sa.count(255)
    out.append({'size': [wa, ha], 'pagesA': na, 'pagesB': nb, 'diff': diff, 'ink': ink})
print(json.dumps(out))
`

describe.skipIf(!DATA)('the resident LibreOffice, for real', () => {
  let dir: string
  let resident: ReturnType<typeof createResident>
  let runner: JobRunner
  let py: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-resident-real-'))
    const tools = new Toolchain(DATA!)
    py = tools.bin('pdf-tools')!
    resident = createResident({ soffice: () => tools.bin('libreoffice'), folder: join(dir, 'resident'), log: (l) => console.log(l) })
    runner = new JobRunner({ host: 'env_test', dataDir: DATA!, converters: convertersOf([{ id: 'formats', ensure() {}, convert: LIBREOFFICE_CONVERTERS }]), log: () => {} })
  })
  afterAll(async () => {
    await resident?.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  for (const n of [12, 50, 200]) {
    it(`draws one slide of the ${n}-slide deck equal to the same page of the whole deck, pixel for pixel, the hidden slide included`, async () => {
      const deck = join(dir, `scale-${n}.pptx`)
      writeFileSync(deck, await scaleDeck(n))
      const whole = join(dir, `whole-${n}.pdf`)
      const r = await resident.deck(deck, whole)
      expect(r.slides).toBe(n)
      // Today's path, a fresh LibreOffice for the whole deck: what the caller falls back to.
      const cli = (await runner.convert({ from: 'pptx', to: 'pdf', input: deck, output: join(dir, `cli-${n}.pdf`), options: { filter: CLI_FILTER } })).output
      const pages = [1, HIDDEN, Math.ceil(n / 2), n]
      const pairs: Array<[string, number, string, number]> = []
      for (const page of pages) {
        const one = join(dir, `one-${n}-${page}.pdf`)
        await expect(resident.slide(deck, page, one)).resolves.toMatchObject({ slides: n })
        pairs.push([one, 1, whole, page], [one, 1, cli, page])
      }
      const res = spawnSync(py, ['-I', '-c', COMPARE_PY, JSON.stringify(pairs)], { encoding: 'utf8', maxBuffer: 1 << 20 })
      expect(res.status, res.stderr).toBe(0)
      const rows = JSON.parse(res.stdout) as Array<{ size: number[]; pagesA: number; pagesB: number; diff: number; ink: number }>
      console.log(`[resident] ${n} slides:`, JSON.stringify(rows.map((x, i) => ({ page: pages[i >> 1], against: i % 2 ? 'cli' : 'resident deck', ...x }))))
      for (const row of rows) {
        expect(row.pagesA).toBe(1)
        expect(row.pagesB).toBe(n)
        expect(row.size[0]).toBe(1920)
        // Something was drawn, and every pixel matches.
        expect(row.ink).toBeGreaterThan(10_000)
        expect(row.diff).toBe(0)
      }
      await expect(resident.slide(deck, n + 1, join(dir, 'past.pdf'))).rejects.toMatchObject({ reason: 'failed' })
    }, 180_000)
  }

  it('leaves no LibreOffice of its own once stopped', async () => {
    const pid = resident.state().pid
    expect(pid).toBeTypeOf('number')
    await resident.stop()
    const ps = spawnSync('ps', ['-A', '-o', 'pgid=,args='], { encoding: 'utf8' }).stdout
    expect(ps.split('\n').filter((l) => Number(l.trim().split(/\s+/)[0]) === pid)).toEqual([])
    expect(ps).not.toContain(join(dir, 'resident'))
  })
})
