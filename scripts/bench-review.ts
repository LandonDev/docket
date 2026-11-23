/**
 * What the weekly review's read of the threads costs on a database the size of the real one
 * (docs/agents/work-review.md "The scan"). The events table holds millions of rows and SQLite
 * answers on the host's own loop, so the read is cut into slices with the loop handed back
 * between them; this times the slices.
 *
 *   taskset -c 2,3 bun run script:bench-review -- --db /srv/agents/temp-code-data/temp-code.db
 *   taskset -c 2,3 bun run script:bench-review -- --db <copy>.db --weeks 4 --runs 5
 *
 * It opens the database read only (a reader in WAL mode holds no writer back, and nothing is
 * written), reads every thread of the host as one job (`every`), since a box's own threads are
 * mostly code threads, and prints, per week asked for: threads opened, rows spanned, slices,
 * the longest slice and the whole read. It prints times and counts only: no title, no word of
 * any message. The rule it holds: no slice over 50 ms. The box's measuring rules (MASTER-NOTES):
 * pinned cores, five runs, the median with the load average beside it.
 */
import { existsSync } from 'node:fs'
import { loadavg } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { scanThreads } from '../src/main/server/work/review/gather/threads'
import { stepWeek, weekOf } from '../src/shared/work/review'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? undefined : process.argv[i + 1]
}
const DB = arg('db')
const RUNS = Number(arg('runs') ?? 5)
const WEEKS = Number(arg('weeks') ?? 2)
const TZ = arg('tz') ?? 'America/Chicago'
const LIMIT_MS = 50

if (!DB || !existsSync(DB)) {
  console.error('usage: bench-review --db <temp-code.db> [--weeks 2] [--runs 5] [--tz America/Chicago]')
  process.exit(2)
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const ms = (n: number): string => `${n.toFixed(1)} ms`

const db = new DatabaseSync(DB, { readOnly: true })
const cold = DB.replace(/\.db$/, '') + '-cold.db'
if (existsSync(cold)) db.prepare(`ATTACH DATABASE ? AS cold`).run(cold)
else db.exec(`ATTACH DATABASE ':memory:' AS cold; CREATE TABLE cold.events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq))`)

const counts = db.prepare('SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT MAX(rowid) FROM events) AS events').get() as { sessions: number; events: number }
console.log(`database: ${counts.sessions.toLocaleString('en-US')} threads, about ${counts.events.toLocaleString('en-US')} hot event rows; load ${loadavg()[0]!.toFixed(1)}`)

const jobs = { list: [{ workspaceId: 'all', sector: null, name: 'All' }], byWorkspace: new Map([['all', 0]]), bySector: new Map<string, number>() }
let worst = 0
const now = Date.now()
for (let back = 0; back < WEEKS; back++) {
  const week = stepWeek(weekOf(now, TZ), -back, TZ)
  const span = { from: week.from, to: Math.min(week.to, now) }
  const before = stepWeek(week, -1, TZ)
  const totals: number[] = []
  const longest: number[] = []
  let cost = { slices: 0, longestMs: 0, threads: 0, rows: 0 }
  let points = 0
  for (let run = 0; run < RUNS; run++) {
    const began = performance.now()
    const got = await scanThreads(db, span, { from: before.from, to: before.from + (span.to - span.from) }, jobs, undefined, true)
    totals.push(performance.now() - began)
    longest.push(got.cost.longestMs)
    cost = got.cost
    points = got.points.length
  }
  worst = Math.max(worst, ...longest)
  console.log(
    `week ${back === 0 ? 'now' : `-${back}`}: ${cost.threads} threads opened, ${cost.rows.toLocaleString('en-US')} rows spanned, ${points} messages found, ${cost.slices} slices; ` +
      `longest slice ${ms(median(longest))} median, ${ms(Math.max(...longest))} worst; whole read ${ms(median(totals))} median (${RUNS} runs, load ${loadavg()[0]!.toFixed(1)})`
  )
}
db.close()
console.log(worst <= LIMIT_MS ? `ok: no slice over ${LIMIT_MS} ms (worst ${ms(worst)})` : `FAIL: a slice ran ${ms(worst)}, over ${LIMIT_MS} ms`)
process.exit(worst <= LIMIT_MS ? 0 : 1)
