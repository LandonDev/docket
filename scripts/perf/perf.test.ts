import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUDGETS, budgetsOf, covers } from './budgets'
import { DISK_PRESSED, guardLiveBox, GUARD_EVERY_MS, ioPressure, LIVE_SLOWED, slowed } from './lib/guard'
import { guardedArgs, wrapped } from './guarded'
import { LOAD_DELTAS_A_SECOND, loadStream } from './lib/load'
import { countFrame, middle, type Counts, type Sample } from './lib/probe'
import { ROWS, rowsMatching } from './rows'
import { chosen, coreCount, flags, lastCores, parseLink, type RunResults } from './run'
import { asks, latest, perfTable, withSection } from './table'

const HERE = __dirname
const sources = (dir = HERE): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? sources(join(dir, entry.name)) : /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [join(dir, entry.name)] : [])

describe('the budgets and the rows', () => {
  it('every budget has a perf row that exists, or a written reason it cannot run on the pair', () => {
    for (const budget of BUDGETS) {
      const live = budget.rows.filter((pattern) => ROWS.some((row) => covers(pattern, row.id)))
      expect(live, `${budget.id} names rows that do not exist`).toEqual(budget.rows)
      expect(budget.rows.length > 0 || (budget.off ?? '').length > 20, `${budget.id} has neither a row nor a reason`).toBe(true)
    }
    expect(BUDGETS.map((b) => b.id)).toEqual([
      'B01', 'B02', 'B03', 'B04', 'B05a', 'B05b', 'B05c', 'B05d', 'B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B12', 'B13', 'B14', 'B15', 'B16',
      'B17', 'B18', 'B19', 'B20', 'B21', 'B22', 'B23', 'B24', 'B25', 'B26', 'B27', 'B28', 'B29', 'B30', 'B31', 'B32', 'B33',
      ...Array.from({ length: 20 }, (_, i) => 'D' + String(i + 1).padStart(2, '0')),
      ...Array.from({ length: 9 }, (_, i) => 'H0' + (i + 1)),
      ...Array.from({ length: 6 }, (_, i) => 'G0' + (i + 1)),
      ...Array.from({ length: 12 }, (_, i) => 'L' + String(i + 1).padStart(2, '0')),
      ...Array.from({ length: 5 }, (_, i) => 'P0' + (i + 1))
    ])
  })

  it('every row times a budget, and no two rows share an id', () => {
    expect(ROWS.filter((row) => budgetsOf(row.id).length === 0).map((row) => row.id)).toEqual([])
    expect(new Set(ROWS.map((row) => row.id)).size).toBe(ROWS.length)
  })

  it('rows are chosen by id, by a prefix and by the shape their id ends in', () => {
    expect(rowsMatching(['list-A']).map((row) => row.id)).toEqual(['list-A'])
    expect(rowsMatching(['view-*']).every((row) => row.id.startsWith('view-'))).toBe(true)
    expect(chosen({ rows: ['list-*'], shapes: ['B1'] }).map((row) => row.id)).toEqual(['list-B1'])
    expect(chosen({ rows: ['view-Mail', 'list-*'], shapes: ['A'] }).map((row) => row.id)).toEqual(['view-Mail', 'list-A'])
  })

  it('a run takes the rows of its own family: a pair is stood up for Work or for code', () => {
    expect(chosen({}).every((row) => (row.family ?? 'work') === 'work')).toBe(true)
    expect(chosen({ family: 'code' }).every((row) => row.family === 'code')).toBe(true)
    expect(chosen({ family: 'code', rows: ['view-*'] })).toEqual([])
  })
})

