/**
 * What a Work search costs on a host (docs/agents/work-search.md "What a search costs"):
 *
 *   sqlite3 /srv/agents/temp-code-data/temp-code.db ".backup /tmp/one-search/box.db"     (a copy; never the live file)
 *   bun run script:bench-work-search -- --db /tmp/one-search/box.db
 *
 * On a copy of a host's database it times the instant tier (the Work threads' titles, from the rows
 * the host holds in memory) and the transcript search held to Work rows, beside the same search
 * with no scope; and each LifeOS source's own work on the host (asking, keeping the rows in reach,
 * making the hits) against a LifeOS in memory with made-up rows. LifeOS's own answer time is not in
 * these: a stand-in answers at once.
 *
 * The box's measuring rules (MASTER-NOTES): two pinned cores, the variants interleaved so they see
 * the same load, five runs, the median and the worst with the load average beside them. It prints
 * counts and milliseconds, never a title or a line of a transcript.
 *
 *   --db <path>   the copy (refused under an app's own data folder)
 *   --runs <n>    runs a measure (5)
 *   --json        the numbers as JSON only
 */
import { spawnSync } from 'node:child_process'
import { cpus, loadavg } from 'node:os'
import { resolve } from 'node:path'
import type { SessionMeta } from '../src/shared/events'
import type { SearchReach } from '../src/shared/work/search'
import { openDb, Store } from '../src/main/server/db'
import type { WorkCtx } from '../src/main/server/work/modules'
import { makeSearchHost, setSearchHost } from '../src/main/server/work/search/host'
import { makeMirror, setMirror } from '../src/main/server/work/search/mirror'
import { event, lifeosSources, openTask, person } from '../src/main/server/work/search/sources/lifeos'
import { threadTitles, threadWords } from '../src/main/server/work/search/sources/threads'

// Two cores of its own, where the system can give them.
if (process.platform === 'linux' && !process.env.TC_BENCH_PINNED && cpus().length >= 4) {
  const cores = `${cpus().length - 2},${cpus().length - 1}`
  const pinned = spawnSync('taskset', ['-c', cores, process.execPath, ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, TC_BENCH_PINNED: cores } })
  if (pinned.error === undefined) process.exit(pinned.status ?? 1)
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? undefined : process.argv[i + 1]
}
const json = process.argv.includes('--json')
const RUNS = Number(arg('runs') ?? 5)
const dbPath = arg('db') ? resolve(arg('db')!) : ''
if (!dbPath || /temp-code-data|Application Support/.test(dbPath)) {
  console.error(`refusing ${dbPath || 'no database'}: pass --db a copy of the host's database (sqlite3 <live> ".backup <copy>")`)
  process.exit(2)
}
const say = (line: string): void => void (json ? undefined : console.log(line))

const db = openDb(dbPath)
const store = new Store(db)
const sessions = store.listSessions({})
const projects = new Map((db.prepare(`SELECT id, workspace_id AS w FROM projects`).all() as { id: string; w: string }[]).map((p) => [p.id, p.w]))
const byId = new Map(sessions.map((s) => [s.id, s]))
const work = sessions.filter((s) => s.scope === 'work')
const jobs = (db.prepare(`SELECT id, name, sector FROM workspaces WHERE kind = 'work' ORDER BY created_at, id`).all() as { id: string; name: string; sector: string | null }[]).map((w) => ({ id: w.id, name: w.name, sector: w.sector }))
const events = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n

/** The host part over the copy; `everyThread` counts every thread as a Work thread of the first job, to time the title scan at the host's full size. */
function host(everyThread: boolean) {
  const as = (s: SessionMeta): SessionMeta => (everyThread ? ({ ...s, scope: 'work', projectId: null, workspaceId: jobs[0]?.id ?? 'job' } as SessionMeta) : s)
  return makeSearchHost({
    sessions: () => sessions.map(as),
    session: (id) => (byId.get(id) ? as(byId.get(id)!) : null),
    workspaceOfProject: (id) => projects.get(id) ?? null,
    searchEvents: (o) => store.searchEvents(o)
  })
}
const reach: SearchReach = { workspaces: jobs.length ? jobs : [{ id: 'job', name: 'Job', sector: 'life' }], chats: true, sessionId: null }
const ask = (text: string, limit = 4) => ({ text, reach, limit, by: { kind: 'local' as const, caps: [] }, signal: new AbortController().signal })

