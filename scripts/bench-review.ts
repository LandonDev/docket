/**
 * What the weekly review's read of the threads costs on a database the size of the real one
 * (docs/agents/work-review.md "The scan"). The events table holds millions of rows and SQLite
 * answers on the host's own loop, so the read is cut into slices with the loop handed back
 * between them; this times the slices.
 *
 *   taskset -c 2,3 bun run script:bench-review -- --db /srv/agents/temp-code-data/temp-code.db
 *   taskset -c 2,3 bun run script:bench-review -- --db <copy>.db --weeks 4 --runs 5
 *
 * It runs on a COPY, never on a database an app has open: a long reader holds a live file's
 * write-ahead log open, and every thread on the host writes to that file. Make the copy once,
 * through the heavy queue, and delete it when done:
 *
 *   heavy sqlite3 /srv/agents/temp-code-data/temp-code.db "VACUUM INTO '/tmp/review-bench/copy.db'"
 *
 * The script refuses a file whose write-ahead log moved in the last ten minutes, and opens what
 * it is given read only. It reads every thread of the host as one job (`every`), since a box's
 * own threads are mostly code threads, and prints, per week asked for: threads opened, rows
 * spanned, how often the loop was handed back, the longest it was held and the whole read. It
 * prints times and counts only: no title, no word of any message. The rule it holds: the loop
 * is never held over 50 ms. The box's measuring rules (MASTER-NOTES): pinned cores, five runs,
 * the median with the load average beside it.
 */
import { existsSync, statSync } from 'node:fs'
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

// A database an app has open is never read: its write-ahead log is the sign.
const LIVE_MS = 10 * 60_000
for (const wal of [`${DB}-wal`, `${DB.replace(/\.db$/, '')}-cold.db-wal`]) {
  if (existsSync(wal) && statSync(wal).size > 0 && Date.now() - statSync(wal).mtimeMs < LIVE_MS) {
    console.error(`refused: ${DB} is in use (its write-ahead log moved in the last ten minutes). Bench on a copy:\n  sqlite3 ${DB} "VACUUM INTO '/tmp/review-bench/copy.db'"`)
    process.exit(2)
  }
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const ms = (n: number): string => `${n.toFixed(1)} ms`

const cold = DB.replace(/\.db$/, '') + '-cold.db'
// A copy made with VACUUM INTO has no cold file beside it (the archived threads' rows): an empty one is made, so the
// read finds the table it expects and the archived threads simply have no rows. The bench then times the hot file.
if (!existsSync(cold)) {
  const made = new DatabaseSync(cold)
  made.exec('CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq))')
  made.close()
}
const db = new DatabaseSync(DB, { readOnly: true })
db.prepare(`ATTACH DATABASE ? AS cold`).run(cold)

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
    `week ${back === 0 ? 'now' : `-${back}`}: ${cost.threads} threads opened, ${cost.rows.toLocaleString('en-US')} rows spanned, ${points} messages found, handed back ${cost.slices.toLocaleString('en-US')} times; ` +
      `the loop held longest ${ms(median(longest))} median, ${ms(Math.max(...longest))} worst; whole read ${ms(median(totals))} median (${RUNS} runs, load ${loadavg()[0]!.toFixed(1)})`
  )
}
db.close()
console.log(worst <= LIMIT_MS ? `ok: the loop was never held over ${LIMIT_MS} ms (worst ${ms(worst)})` : `FAIL: the loop was held ${ms(worst)}, over ${LIMIT_MS} ms`)
process.exit(worst <= LIMIT_MS ? 0 : 1)