describe('the kit keeps to itself', () => {
  it('never spreads the environment it was started in', () => {
    for (const file of sources()) expect(readFileSync(file, 'utf8'), file).not.toMatch(/\.\.\.\s*process\.env|env:\s*process\.env/)
  })

  it('starts every instance through the journeys\' harness, which gives each its own empty WINVM_DIR and a stripped environment', () => {
    const shape = readFileSync(join(HERE, '../journeys/lib/shape.ts'), 'utf8')
    expect(shape).toContain("WINVM_DIR: join(inst.data, 'no-vm')")
    expect(shape).toContain('const inherited = isolatedEnvironment(process.env)')
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      // host.ts stands up a headless host with no window, which the journeys' pair cannot: it is held to the same two
      // rules by name below.
      if (file.endsWith('/host.ts')) continue
      // guarded.ts starts the one command it was handed, under the guard: never an instance of its own.
      expect(text, file).not.toMatch(file.endsWith('/guarded.ts') ? /WINVM_DIR\s*[:=]|node_modules\/\.bin\/electron/ : /WINVM_DIR\s*[:=]|node_modules\/\.bin\/electron|spawn\(/)
    }
    const host = readFileSync(join(HERE, 'host.ts'), 'utf8')
    expect(host).toContain('...isolatedEnvironment(process.env)')
    // Its WINVM_DIR is a folder it made empty under the run's own root, never the environment's.
    expect(host).toMatch(/const vm = join\([^)]*'no-vm'\)/)
    expect(host).toMatch(/WINVM_DIR: vm\b/)
    expect(host).not.toMatch(/process\.env\.WINVM/)
  })

  it('takes at most eight cores, the last ones, and a link as there-and-back over rate', () => {
    expect(lastCores(8, 32)).toBe('24-31')
    expect(lastCores(8, 4)).toBe('0-3')
    expect(coreCount('24-31')).toBe(8)
    expect(coreCount('0,2,4-6')).toBe(5)
    // His Wi-Fi by default: one chunk in eight 50 to 90 ms late; a plain link compares with the pass before.
    expect(parseLink(undefined)).toEqual({ delayMs: 30, rateMbit: 10, jitter: { every: 8, minMs: 50, maxMs: 90, seed: 8 } })
    expect(parseLink('60/10/j8')).toEqual(parseLink(undefined))
    expect(parseLink('40/8')).toEqual({ delayMs: 20, rateMbit: 8 })
    expect(parseLink('40/8/j4')).toMatchObject({ delayMs: 20, rateMbit: 8, jitter: { every: 4 } })
    expect(parseLink('none')).toBeNull()
    expect(() => parseLink('fast')).toThrow()
    expect(() => parseLink('60/10/jitter')).toThrow()
    expect(flags([])).toMatchObject({ load: 40, lifeosMs: 40, family: 'work', seconds: 60, keep: false })
    expect(flags(['--family', 'code', '--lifeos', '0'])).toMatchObject({ family: 'code', lifeosMs: 0 })
    expect(() => flags(['--family', 'play'])).toThrow()
    expect(() => flags(['--cores', '0;rm'])).toThrow()
  })
})

