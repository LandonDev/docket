import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SlideOp } from '@shared/contract-work-slides'
import type { ConvertRun } from '../formats/jobs'
import { Toolchain, type RunResult } from '../formats/tools'
import { SLIDES_CONVERTERS, splitStep, type DeckInfo } from './deck'
import { createDeckResident, DeckRefused, DeckResidentUnavailable, IDLE_MS, JOB_MS, MEMORY_CAP, scriptIn, slideAlone, soloDeck, START_MS, STOP_MS, stopDeckResident, WAIT_MS, type Clock, type DeckChild, type DeckResident, type DeckResidentDeps, setDeckToolHome } from './deckResident'
import { DECK_PY } from './deckScript'
import { splitPdf, stitchPdf } from './pictures'
import { createResident, type Resident } from './resident'

/**
 * The deck tool kept running (deckResident.ts): its life against a fake
 * process always, and deck.ts's use of it against a stand-in written in
 * shell; behind TEMP_CODE_WORK_TOOLS_DATA (a userData whose toolchain has
 * python-pptx, `/srv/agents/temp-code-data` on the box) a run of edits
 * through the real tool, each against one run of the tool the old way.
 */

// ── the fake ─────────────────────────────────────────────────────────

class FakeClock implements Clock {
  t = 0
  private timers: Array<{ at: number; fn: () => void; id: number }> = []
  private n = 0
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

type Reply = 'ok' | 'hang' | 'slow' | 'crash' | 'error' | 'refused' | 'fat' | 'stale' | 'said'

class FakeChild extends EventEmitter implements DeckChild {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  sent: Array<{ id: number; argv: string[] }> = []
  /** what went in and what came out, in order: `in 1`, `out 1` */
  order: string[] = []
  ended = false
  exited = false
  /** answers the `slow` job in hand */
  finish: () => void = () => {}
  constructor(
    readonly pid: number,
    readonly cmd: string,
    readonly args: string[],
    private reply: () => Reply,
    /** what it does first: says it is ready, exits, or says nothing */
    start: 'ready' | 'exit' | 'silent'
  ) {
    super()
    setImmediate(() => {
      if (start === 'ready') this.say({ ready: true })
      else if (start === 'exit') {
        this.stderr.emit('data', Buffer.from('ModuleNotFoundError: No module named pptx\n'))
        this.exit(1)
      }
    })
  }
  stdin = {
    on: (): void => {},
    write: (s: string): void => {
      const job = JSON.parse(s) as FakeChild['sent'][number]
      this.sent.push(job)
      this.order.push(`in ${job.id}`)
      const r = this.reply()
      setImmediate(() => {
        if (r === 'ok') this.say({ id: job.id, ok: true, peak: 80 * 1024 ** 2 })
        else if (r === 'said') this.say({ id: job.id, ok: true, said: { slides: 50 }, peak: 1 })
        else if (r === 'fat') this.say({ id: job.id, ok: true, peak: MEMORY_CAP + 1 })
        else if (r === 'refused') this.say({ id: job.id, refused: 'edit 1: there is no slide 999', peak: 1 })
        else if (r === 'error') this.say({ id: job.id, error: 'KeyError', peak: 1 })
        else if (r === 'stale') {
          // A line for a job long answered, a line that is no JSON, then the job's own.
          this.say({ id: job.id - 1, error: 'late' })
          this.stdout.emit('data', Buffer.from('not json\n'))
          this.say({ id: job.id, ok: true, peak: 1 })
        } else if (r === 'crash') this.exit(null, 'SIGSEGV')
        // slow: answered when the test says so
        else if (r === 'slow') this.finish = () => this.say({ id: job.id, ok: true, peak: 1 })
      })
    },
    end: (): void => {
      this.ended = true
      setImmediate(() => this.exit(0))
    }
  }
  say(obj: unknown): void {
    if (this.exited) return
    const id = (obj as { id?: number }).id
    if (id !== undefined) this.order.push(`out ${id}`)
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`))
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, signal)
  }
}

const scratches: string[] = []
const scratchDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'tc-deck-resident-'))
  scratches.push(d)
  return d
}
afterEach(() => {
  for (const d of scratches.splice(0)) rmSync(d, { recursive: true, force: true })
})

function harness(o: { replies?: Reply[]; starts?: Array<'ready' | 'exit' | 'silent'>; python?: string | null; deaf?: boolean; check?: boolean } = {}) {
  const folder = join(scratchDir(), 'run', 'deck-tool')
  const clock = new FakeClock()
  const children: FakeChild[] = []
  const kills: Array<[number, string]> = []
  const holds: Array<[number, boolean]> = []
  const logs: string[] = []
  const replies = [...(o.replies ?? [])]
  const starts = [...(o.starts ?? [])]
  const deps: DeckResidentDeps = {
    python: () => (o.python === undefined ? '/tools/venv/bin/python' : o.python),
    folder,
    clock,
    log: (l) => logs.push(l),
    hold: (child, on) => holds.push([(child as FakeChild).pid, on]),
    kill: (pid, sig) => {
      kills.push([pid, sig])
      const c = children.find((x) => x.pid === pid)
      setImmediate(() => c?.exit(null, sig))
    },
    spawn: (cmd, args) => {
      const c = new FakeChild(100 + children.length, cmd, args, () => replies.shift() ?? 'ok', starts.shift() ?? 'ready')
      // A child that will not end when its stdin does.
      if (o.deaf) c.stdin.end = () => void (c.ended = true)
      children.push(c)
      return c
    },
    ...(o.check ? { check: true } : {})
  }
  return { resident: createDeckResident(deps), clock, children, kills, holds, logs, folder }
}

const rejection = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p
  } catch (err) {
    return err as Error
  }
  throw new Error('it resolved')
}
const STEP = ['step', '/t/in.pptx', '/t/ops.json', '/t/out.pptx', '/t/warnings.json', '/t/back.pack', '/t/info.json']

describe('the deck tool kept running, with a fake process', () => {
  it('starts once for many jobs: the script the one-shot run uses, under -I, each job its arguments on a line', async () => {
    const h = harness()
    expect(h.resident.state()).toEqual({ phase: 'off', pid: null, queued: 0 })
    const first = h.resident.run(STEP)
    expect(h.resident.state()).toEqual({ phase: 'starting', pid: 100, queued: 0 })
    await first
    expect(h.resident.state()).toEqual({ phase: 'idle', pid: 100, queued: 0 })
    await h.resident.run(['apply', '/t/in.pptx', '/t/ops.json', '/t/out.pptx', '/t/warnings.json'])
    await h.resident.run(['unstep', '/t/now.pptx', '/t/in.pack', '/t/out.pptx', '/t/back.pack', '/t/info.json'])
    expect(h.children).toHaveLength(1)
    const [child] = h.children
    expect(child.cmd).toBe('/tools/venv/bin/python')
    expect(child.args).toEqual(['-I', scriptIn(h.folder), 'serve'])
    expect(readFileSync(child.args[1], 'utf8')).toBe(DECK_PY)
    expect(statSync(h.folder).mode & 0o777).toBe(0o700)
    expect(statSync(child.args[1]).mode & 0o777).toBe(0o600)
    expect(child.sent.map((j) => j.argv[0])).toEqual(['step', 'apply', 'unstep'])
    expect(child.sent[0]).toEqual({ id: 1, argv: STEP })
    expect(h.kills).toEqual([])
  })

  it('takes one job at a time, in order: the next is not sent before the one in hand is answered', async () => {
    const h = harness()
    const jobs = [h.resident.run(STEP), h.resident.run(['solo', '/t/in.pptx', '3', '/t/solo.pptx']), h.resident.run(['unstep', '/t/now.pptx', '/t/in.pack', '/t/out.pptx', '/t/back.pack', '/t/info.json'])]
    expect(h.resident.state()).toMatchObject({ phase: 'starting', queued: 2 })
    await Promise.all(jobs)
    expect(h.children).toHaveLength(1)
    expect(h.children[0].sent.map((j) => j.argv[0])).toEqual(['step', 'solo', 'unstep'])
    expect(h.children[0].order).toEqual(['in 1', 'out 1', 'in 2', 'out 2', 'in 3', 'out 3'])
    expect(h.resident.state()).toMatchObject({ phase: 'idle', queued: 0 })
  })

  it('a job that has waited a second behind another is answered busy and nothing of it is sent; one that waits less runs', async () => {
    const h = harness({ replies: ['hang', 'ok'] })
    const hung = rejection(h.resident.run(STEP))
    await flush()
    const waited = rejection(h.resident.run(STEP))
    await h.clock.advance(WAIT_MS)
    const err = (await waited) as DeckResidentUnavailable
    expect(err).toBeInstanceOf(DeckResidentUnavailable)
    expect(err.reason).toBe('busy')
    expect(h.children[0].sent).toHaveLength(1)
    expect(h.resident.state().queued).toBe(0)
    // One that comes just before the hang is killed waits it out, then runs on a new process.
    await h.clock.advance(JOB_MS - WAIT_MS - 500)
    const patient = h.resident.run(['solo', '/t/in.pptx', '3', '/t/solo.pptx'])
    await h.clock.advance(500)
    expect(((await hung) as DeckResidentUnavailable).reason).toBe('timeout')
    await patient
    expect(h.children).toHaveLength(2)
    expect(h.children[1].sent.map((j) => j.argv[0])).toEqual(['solo'])
    expect(h.resident.state()).toMatchObject({ phase: 'idle', queued: 0 })
  })

  it('a job cancelled while it waits leaves the line, and the one behind it still runs', async () => {
    const h = harness()
    const first = h.resident.run(STEP)
    const gone = new AbortController()
    const cancelled = rejection(h.resident.run(STEP, gone.signal))
    const third = h.resident.run(['unstep', '/t/now.pptx', '/t/in.pack', '/t/out.pptx', '/t/back.pack', '/t/info.json'])
    gone.abort()
    expect((await cancelled).name).toBe('AbortError')
    await Promise.all([first, third])
    expect(h.children[0].sent.map((j) => j.argv[0])).toEqual(['step', 'unstep'])
  })

  it('stop tells every waiting job stopped', async () => {
    const h = harness({ replies: ['hang'] })
    const inHand = rejection(h.resident.run(STEP))
    const waiting = rejection(h.resident.run(STEP))
    await flush()
    await h.resident.stop()
    expect(((await inHand) as DeckResidentUnavailable).reason).toBe('stopped')
    expect(((await waiting) as DeckResidentUnavailable).reason).toBe('stopped')
    expect(h.children[0].sent).toHaveLength(1)
  })

  it('answers what the verb says: the slide count of a solo job', async () => {
    const h = harness({ replies: ['said'] })
    expect(await h.resident.run(['solo', '/t/in.pptx', '3', '/t/solo.pptx'])).toEqual({ slides: 50 })
    expect(await h.resident.run(STEP)).toBeUndefined()
  })

  it('a job with no answer in ten seconds: the tree is killed, the caller told, and the next job starts a new process', async () => {
    const h = harness({ replies: ['hang'] })
    const hung = rejection(h.resident.run(STEP))
    await flush()
    expect(h.resident.state().phase).toBe('busy')
    await h.clock.advance(JOB_MS - 1)
    expect(h.kills).toEqual([])
    await h.clock.advance(1)
    const err = await hung
    expect(err).toBeInstanceOf(DeckResidentUnavailable)
    expect((err as DeckResidentUnavailable).reason).toBe('timeout')
    expect(h.kills).toEqual([[100, 'SIGKILL']])
    expect(h.resident.state()).toMatchObject({ phase: 'off', pid: null })
    await h.resident.run(STEP)
    expect(h.children).toHaveLength(2)
    expect(h.children[1].sent).toHaveLength(1)
  })

  it('a crash in a job is told as a crash, and the next job starts afresh', async () => {
    const h = harness({ replies: ['crash'] })
    const err = await rejection(h.resident.run(STEP))
    expect((err as DeckResidentUnavailable).reason).toBe('crash')
    expect(err.message).toContain('SIGSEGV')
    // It was already gone: nothing to kill.
    expect(h.kills).toEqual([])
    await h.resident.run(STEP)
    expect(h.children).toHaveLength(2)
  })

  it('a start that fails is told as one, whatever the way: no Python, an exit before ready, no word in time', async () => {
    const none = harness({ python: null })
    expect((await rejection(none.resident.run(STEP))) as DeckResidentUnavailable).toMatchObject({ reason: 'start', message: 'python-pptx is not installed here.' })
    expect(none.children).toHaveLength(0)

    const exits = harness({ starts: ['exit'] })
    const err = (await rejection(exits.resident.run(STEP))) as DeckResidentUnavailable
    expect(err.reason).toBe('start')
    expect(err.message).toContain('No module named pptx')
    expect(exits.children[0].sent).toEqual([])
    // The next job tries again.
    await exits.resident.run(STEP)
    expect(exits.children).toHaveLength(2)

    const silent = harness({ starts: ['silent'] })
    const waiting = rejection(silent.resident.run(STEP))
    await silent.clock.advance(START_MS)
    expect(((await waiting) as DeckResidentUnavailable).reason).toBe('start')
    expect(silent.kills).toEqual([[100, 'SIGKILL']])
    expect(silent.resident.state().phase).toBe('off')
  })

  it("the tool's own refusal is its answer, in its words, and the process stays", async () => {
    const h = harness({ replies: ['refused'] })
    const err = await rejection(h.resident.run(STEP))
    expect(err).toBeInstanceOf(DeckRefused)
    expect(err.message).toBe('edit 1: there is no slide 999')
    await h.resident.run(STEP)
    expect(h.children).toHaveLength(1)
    expect(h.kills).toEqual([])
  })

  it('an error that is not the tool’s own word is failed, for the caller to run the old way; the process stays', async () => {
    const h = harness({ replies: ['error'] })
    const err = (await rejection(h.resident.run(STEP))) as DeckResidentUnavailable
    expect(err).toBeInstanceOf(DeckResidentUnavailable)
    expect(err.reason).toBe('failed')
    expect(err.message).toContain('KeyError')
    await h.resident.run(STEP)
    expect(h.children).toHaveLength(1)
  })

  it('with check on, a failed job is an error nobody runs the old way', async () => {
    const h = harness({ replies: ['error'], check: true })
    expect(h.children).toHaveLength(0)
    const err = await rejection(h.resident.run(STEP))
    expect(h.children[0].args.slice(-2)).toEqual(['serve', 'check'])
    expect(err).not.toBeInstanceOf(DeckResidentUnavailable)
    expect(err.message).toContain('KeyError')
  })

  it('answers a job by its own line: a late line for another job and a line that is no JSON are passed over', async () => {
    const h = harness({ replies: ['ok', 'stale'] })
    await h.resident.run(STEP)
    await h.resident.run(STEP)
    expect(h.children[0].sent).toHaveLength(2)
  })

  it('a job cancelled while it runs is answered at once and runs out: no kill, its answer dropped, and the next job waits for it', async () => {
    const h = harness({ replies: ['slow', 'ok'] })
    const gone = new AbortController()
    const running = rejection(h.resident.run(STEP, gone.signal))
    await flush()
    gone.abort()
    expect((await running).name).toBe('AbortError')
    expect(h.kills).toEqual([])
    // The tool still has it in hand: the next job is not sent yet.
    const next = h.resident.run(['solo', '/t/in.pptx', '3', '/t/solo.pptx'])
    await flush()
    expect(h.resident.state()).toMatchObject({ phase: 'busy', queued: 1 })
    expect(h.children[0].sent).toHaveLength(1)
    h.children[0].finish()
    await next
    expect(h.children).toHaveLength(1)
    expect(h.children[0].order).toEqual(['in 1', 'out 1', 'in 2', 'out 2'])
    expect(h.kills).toEqual([])
  })

  it('a cancelled job that never answers is killed at ten seconds like any other, and the next runs on a new process', async () => {
    const h = harness({ replies: ['hang'] })
    const gone = new AbortController()
    const running = rejection(h.resident.run(STEP, gone.signal))
    await flush()
    gone.abort()
    expect((await running).name).toBe('AbortError')
    await h.clock.advance(JOB_MS)
    expect(h.kills).toEqual([[100, 'SIGKILL']])
    await h.resident.run(STEP)
    expect(h.children).toHaveLength(2)
  })

  it('a job cancelled before it starts, or while the tool starts, sends nothing', async () => {
    const h = harness()
    const before = new AbortController()
    before.abort()
    expect((await rejection(h.resident.run(STEP, before.signal))).name).toBe('AbortError')
    expect(h.children).toHaveLength(0)

    const early = new AbortController()
    const startingUp = rejection(h.resident.run(STEP, early.signal))
    early.abort()
    expect((await startingUp).name).toBe('AbortError')
    // The new process was not sent the job, and stays for the next.
    expect(h.children).toHaveLength(1)
    expect(h.children[0].sent).toEqual([])
    await h.resident.run(STEP)
    expect(h.children).toHaveLength(1)
    expect(h.kills).toEqual([])
  })

  it('is stopped after thirty idle minutes by the end of its stdin, counted from the last job, and starts again for the next', async () => {
    const h = harness()
    await h.resident.run(STEP)
    await h.clock.advance(IDLE_MS - 1000)
    await h.resident.run(STEP)
    await h.clock.advance(IDLE_MS - 1000)
    expect(h.children[0].ended).toBe(false)
    await h.clock.advance(1000)
    expect(h.children[0].ended).toBe(true)
    expect(h.resident.state()).toMatchObject({ phase: 'off', pid: null })
    expect(h.kills).toEqual([])
    await h.resident.run(STEP)
    expect(h.children).toHaveLength(2)
  })

  it('past the memory cap it is stopped once the job is done: the job still answers, the next starts a new process', async () => {
    const h = harness({ replies: ['fat'] })
    await h.resident.run(STEP)
    expect(h.children[0].ended).toBe(true)
    expect(h.resident.state().phase).toBe('off')
    expect(h.logs.some((l) => l.includes('past the cap'))).toBe(true)
    await h.resident.run(STEP)
    expect(h.children).toHaveLength(2)
  })

  it('stop: idle, its stdin ends, and the tree is killed when that is not enough; in a job, killed and the job told stopped', async () => {
    const idle = harness()
    await idle.resident.run(STEP)
    await idle.resident.stop()
    expect(idle.children[0].ended).toBe(true)
    expect(idle.kills).toEqual([])
    // Nothing to stop is no error.
    await idle.resident.stop()

    const deaf = harness({ deaf: true })
    await deaf.resident.run(STEP)
    const stopping = deaf.resident.stop()
    await deaf.clock.advance(STOP_MS)
    await stopping
    expect(deaf.kills).toEqual([[100, 'SIGKILL']])

    const mid = harness({ replies: ['hang'] })
    const running = rejection(mid.resident.run(STEP))
    await flush()
    await mid.resident.stop()
    expect(((await running) as DeckResidentUnavailable).reason).toBe('stopped')
    expect(mid.kills).toEqual([[100, 'SIGKILL']])
    await mid.resident.run(STEP)
    expect(mid.children).toHaveLength(2)
  })

  it('holds the app open only while a job is in hand', async () => {
    const h = harness()
    await h.resident.run(STEP)
    await h.resident.run(STEP)
    expect(h.holds).toEqual([
      [100, true],
      [100, false],
      [100, true],
      [100, false]
    ])
  })
})

describe('the script in its folder', () => {
  it('is written once under a name its bytes give it, and an old one of another build is swept after a day', () => {
    const folder = join(scratchDir(), 'deck-tool')
    const script = scriptIn(folder)
    expect(script).toMatch(/deck-[0-9a-f]{16}\.py$/)
    const made = statSync(script).mtimeMs
    const other = join(folder, 'deck-0123456789abcdef.py')
    const fresh = join(folder, 'deck-fedcba9876543210.py')
    const notOurs = join(folder, 'notes.txt')
    for (const f of [other, fresh, notOurs]) writeFileSync(f, 'x')
    const old = new Date(Date.now() - 25 * 60 * 60_000)
    utimesSync(other, old, old)
    utimesSync(notOurs, old, old)
    expect(scriptIn(folder)).toBe(script)
    expect(statSync(script).mtimeMs).toBe(made)
    expect(readdirSync(folder).sort()).toEqual([script, fresh, notOurs].map((p) => p.slice(folder.length + 1)).sort())
  })
})

// ── deck.ts's use of it ──────────────────────────────────────────────

/**
 * A stand-in for the tool in shell: `serve` answers every job with `answer` (`die`: it ends without one); any other
 * verb is the one-shot run, which leaves its mark and what a step writes.
 */
const standIn = (dir: string, answer: string): string => {
  const path = join(dir, 'python')
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$3" = serve ]; then
  echo '{"ready": true}'
  while read -r line; do
    id=$(printf '%s' "$line" | sed 's/^{"id":\\([0-9]*\\).*/\\1/')
    case '${answer}' in die) exit 3 ;; esac
    printf '{"id": %s, %s}\\n' "$id" '${answer}'
  done
  exit 0
fi
echo "$3" >> '${dir}/one-shot'
[ "$3" = step ] || exit 0
printf '[]' > "$7"
for f in "$6" "$8" "$9"; do printf x > "$f"; done
`
  )
  chmodSync(path, 0o755)
  return path
}

describe.skipIf(process.platform === 'win32')('an edit in deck.ts, on a stand-in for the tool', () => {
  const step = SLIDES_CONVERTERS.find((c) => c.from === 'pptx' && c.to === 'pptxstep')!
  const inspect = SLIDES_CONVERTERS.find((c) => c.to === 'deckinfo')!
  const dirs: string[] = []
  afterAll(async () => {
    for (const d of dirs) {
      await stopDeckResident(d)
      rmSync(d, { recursive: true, force: true })
    }
  })
  const setup = (answer: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-deck-standin-'))
    dirs.push(dir)
    const py = standIn(dir, answer)
    setDeckToolHome(dir)
    const tmp = join(dir, 'tmp')
    mkdirSync(tmp)
    const runs: string[][] = []
    const run: ConvertRun = {
      tools: Object.assign(new Toolchain(dir), { bin: () => py }),
      threads: 1,
      slot: 0,
      tmp,
      signal: new AbortController().signal,
      run: async (cmd, args): Promise<RunResult> => {
        runs.push(args)
        const r = spawnSync(cmd, args, { encoding: 'utf8' })
        return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` }
      }
    }
    const input = join(dir, 'in.pptx')
    writeFileSync(input, 'deck')
    const job = { from: 'pptx', to: 'pptxstep', input, output: join(dir, 'out.bin'), options: { ops: [{ op: 'notes', slide: 256, text: 'x' }] } }
    const oneShots = (): string[] => (existsSync(join(dir, 'one-shot')) ? readFileSync(join(dir, 'one-shot'), 'utf8').trim().split('\n') : [])
    return { dir, run, runs, job, oneShots }
  }

  it("the resident's refusal is the edit's error, in the tool's words, and the tool is not run again", async () => {
    const s = setup('"refused": "edit 1: there is no slide 256"')
    await expect(step.run(s.job, s.run)).rejects.toThrow('edit 1: there is no slide 256')
    expect(s.runs).toEqual([])
  })

  it('an error of the resident that is not the tool’s word, and a resident that dies, are each one run the old way', async () => {
    const failed = setup('"error": "KeyError"')
    await step.run(failed.job, failed.run)
    expect(failed.runs.map((a) => a[2])).toEqual(['step'])
    expect(failed.oneShots()).toEqual(['step'])
    expect(existsSync(failed.job.output)).toBe(true)

    const dies = setup('die')
    await step.run(dies.job, dies.run)
    await step.run(dies.job, dies.run)
    expect(dies.oneShots()).toEqual(['step', 'step'])
  })

  it('reading a deck never goes to the resident: only an edit does', async () => {
    const s = setup('"ok": true')
    await inspect.run({ from: 'pptx', to: 'deckinfo', input: s.job.input, output: join(s.dir, 'info.json') }, s.run)
    expect(s.runs.map((a) => a[2])).toEqual(['inspect'])
  })

  describe('a slide drawn from a copy that holds it alone (slideAlone)', () => {
    // Off by default: on only with the switch, until the copy's picture is proven the deck's.
    beforeEach(() => void (process.env.TEMP_CODE_DECK_TOOL = 'alone'))
    afterEach(() => void delete process.env.TEMP_CODE_DECK_TOOL)

    it('without the switch every slide is drawn from the whole deck and no copy is cut', async () => {
      delete process.env.TEMP_CODE_DECK_TOOL
      const s = setup('"ok": true, "said": {"slides": 50}')
      const calls: Array<[string, number]> = []
      const out = join(s.dir, 'page.tmp')
      expect(await slideAlone(s.dir, () => s.run.tools.bin('python-pptx'), async (deck, page) => (calls.push([deck, page]), 50), s.job.input, 26, out)).toBe(50)
      expect(calls).toEqual([[s.job.input, 26]])
      // No resident was started for it.
      expect(existsSync(join(s.dir, 'work-tools'))).toBe(false)
    })

    const drawer = (fail: (deck: string) => boolean = () => false) => {
      const calls: Array<[string, number, string]> = []
      const draw = async (deck: string, page: number, output: string): Promise<number> => {
        calls.push([deck, page, output])
        // The copy is on disk while it is drawn (here the stand-in for LibreOffice leaves one, as the tool would).
        if (deck.endsWith('.solo.pptx')) writeFileSync(deck, 'copy')
        if (fail(deck)) throw new Error('LibreOffice could not draw it')
        return deck.endsWith('.solo.pptx') ? 1 : 50
      }
      return { calls, draw }
    }

    it('cuts the slide out, draws page 1 of the copy, answers the deck’s count and leaves no copy', async () => {
      const s = setup('"ok": true, "said": {"slides": 50}')
      const d = drawer()
      const out = join(s.dir, 'page.tmp')
      expect(await slideAlone(s.dir, () => s.run.tools.bin('python-pptx'), d.draw, s.job.input, 26, out)).toBe(50)
      expect(d.calls).toEqual([[`${out}.solo.pptx`, 1, out]])
      expect(existsSync(`${out}.solo.pptx`)).toBe(false)
    })

    it('draws from the whole deck where the copy cannot be made, and where the copy cannot be drawn', async () => {
      const noCopy = setup('"error": "KeyError"')
      const a = drawer()
      const out = join(noCopy.dir, 'page.tmp')
      expect(await slideAlone(noCopy.dir, () => noCopy.run.tools.bin('python-pptx'), a.draw, noCopy.job.input, 26, out)).toBe(50)
      expect(a.calls).toEqual([[noCopy.job.input, 26, out]])

      const noDraw = setup('"ok": true, "said": {"slides": 50}')
      const b = drawer((deck) => deck.endsWith('.solo.pptx'))
      const out2 = join(noDraw.dir, 'page.tmp')
      expect(await slideAlone(noDraw.dir, () => noDraw.run.tools.bin('python-pptx'), b.draw, noDraw.job.input, 26, out2)).toBe(50)
      expect(b.calls).toEqual([
        [`${out2}.solo.pptx`, 1, out2],
        [noDraw.job.input, 26, out2]
      ])
      expect(existsSync(`${out2}.solo.pptx`)).toBe(false)

      // A copy LibreOffice does not count one slide in is not drawn from: the whole deck is.
      const two = setup('"ok": true, "said": {"slides": 50}')
      const calls: string[] = []
      const out3 = join(two.dir, 'page.tmp')
      expect(await slideAlone(two.dir, () => two.run.tools.bin('python-pptx'), async (deck) => (calls.push(deck), deck.endsWith('.solo.pptx') ? 2 : 50), two.job.input, 26, out3)).toBe(50)
      expect(calls).toEqual([`${out3}.solo.pptx`, two.job.input])

      // A tool that does not say the count is not trusted with the picture.
      const mute = setup('"ok": true')
      const c = drawer()
      await slideAlone(mute.dir, () => mute.run.tools.bin('python-pptx'), c.draw, mute.job.input, 3, join(mute.dir, 'page.tmp'))
      expect(c.calls).toEqual([[mute.job.input, 3, join(mute.dir, 'page.tmp')]])
    })

    it('a cancelled draw is not tried again on the whole deck', async () => {
      const s = setup('"ok": true, "said": {"slides": 50}')
      const gone = new AbortController()
      const calls: string[] = []
      const draw = async (deck: string): Promise<number> => {
        calls.push(deck)
        gone.abort()
        throw Object.assign(new Error('The job was cancelled.'), { name: 'AbortError' })
      }
      await expect(slideAlone(s.dir, () => s.run.tools.bin('python-pptx'), draw, s.job.input, 2, join(s.dir, 'page.tmp'), gone.signal)).rejects.toThrow('cancelled')
      expect(calls).toHaveLength(1)
    })
  })

  it('TEMP_CODE_DECK_TOOL=once: an edit is one run of the tool and no resident is started', async () => {
    const s = setup('"ok": true')
    process.env.TEMP_CODE_DECK_TOOL = 'once'
    try {
      await step.run(s.job, s.run)
    } finally {
      delete process.env.TEMP_CODE_DECK_TOOL
    }
    expect(s.oneShots()).toEqual(['step'])
    expect(existsSync(join(s.dir, 'work-tools'))).toBe(false)
  })
})

// ── the real tool ────────────────────────────────────────────────────

const DATA = process.env.TEMP_CODE_WORK_TOOLS_DATA

describe.skipIf(!DATA)('the deck tool kept running, on python-pptx', () => {
  const FEATURE = join(__dirname, 'fixtures', '12-feature-probes.pptx')
  const GROUPS = join(__dirname, 'fixtures', '04-groups.pptx')
  let dir: string
  let py: string
  let script: string
  const logs: string[] = []
  // check: every job is also read afresh by the tool, and a difference from what it kept fails the job here.
  let kept: DeckResident
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-deck-kept-'))
    py = new Toolchain(DATA!).bin('python-pptx')!
    script = join(dir, 'deck.py')
    writeFileSync(script, DECK_PY)
    kept = createDeckResident({ python: () => py, folder: join(dir, 'deck-tool'), check: true, log: (l) => logs.push(l) })
  })
  afterAll(async () => {
    await kept.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  let n = 0
  /** One step by the resident and one by a run of the tool, on the same deck: both must say the same. */
  const both = async (deck: string, ops: SlideOp[]): Promise<{ deck: string; pack: string; info: DeckInfo; failed?: string[] }> => {
    const at = join(dir, `job-${++n}`)
    const paths = (who: string): string[] => ['ops.json', 'out.pptx', 'warnings.json', 'back.pack', 'info.json'].map((f) => join(at, who, f))
    for (const who of ['kept', 'once']) {
      mkdirSync(join(at, who), { recursive: true })
      writeFileSync(paths(who)[0], JSON.stringify(ops))
    }
    const [k, o] = [paths('kept'), paths('once')]
    const once = spawnSync(py, ['-I', script, 'step', deck, ...o], { encoding: 'utf8' })
    const mine = await kept.run(['step', deck, ...k]).then(
      () => null,
      (err: Error) => err
    )
    expect(once.status).toBe(0)
    expect(mine).toBeNull()
    const warnings = JSON.parse(readFileSync(k[2], 'utf8')) as string[]
    expect(warnings).toEqual(JSON.parse(readFileSync(o[2], 'utf8')))
    // An edit that did not go in: no deck, no pack, no outline, from either.
    if (warnings.some((w) => !w.startsWith('note: '))) {
      expect([k[3], k[4], o[3], o[4]].map((f) => existsSync(f))).toEqual([false, false, false, false])
      return { deck, pack: '', info: {} as DeckInfo, failed: warnings }
    }
    const info = JSON.parse(readFileSync(k[4], 'utf8')) as DeckInfo
    expect(info).toEqual(JSON.parse(readFileSync(o[4], 'utf8')))
    // The deck: the same parts in the same order with the same bytes (a new section's id is random, so that part is let off).
    const parts = async (p: string): Promise<Array<[string, string]>> => {
      const zip = await JSZip.loadAsync(readFileSync(p))
      return Promise.all(Object.keys(zip.files).map(async (name) => [name, ops.some((x) => x.op === 'section') && name === 'ppt/presentation.xml' ? '' : Buffer.from(await zip.files[name].async('uint8array')).toString('base64')] as [string, string]))
    }
    expect(await parts(k[1])).toEqual(await parts(o[1]))
    if (!ops.some((x) => x.op === 'section')) expect(readFileSync(k[1]).equals(readFileSync(o[1]))).toBe(true)
    expect(await parts(k[3])).toEqual(await parts(o[3]))
    return { deck: k[1], pack: k[3], info }
  }
  /** One step back by the resident and by a run of the tool; a refusal is the same sentence from both. */
  const bothBack = async (deck: string, pack: string): Promise<string> => {
    const at = join(dir, `job-${++n}`)
    const paths = (who: string): string[] => ['out.pptx', 'back.pack', 'info.json'].map((f) => join(at, who, f))
    for (const who of ['kept', 'once']) mkdirSync(join(at, who), { recursive: true })
    const [k, o] = [paths('kept'), paths('once')]
    const once = spawnSync(py, ['-I', script, 'unstep', deck, pack, ...o], { encoding: 'utf8' })
    const mine = await kept.run(['unstep', deck, pack, ...k]).then(
      () => null,
      (err: Error) => err
    )
    if (once.status !== 0) {
      expect(mine).toBeInstanceOf(DeckRefused)
      expect(mine!.message).toBe(once.stderr.trim())
      return `refused: ${mine!.message}`
    }
    expect(mine).toBeNull()
    expect(readFileSync(k[0]).equals(readFileSync(o[0]))).toBe(true)
    expect(JSON.parse(readFileSync(k[2], 'utf8'))).toEqual(JSON.parse(readFileSync(o[2], 'utf8')))
    return k[0]
  }

  it('a run of his edits, each on the deck the last one left, and each taken back: the same deck, pack and outline as a run of the tool for each', async () => {
    // An edit that cannot go in first: the same warning, and nothing made, either way.
    expect((await both(FEATURE, [{ op: 'notes', slide: 999, text: 'x' }])).failed).toEqual(['edit 1: there is no slide 999'])
    let at = await both(FEATURE, [{ op: 'hide', slide: 258, hidden: true }])
    const outline = at.info
    const texts = outline.slides.flatMap((s) => s.shapes.filter((x) => x.kind === 'text' && x.text && !x.group).map((x) => [s.id, x.id] as const))
    const moved = outline.slides.flatMap((s) => s.shapes.filter((x) => x.own && !x.group).map((x) => [s.id, x.id, x.own!.box] as const))
    expect(texts.length).toBeGreaterThan(3)
    expect(moved.length).toBeGreaterThan(3)
    const ids = outline.slides.map((s) => s.id)
    const steps: SlideOp[][] = [
      [{ op: 'text', slide: texts[0][0], shape: texts[0][1], paragraphs: ['Typed by hand'] }],
      [{ op: 'text', slide: texts[3][0], shape: texts[3][1], paragraphs: ['One', 'Two'] }],
      [{ op: 'geometry', slide: moved[1][0], shape: moved[1][1], box: [moved[1][2][0] + 12700, moved[1][2][1] + 12700, moved[1][2][2], moved[1][2][3]] }],
      [{ op: 'notes', slide: ids[2], text: 'Say this' }],
      [{ op: 'format', slide: texts[0][0], shape: texts[0][1], set: { bold: true, size: 28 } }],
      [{ op: 'insert', slide: ids[1], what: 'text', box: [914400, 914400, 1828800, 457200], text: 'A new box' }],
      [{ op: 'duplicate', slide: ids[1], id: 20_000 }],
      [{ op: 'move', slide: ids[4], after: 0 }],
      [{ op: 'remove', slide: ids[5] }],
      [{ op: 'add', after: ids[0], layout: outline.layouts[0], title: 'Added', id: 30_000 }],
      [{ op: 'transition', slide: ids[2], kind: 'fade' }],
      [{ op: 'section', act: 'add', at: ids[2], name: 'Part two' }],
      [{ op: 'theme', colors: { accent1: 'AA0000' }, minor: 'Arial' }],
      [{ op: 'text', slide: texts[0][0], shape: texts[0][1], paragraphs: ['After the theme changed'] }]
    ]
    const trail: Array<{ deck: string; pack: string }> = []
    for (const ops of steps) {
      at = await both(at.deck, ops)
      expect(at.failed).toBeUndefined()
      trail.push(at)
    }
    // A pack made against another deck is refused in the tool's own words by both.
    expect(await bothBack(GROUPS, trail[0].pack)).toContain('refused: the deck has changed since that edit')
    // Taken back, newest first, each on what the one before left.
    let deck = at.deck
    for (const step of trail.reverse()) deck = await bothBack(deck, step.pack)
    expect(logs.filter((l) => l.includes('starts'))).toHaveLength(1)
  })

  it('the deck changed under it: another deck under the same path, and the first again, are each read as they are', async () => {
    const path = join(dir, 'same-path.pptx')
    copyFileSync(FEATURE, path)
    const a = await both(path, [{ op: 'notes', slide: 258, text: 'First deck' }])
    expect(a.info.slides.find((s) => s.id === 258)!.notes).toBe('First deck')
    copyFileSync(GROUPS, path)
    const b = await both(path, [{ op: 'notes', slide: 268, text: 'Second deck' }])
    expect(b.info.slides.find((s) => s.id === 268)!.notes).toBe('Second deck')
    copyFileSync(FEATURE, path)
    const again = await both(path, [{ op: 'notes', slide: 258, text: 'First deck' }])
    expect(again.info).toEqual(a.info)
    expect(readFileSync(again.deck).equals(readFileSync(a.deck))).toBe(true)
  })

  it('through deck.ts: a step by the resident is what the converter hands back, split as hand.ts splits it', async () => {
    const step = SLIDES_CONVERTERS.find((c) => c.from === 'pptx' && c.to === 'pptxstep')!
    const tmp = join(dir, 'conv-tmp')
    mkdirSync(tmp)
    const data = join(dir, 'data')
    const runs: string[][] = []
    setDeckToolHome(data)
    const run: ConvertRun = {
      tools: Object.assign(new Toolchain(data), { bin: () => py }),
      threads: 1,
      slot: 0,
      tmp,
      signal: new AbortController().signal,
      run: async (_cmd, args) => {
        runs.push(args)
        return { code: 1, out: 'the one-shot run was not expected' }
      }
    }
    const output = join(dir, 'conv.bin')
    try {
      expect(await step.run({ from: 'pptx', to: 'pptxstep', input: FEATURE, output, options: { ops: [{ op: 'notes', slide: 258, text: 'By the resident' }] } }, run)).toEqual({ warnings: [] })
      expect(runs).toEqual([])
      const [deck, pack, info] = ['d.pptx', 'd.pack', 'd.json'].map((f) => join(dir, f))
      splitStep(output, [deck, pack, info])
      expect((JSON.parse(readFileSync(info, 'utf8')) as DeckInfo).slides.find((s) => s.id === 258)!.notes).toBe('By the resident')
      // Its script sits beside the toolchain's other run files, in a folder of its own.
      expect(readdirSync(join(data, 'work-tools', 'run', 'deck-tool')).filter((f) => f.endsWith('.py'))).toHaveLength(1)
    } finally {
      await stopDeckResident(data)
    }
  })
})

// ── a slide's picture from a copy that holds it alone ────────────────

/** Two pages as pictures 1920 wide, compared sample by sample (resident.test.ts's own check). */
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
    ink = len(sa) - sa.count(255)
    row = {'size': [wa, ha], 'pagesA': na, 'pagesB': nb, 'diff': diff, 'ink': ink}
    if diff != 0:
        # what each page says, for the reader of a failure
        with pymupdf.open(a) as da, pymupdf.open(b) as db:
            row['words'] = [da[pa - 1].get_text()[-80:], db[pb - 1].get_text()[-80:]]
    out.append(row)
print('RESULT ' + json.dumps(out))
`

/** A deck of `n` slides, each with its own words, shapes and its number printed; slide 3 is hidden, and the deck is in two sections. */
async function numberedDeck(n: number): Promise<Buffer> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.addSection({ title: 'First half' })
  pptx.addSection({ title: 'Second half' })
  for (let i = 1; i <= n; i++) {
    const s = pptx.addSlide({ sectionTitle: i <= n / 2 ? 'First half' : 'Second half' })
    s.addText(`Edit target ${String(i).padStart(3, '0')}`, { x: 0.55, y: 0.36, w: 12, h: 0.7, fontFace: 'Calibri', fontSize: 32 })
    s.addShape(pptx.ShapeType.rect, { x: 0.65, y: 1.7, w: 4.8, h: 3.8, fill: { color: '225B8B' } })
    s.addShape(pptx.ShapeType.ellipse, { x: 6.6 + (i % 5) * 0.3, y: 1.7, w: 3.8, h: 3.8, fill: { color: 'E26A20' }, rotate: (i * 13) % 90 })
    for (let j = 0; j < 4; j++) s.addText(`Text row ${j + 1} of slide ${i}`, { x: 0.95, y: 2.0 + j * 0.65, w: 4.2, h: 0.6, fontFace: 'Calibri', fontSize: 21, color: 'FFFFFF' })
    s.slideNumber = { x: 11.6, y: 6.7, w: 1.2, h: 0.5, fontFace: 'Calibri', fontSize: 24, color: '202020' }
  }
  const zip = await JSZip.loadAsync((await pptx.write({ outputType: 'nodebuffer' })) as Buffer)
  const xml = await zip.file('ppt/slides/slide3.xml')!.async('string')
  zip.file('ppt/slides/slide3.xml', xml.replace('<p:sld ', '<p:sld show="0" '))
  return zip.generateAsync({ type: 'nodebuffer' })
}

/**
 * Behind the gate, with LibreOffice: `solo`'s copy of a slide draws the same picture, pixel for pixel, as that
 * slide in its deck, its printed number included. `TEMP_CODE_SOLO_DECKS` (paths, comma between) holds more decks
 * to the same rule.
 */
describe.skipIf(!DATA)('a slide cut out alone, drawn by LibreOffice', () => {
  let dir: string
  let lo: Resident
  let kept: DeckResident
  let pdfPy: string
  const say = (line: string): void => console.log(`[solo] ${line}`)
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-deck-solo-'))
    const tools = new Toolchain(DATA!)
    pdfPy = tools.bin('pdf-tools')!
    lo = createResident({ soffice: () => tools.bin('libreoffice'), folder: join(dir, 'resident') })
    kept = createDeckResident({ python: () => tools.bin('python-pptx'), folder: join(dir, 'deck-tool') })
  })
  afterAll(async () => {
    await lo?.stop()
    await kept?.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  const fixture = (name: string): string => join(__dirname, 'fixtures', name)
  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const began = performance.now()
    const out = await fn()
    return [out, Math.round(performance.now() - began)]
  }

  it('is the same picture as the slide in its deck, on a deck that prints each slide’s number, on the fixtures, and on any deck named', async () => {
    const numbered = join(dir, 'numbered.pptx')
    writeFileSync(numbered, await numberedDeck(50))
    const decks: Array<[string, number[]]> = [
      [numbered, [1, 3, 4, 25, 26, 50]],
      [fixture('12-feature-probes.pptx'), [1, 2, 5, 9, 12]],
      [fixture('04-groups.pptx'), [1, 2]],
      [fixture('kinds.pptx'), [1]],
      [fixture('steps-talk.pptx'), [1, 2]],
      ...(process.env.TEMP_CODE_SOLO_DECKS ?? '').split(',').filter(Boolean).map((p): [string, number[]] => [p, [1, 2, 7, 26, 49]])
    ]
    let n = 0
    const apart: string[] = []
    for (const [deck, wanted] of decks) {
      const pairs: Array<[string, number, string, number]> = []
      const times: string[] = []
      let count = 0
      const pages: number[] = []
      for (const page of wanted) {
        const [alone, whole, cut] = [`alone-${++n}.pdf`, `whole-${n}.pdf`, `cut-${n}.pptx`].map((f) => join(dir, f))
        let said: { slides: number }
        let cutMs: number
        try {
          ;[said, cutMs] = (await timed(() => kept.run(['solo', deck, String(page), cut]))) as [{ slides: number }, number]
        } catch (err) {
          // A deck with fewer slides than the page asked for: the tool says so, and the next page is tried.
          expect(err).toBeInstanceOf(DeckRefused)
          continue
        }
        count = said.slides
        pages.push(page)
        const [one, aloneMs] = await timed(() => lo.slide(cut, 1, alone))
        expect(one.slides).toBe(1)
        const [all, wholeMs] = await timed(() => lo.slide(deck, page, whole))
        expect(all.slides).toBe(count)
        pairs.push([alone, 1, whole, 1])
        times.push(`slide ${page}: cut ${cutMs} + drawn ${aloneMs} ms alone, ${wholeMs} ms in the deck`)
      }
      expect(pages.length).toBeGreaterThan(0)
      const res = spawnSync(pdfPy, ['-I', '-c', COMPARE_PY, JSON.stringify(pairs)], { encoding: 'utf8', maxBuffer: 1 << 20 })
      expect(res.status, res.stderr).toBe(0)
      // MuPDF's own warnings (a video's annotation) go to stdout too: the answer is the line that says so.
      const rows = JSON.parse(res.stdout.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7)) as Array<{ size: number[]; pagesA: number; pagesB: number; diff: number; ink: number; words?: string[] }>
      say(`${deck.split('/').pop()} (${count} slides): ${times.join('; ')}; pixels apart ${rows.map((r) => r.diff).join(', ')}`)
      for (const [i, row] of rows.entries()) {
        expect(row.pagesA).toBe(1)
        expect(row.pagesB).toBe(1)
        expect(row.ink).toBeGreaterThan(1000)
        // Every deck is drawn before any is judged, so one failure says how far it reaches.
        if (row.diff !== 0) apart.push(`${deck.split('/').pop()} slide ${pages[i]}: ${row.diff} pixels apart; alone ${JSON.stringify(row.words?.[0])}, in the deck ${JSON.stringify(row.words?.[1])}`)
      }
    }
    expect(apart).toEqual([])
    // The pages of the 50-slide deck put together, as after every edit: what that costs.
    const whole = join(dir, 'numbered.pdf')
    await lo.deck(numbered, whole)
    const pageFiles = Array.from({ length: 50 }, (_, i) => join(dir, `page-${i + 1}.pdf`))
    await splitPdf(whole, pageFiles)
    const stitched: number[] = []
    for (let i = 0; i < 5; i++) stitched.push((await timed(() => stitchPdf(pageFiles, join(dir, 'stitched.pdf'))))[1])
    say(`50 one-page PDFs put together: ${stitched.join(', ')} ms`)
  }, 300_000)

  it('refuses a slide the deck does not have, and soloDeck answers the count through the host’s own resident', async () => {
    const err = await kept.run(['solo', fixture('04-groups.pptx'), '99', join(dir, 'none.pptx')]).then(
      () => null,
      (e: Error) => e
    )
    expect(err).toBeInstanceOf(DeckRefused)
    expect(err!.message).toBe('the deck has no slide 99')
    const data = join(dir, 'data')
    const py = new Toolchain(DATA!).bin('python-pptx')
    try {
      const out = join(dir, 'solo-2.pptx')
      const count = await soloDeck(data, () => py, fixture('12-feature-probes.pptx'), 2, out)
      const zip = await JSZip.loadAsync(readFileSync(out))
      const pres = await zip.file('ppt/presentation.xml')!.async('string')
      expect(pres.match(/<p:sldId /g) ?? []).toHaveLength(1)
      expect(count).toBeGreaterThan(2)
      // A deck that counts its slides from another number is not cut: its whole picture is the one to trust.
      const five = await JSZip.loadAsync(readFileSync(fixture('12-feature-probes.pptx')))
      five.file('ppt/presentation.xml', (await five.file('ppt/presentation.xml')!.async('string')).replace('<p:presentation ', '<p:presentation firstSlideNum="5" '))
      const fromFive = join(dir, 'from-five.pptx')
      writeFileSync(fromFive, await five.generateAsync({ type: 'nodebuffer' }))
      await expect(kept.run(['solo', fromFive, '2', join(dir, 'none.pptx')])).rejects.toThrow('the deck counts its slides from 5')
      expect(Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))).toHaveLength(1)
      // Off with the switch: the caller then draws from the whole deck.
      process.env.TEMP_CODE_DECK_TOOL = 'once'
      await expect(soloDeck(data, () => py, fixture('12-feature-probes.pptx'), 2, out)).rejects.toBeInstanceOf(DeckResidentUnavailable)
    } finally {
      delete process.env.TEMP_CODE_DECK_TOOL
      await stopDeckResident(data)
    }
  })
})