// A LifeOS in memory: rows of six sectors, as many as a busy owner has.
const SECTORS = ['cosmic', 'hypixel', 'purdue', 'ref', 'unify', 'life']
const sectorOf = (i: number): string => SECTORS[i % SECTORS.length]
const DAY = 86_400_000
const lifeosRows: Record<string, (args: Record<string, unknown>) => unknown> = {
  'people:list': () => Array.from({ length: 2000 }, (_, i) => ({ _id: `p${i}`, name: `Person ${i} ${i % 40 === 0 ? 'Budget' : 'Name'}`, sectors: [sectorOf(i)], notes: '', identities: [{ kind: 'email', value: `person${i}@example.org` }] })),
  'mail:search': () => Array.from({ length: 50 }, (_, i) => ({ _id: `m${i}`, sector: sectorOf(i), subject: `Budget thread ${i}`, snippet: 'a line of the mail', senders: ['Sender'], lastMessageAt: i })),
  'tasks:search': () => Array.from({ length: 20 }, (_, i) => ({ _id: `t${i}`, sector: sectorOf(i), title: `Budget task ${i}`, status: 'todo' })),
  'tasks:byKeys': () => [],
  'events:range': () => Array.from({ length: 600 }, (_, i) => ({ _id: `e${i}`, sector: sectorOf(i), title: i % 30 === 0 ? `Budget review ${i}` : `Meeting ${i}`, startsAt: Date.now() + (i - 150) * (DAY / 4), location: 'Room' })),
  'docs:list': (a) => ({ page: Array.from({ length: 25 }, (_, i) => ({ _id: `d-${a.sector}-${i}`, sector: a.sector, title: i % 5 === 0 ? `Budget doc ${i}` : `Doc ${i}`, editedAt: i })) }),
  'catalog:search': (a) => Array.from({ length: 30 }, (_, i) => ({ table: 'docs', id: `d-${a.sector}-${i}`, snippet: 'a line with the budget in it' })),
  'docs:get': () => ({ title: 'Doc' }),
  'projects:list': () => Array.from({ length: 300 }, (_, i) => ({ _id: `j${i}`, sector: sectorOf(i), name: i % 20 === 0 ? `Budget project ${i}` : `Project ${i}`, description: '' }))
}
const ctx = { db, host: 'bench', log: () => {}, lifeos: { connected: () => true, owner: () => ({ query: async (fn: string, args: Record<string, unknown> = {}) => lifeosRows[fn]?.(args) }) } } as unknown as WorkCtx
// Every sector has a job here, so every row is kept and made into a hit: the most work the host does.
const lifeosReach: SearchReach = { workspaces: SECTORS.map((sector) => ({ id: `job-${sector}`, name: sector, sector })), chats: true, sessionId: null }

interface Measure {
  name: string
  run(): Promise<number>
  ms: number[]
  loads: number[]
  rows: number
}
const measures: Measure[] = []
const measure = (name: string, run: () => Promise<number>): void => void measures.push({ name, run, ms: [], loads: [], rows: 0 })

const WORDS = ['budget', 'the', 'meeting schedule']
for (const everyThread of [false, true]) {
  const which = everyThread ? `every thread as Work (${sessions.length} rows)` : `Work rows (${work.length})`
  measure(`titles, ${which}`, async () => {
    setSearchHost(host(everyThread))
    return (await threadTitles.search(ask('budget'), ctx)).length
  })
}
for (const words of WORDS) {
  measure(`transcript words "${words}", Work rows`, async () => {
    setSearchHost(host(false))
    return (await threadWords.search(ask(words), ctx)).length
  })
  measure(`transcript words "${words}", no scope (the app's Search)`, async () => (await store.searchEvents({ query: words, limit: 60 })).hits.length)
}
for (const source of lifeosSources.filter((s) => s !== openTask)) measure(`LifeOS ${source.kind}, the host's own work`, async () => (await source.search({ ...ask('budget'), reach: lifeosReach }, ctx)).length)

// The mirror warm (search/mirror.ts): the same lists held in memory by live queries, searched with no call at all.
const live: Record<string, (value: unknown) => void> = {}
const mirrorCtx = { ...ctx, lifeos: { ...ctx.lifeos, subscribe: (fn: string, _args: unknown, on: (value: unknown) => void) => ((live[fn] = on), () => {}) } } as unknown as WorkCtx
const settle = (): void => void (globalThis as { gc?: () => void }).gc?.()
settle()
const heapBefore = process.memoryUsage().heapUsed
const warm = makeMirror(mirrorCtx, { every: () => () => {} })
live['people:list'](lifeosRows['people:list']({}))
live['tasks:list'](Array.from({ length: 400 }, (_, i) => ({ _id: `ot${i}`, sector: sectorOf(i), title: i % 20 === 0 ? `Budget task ${i}` : `Task ${i}`, status: 'todo', key: `KEY-${i}` })))
live['events:range'](lifeosRows['events:range']({}))
settle()
const mirrorBytes = process.memoryUsage().heapUsed - heapBefore
const held = warm.size()
for (const source of [person, openTask, event]) {
  measure(`mirror warm: ${source.kind}`, async () => {
    setMirror(warm)
    const n = (await source.search({ ...ask('budget'), reach: lifeosReach }, mirrorCtx)).length
    setMirror(null)
    return n
  })
}

say(`database: ${sessions.length} threads (${work.length} Work), ${jobs.length} jobs, ${events} events; ${RUNS} runs a measure, interleaved`)
// One pass first, untimed: SQLite's page cache and the index's own warm-up are not the search.
for (const m of measures) await m.run()
for (let run = 0; run < RUNS; run++) {
  for (const m of measures) {
    const started = performance.now()
    m.rows = await m.run()
    m.ms.push(performance.now() - started)
    m.loads.push(loadavg()[0])
  }
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const out = measures.map((m) => {
  const worst = Math.max(...m.ms)
  const mid = median(m.ms)
  return { name: m.name, medianMs: +mid.toFixed(2), worstMs: +worst.toFixed(2), rows: m.rows, load: +median(m.loads).toFixed(1), wide: worst > Math.max(mid * 3, mid + 5) }
})
const mirrorKb = Math.round(mirrorBytes / 1024)
say(`mirror: ${held.people} people, ${held.tasks} open tasks, ${held.events} events held in about ${mirrorKb} kB of heap${(globalThis as { gc?: unknown }).gc ? '' : ' (no --expose-gc: a rough figure)'}`)
if (json) console.log(JSON.stringify({ threads: sessions.length, work: work.length, jobs: jobs.length, events, runs: RUNS, mirror: { ...held, kB: mirrorKb }, measures: out }, null, 2))
else for (const m of out) console.log(`${m.name.padEnd(64)} median ${String(m.medianMs).padStart(8)} ms   worst ${String(m.worstMs).padStart(8)} ms   rows ${String(m.rows).padStart(3)}   load ${m.load}${m.wide ? '   (spread too wide to rule on)' : ''}`)
db.close()