describe('the live box guard', () => {
  afterEach(() => vi.useRealTimers())

  it('says stop on two slow answers in a row, a missed answer counting as slow', () => {
    expect(slowed([900])).toBe(false)
    expect(slowed([900, 100])).toBe(false)
    expect(slowed([100, 900, 801])).toBe(true)
    expect(slowed([100, null, 900])).toBe(true)
    expect(slowed([900, 800])).toBe(false)
  })

  it('aborts the run with "the live box slowed", and watches nothing where no live service answers', async () => {
    vi.useFakeTimers()
    const abort = new AbortController()
    const answers = [60, 900, 950]
    const guard = guardLiveBox(abort, async () => answers.shift() ?? 50, () => null)
    await vi.advanceTimersByTimeAsync(GUARD_EVERY_MS * 2)
    expect(abort.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(GUARD_EVERY_MS)
    expect(abort.signal.aborted).toBe(true)
    expect((abort.signal.reason as Error).message).toBe(LIVE_SLOWED)
    expect(guard.stop()).toEqual([60, 900, 950])

    const none = new AbortController()
    const off = guardLiveBox(none, async () => null, () => null)
    await vi.advanceTimersByTimeAsync(GUARD_EVERY_MS * 4)
    expect(none.signal.aborted).toBe(false)
    expect(off.stop()).toEqual([])
  })

  it("reads the disk's pressure from the kernel's file, and nothing where there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-guard-'))
    try {
      const file = join(dir, 'io')
      writeFileSync(file, 'some avg10=31.25 avg60=4.00 avg300=1.20 total=31849667849\nfull avg10=0.03 avg60=0.72 avg300=1.15 total=13858780707\n')
      expect(ioPressure(file)).toBe(31.25)
      writeFileSync(file, 'full avg10=99.00 avg60=0.72 avg300=1.15 total=1\n')
      expect(ioPressure(file)).toBeNull()
      expect(ioPressure(join(dir, 'none'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("aborts with the disk's pressure past 30, with or without a live service", async () => {
    vi.useFakeTimers()
    const abort = new AbortController()
    const reads = [12, 30, 30.5]
    const guard = guardLiveBox(abort, async () => null, () => reads.shift() ?? 0)
    await vi.advanceTimersByTimeAsync(GUARD_EVERY_MS * 2)
    expect(abort.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(GUARD_EVERY_MS)
    expect((abort.signal.reason as Error).message).toBe(DISK_PRESSED)
    expect(guard.pressure()).toBe(30.5)
    guard.stop()
  })

  it('wraps a command niced, at idle disk priority and pinned to the last eight cores', () => {
    expect(guardedArgs(['bun', 'x.ts'], 32)).toEqual({ cores: '24-31', command: ['bun', 'x.ts'] })
    expect(guardedArgs(['--cores', 'none', 'dd'], 32)).toEqual({ cores: null, command: ['dd'] })
    expect(() => guardedArgs(['--cores', '0;rm', 'dd'])).toThrow()
    expect(() => guardedArgs([])).toThrow()
    expect(wrapped('24-31', ['bun', 'x.ts'])).toEqual(['ionice', '-c', '3', 'nice', '-n', '19', 'taskset', '-c', '24-31', 'bun', 'x.ts'])
    expect(wrapped(null, ['dd'])).toEqual(['ionice', '-c', '3', 'nice', '-n', '19', 'dd'])
  })
})

describe('the counts', () => {
  const zero = (): Counts => ({ t: {}, tAll: 0, c: 0, up: 0, down: 0 })

  it('a request on the link to box is one round trip by method; its answer only bytes', () => {
    const counts = zero()
    countFrame(counts, 'box', true, '{"id":"1","method":"work.files.list","params":{}}')
    countFrame(counts, 'box', true, '{"id":"2","method":"work.files.list","params":{}}')
    countFrame(counts, 'box', true, '{"id":"3","method":"work.files.stat","params":{}}')
    countFrame(counts, 'box', false, '{"id":"1","ok":true,"result":{}}')
    countFrame(counts, 'box', false, '{"push":"work.files"}')
    expect(counts.t).toEqual({ 'work.files.list': 2, 'work.files.stat': 1 })
    expect(counts.tAll).toBe(3)
    expect(counts.up).toBeGreaterThan(100)
    expect(counts.down).toBe('{"id":"1","ok":true,"result":{}}'.length + '{"push":"work.files"}'.length)
  })

  it('an ask of LifeOS is counted, its keep-alives and the window\'s own host are not', () => {
    const counts = zero()
    countFrame(counts, 'lifeos', true, '{"type":"ModifyQuerySet","baseVersion":0}')
    countFrame(counts, 'lifeos', true, '{"type":"Mutation","requestId":1}')
    countFrame(counts, 'lifeos', true, '{"type":"Event","eventType":"Pong"}')
    countFrame(counts, 'lifeos', false, '{"type":"Transition"}')
    countFrame(counts, 'own', true, '{"id":"1","method":"session.list"}')
    countFrame(counts, 'other', true, 'not json')
    expect(counts).toEqual({ t: {}, tAll: 0, c: 2, up: 0, down: 0 })
  })

  it('the middle press is the middle by usable time, an unfinished press last', () => {
    const s = (usable: number | null): Sample => ({ first: null, usable, longest: 0, counts: zero(), after: zero() })
    expect(middle([s(900), s(120), s(300)])?.usable).toBe(300)
    expect(middle([s(null), s(120), s(300)])?.usable).toBe(300)
    expect(middle([s(120)])?.usable).toBe(120)
    expect(middle([])).toBeUndefined()
  })
})

describe('the stand-in load', () => {
  afterEach(() => vi.useRealTimers())

  it('streams its deltas at the rate for the seconds asked, then ends the message', async () => {
    vi.useFakeTimers()
    const reader = loadStream('claude-haiku-5-5', 2).getReader()
    const text = new TextDecoder()
    let all = ''
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        all += text.decode(value)
      }
    })()
    await vi.advanceTimersByTimeAsync(2000)
    await pump
    expect(all.match(/content_block_delta/g)?.length).toBe(2 * 2 * LOAD_DELTAS_A_SECOND)
    expect(all.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true)
  })
})

describe('the table', () => {
  const zero = (): Counts => ({ t: {}, tAll: 0, c: 0, up: 0, down: 0 })
  const sample = (usable: number | null, t: Record<string, number> = {}): Sample => ({
    first: usable === null ? null : usable / 2, usable, longest: 12,
    counts: { t, tAll: Object.values(t).reduce((a, b) => a + b, 0), c: 3, up: 400, down: 2048 }, after: zero()
  })
  const run = (at: string, rows: RunResults['rows']): RunResults => ({ id: 'r-' + at, at, commit: 'abc1234', link: { rttMs: 60, rateMbit: 10 }, load: 24, cores: '24-31', rows, guard: [] })
  const row = (id: string, usable: number | null, t?: Record<string, number>) => ({ id, title: id, samples: [sample(usable, t)], middle: sample(usable, t), machine: { load: 19.5, anonGiB: 41.2 } })

  it('names the busiest methods of a press', () => {
    expect(asks(sample(300, { 'work.files.list': 2, 'work.files.stat': 1 }))).toBe('3 T (work.files.list 2, work.files.stat), 3 C')
    expect(asks(undefined)).toBe('–')
  })

  it('a later run of a row replaces an earlier one, but a row a later run did not reach keeps its number', () => {
    const first = run('2026-11-24T10:00:00Z', [row('list-A', 900), row('view-Mail', 1200)])
    const second = run('2026-11-24T11:00:00Z', [row('list-A', 250), { id: 'view-Mail', title: 'view-Mail', samples: [], machine: { load: 1, anonGiB: null }, notRun: 'the run\'s 60 s of measured work were used' }])
    expect(latest([second, first]).map(({ row }) => [row.id, row.middle?.usable])).toEqual([['list-A', 250], ['view-Mail', 1200]])
  })

  it('sets each row beside its budget, writes a row that did not run with its reason, and lists what the pair cannot time', () => {
    const table = perfTable([run('2026-11-24T10:00:00Z', [
      row('list-A', 250, { 'work.files.list': 1 }),
      { id: 'open-pdf-B2', title: 'x', samples: [], machine: { load: 1, anonGiB: null }, notRun: 'desk exited early' },
      row('view-Today', null)
    ])])
    expect(table).toContain('| B05a | `list-A` | 300 ms | 250 ms | 250 ms | 125 ms | 12 ms | 1 T (work.files.list), 3 C | 0 T, 0 C | 2 kB | 60 ms, 10 Mbit/s, 24 threads; load 19.5, 41.2 GiB |')
    expect(table).toContain('| B11 | `open-pdf-B2` | 1.5 s | not run: desk exited early |')
    expect(table).toContain('never usable (timed out)')
    expect(table).toContain('- **B05b** List a folder in a VM library:')
  })

  it('replaces its own section of a file and leaves the rest', () => {
    const once = withSection('# Baseline\n\nwords\n', 'before', '## Timed', '| a |')
    expect(once).toBe('# Baseline\n\nwords\n\n<!-- perf:before -->\n## Timed\n\n| a |\n<!-- /perf:before -->\n')
    const twice = withSection(once + '\ntail\n', 'before', '## Timed again', '| b |')
    expect(twice).toBe('# Baseline\n\nwords\n\n<!-- perf:before -->\n## Timed again\n\n| b |\n<!-- /perf:before -->\n\ntail\n')
    expect(withSection(twice, 'after', '## After', '| c |')).toContain('<!-- perf:before -->\n## Timed again')
  })
})
