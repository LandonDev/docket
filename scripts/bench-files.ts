/**
 * The Files place's budget, measured (docs/agents/work-files.md "Performance"): `bun run script:bench-files`.
 *
 * A dummy library on this disk: one folder of 5,000 files and 20,000 more across 400 folders, every tenth one
 * sparse so it reads as a file a cloud app keeps elsewhere. Each number is the median of five runs of the real
 * wire (`work.files.*` through the module), on two pinned cores where the system can pin them. The numbers are
 * for a local disk; a real OneDrive folder is measured once on the Mac and written beside them in the docs.
 *
 *   --json     print the numbers as JSON only
 *   --keep     leave the dummy library where it was made (its path is printed)
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import type { FilesListing, FilesPlaces } from '../src/shared/contract-work-files'
import type { FileEntry } from '../src/shared/work/files'
import { closeFilesState, filesState } from '../src/main/server/work/files/handle'
import { files } from '../src/main/server/work/files/index'
import { putNames, type NameRow } from '../src/main/server/work/files/names'
import { forgetLibraries } from '../src/main/server/work/files/places/libraries'
import { forgetSearches } from '../src/main/server/work/files/search'
import { at, makeRig, window, WS } from '../src/main/server/work/files/testkit'
import { setVmCall } from '../src/main/server/work/office/vm/link'
import { setVmState } from '../src/main/server/work/office/vm/office'

const RUNS = 5
const BIG = 5_000
const FOLDERS = 400
const PER_FOLDER = 50

// Two cores of its own, where the system can give them: the numbers then move less with what else the machine does.
if (process.platform === 'linux' && !process.env.TC_BENCH_PINNED && cpus().length >= 4) {
  const cores = `${cpus().length - 2},${cpus().length - 1}`
  const pinned = spawnSync('taskset', ['-c', cores, process.execPath, ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, TC_BENCH_PINNED: cores } })
  if (pinned.error === undefined) process.exit(pinned.status ?? 1)
}

const json = process.argv.includes('--json')
const keep = process.argv.includes('--keep')
const say = (line: string): void => void (json ? undefined : console.log(line))

const rig = makeRig()
const big = join(rig.team, 'General', 'Big')
const many = join(rig.team, 'General', 'Many')
const EXTS = ['docx', 'xlsx', 'pptx', 'pdf', 'png', 'txt', 'mp4', 'csv']

function fill(dir: string, n: number, tag: string): void {
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < n; i++) {
    const path = join(dir, `${tag} ${String(i).padStart(5, '0')}.${EXTS[i % EXTS.length]}`)
    writeFileSync(path, i % 10 === 0 ? '' : 'x'.repeat(64 + (i % 7) * 100))
    // Its full size and no blocks: a file kept in the cloud.
    if (i % 10 === 0) truncateSync(path, 120_000 + i)
  }
}

say('making the dummy library…')
fill(big, BIG, 'File')
for (let f = 0; f < FOLDERS; f++) fill(join(many, `Folder ${String(f).padStart(3, '0')}`), PER_FOLDER, 'Doc')

// A Windows VM that is asleep and whose helper never answers: `places` must not wait on it.
setVmState(() => ({ state: 'asleep', cannot: null }))
rig.db.prepare(`INSERT INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(
  JSON.stringify({ at: Date.now() - 60_000, status: { onedrive: { installed: true, running: true, account: 'a@dummy.edu' }, mounts: [{ path: 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents', type: 'team', web: null }], office: { installed: true, version: null, apps: [], account: null, licensed: null } }, tops: {} })
)
setVmCall(() => new Promise(() => {}))

const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
  const out = await files.handle!({ id: 'bench', method, params: { workspaceId: WS, ...params } } as never, rig.ctx, window)
  if (!out.handled) throw new Error(`${method} was not handled`)
  return out.result as T
}
const timed = async <T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> => {
  const t0 = performance.now()
  const value = await fn()
  return { ms: performance.now() - t0, value }
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
/** A fresh pillar state: nothing kept of any folder or of the libraries, as after a launch. */
const cold = (): void => {
  closeFilesState(rig.db)
  forgetLibraries(rig.db)
}

interface Row {
  what: string
  ms: number
  budget: number | null
}
const rows: Row[] = []
async function measure(what: string, budget: number | null, run: () => Promise<number>): Promise<void> {
  const got: number[] = []
  for (let i = 0; i < RUNS; i++) got.push(await run())
  rows.push({ what, ms: Math.round(median(got) * 10) / 10, budget })
}

await measure('places, from what was kept, the VM asleep and its helper down', 50, async () => {
  cold()
  return (await timed(() => call<FilesPlaces>('work.files.places', {}))).ms
})
await measure(`first page of a ${BIG}-entry folder, cold`, 400, async () => {
  cold()
  const got = await timed(() => call<FilesListing>('work.files.list', { at: at(big) }))
  if (got.value.entries.length !== 500) throw new Error(`a page of ${got.value.entries.length}`)
  return got.ms
})
await measure(`first page of a ${BIG}-entry folder, warm`, 150, async () => {
  filesState(rig.ctx)
  await call<FilesListing>('work.files.list', { at: at(big) })
  return (await timed(() => call<FilesListing>('work.files.list', { at: at(big) }))).ms
})
await measure('a page after it', 50, async () => {
  const first = await call<FilesListing>('work.files.list', { at: at(big) })
  return (await timed(() => call<FilesListing>('work.files.list', { at: at(big), cursor: first.next }))).ms
})
await measure(`first page of a ${BIG}-entry folder by time, cold (every row is looked at)`, null, async () => {
  cold()
  return (await timed(() => call<FilesListing>('work.files.list', { at: at(big), sort: { by: 'changed', dir: 'desc' } }))).ms
})
await measure('a look at 100 rows again (stat)', null, async () => {
  const first = await call<FilesListing>('work.files.list', { at: at(big) })
  const refs = first.entries.slice(0, 100).map((e) => e.ref!)
  return (await timed(() => call('work.files.stat', { refs }))).ms
})
await measure(`a folder of ${FOLDERS} folders, cold`, null, async () => {
  cold()
  return (await timed(() => call<FilesListing>('work.files.list', { at: at(many) }))).ms
})

// Search by name: the 20,000 files across 400 folders and the 5,000 beside them, one name in each folder matching.
const QUERY = 'doc 00042'
const emptyNames = (): void => void rig.db.prepare(`DELETE FROM work_files_names`).run()
await measure(`a search by name over ${BIG + FOLDERS * PER_FOLDER} files, cold (the names table empty)`, 2000, async () => {
  cold()
  forgetSearches(rig.db)
  emptyNames()
  const got = await timed(() => call<FilesListing>('work.files.search', { query: QUERY }))
  if (got.value.entries.length !== 100 || !got.value.next) throw new Error(`a search found ${got.value.entries.length}`)
  return got.ms
})
await measure('the same, the names table warm', 2000, async () => {
  forgetSearches(rig.db)
  await new Promise((next) => setImmediate(next))
  if (!(rig.db.prepare(`SELECT count(*) AS n FROM work_files_names`).get() as { n: number }).n) throw new Error('the names table is empty')
  return (await timed(() => call<FilesListing>('work.files.search', { query: QUERY }))).ms
})
await measure('a page after it, from the kept search', 50, async () => {
  const first = await call<FilesListing>('work.files.search', { query: QUERY })
  return (await timed(() => call<FilesListing>('work.files.search', { query: QUERY, cursor: first.next }))).ms
})
// Go to: every file of the dummy library named in the table.
emptyNames()
const general = (await call<FilesPlaces>('work.files.places', {})).places.find((p) => p.name === 'General')!.id
const named: NameRow[] = []
const row = (dir: string, name: string, i: number): NameRow => {
  const path = join(dir, name)
  return { entry: { key: `lib:esportsstaffgeneral:${path.slice(join(rig.team, 'General').length + 1)}`, ref: at(path), folder: null, name, kind: 'document', changed: 1_700_000_000_000 + i } as FileEntry, place: general }
}
for (let i = 0; i < BIG; i++) named.push(row(big, `File ${String(i).padStart(5, '0')}.${EXTS[i % EXTS.length]}`, i))
for (let f = 0; f < FOLDERS; f++) for (let i = 0; i < PER_FOLDER; i++) named.push(row(join(many, `Folder ${String(f).padStart(3, '0')}`), `Doc ${String(i).padStart(5, '0')}.${EXTS[i % EXTS.length]}`, f * PER_FOLDER + i))
putNames(rig.db, WS, named)
await measure(`names (Go to) with ${named.length} names in the table`, 50, async () => {
  const got = await timed(() => call<{ entries: FileEntry[] }>('work.files.names', { text: 'doc 0004' }))
  if (got.value.entries.length !== 20) throw new Error(`Go to found ${got.value.entries.length}`)
  return got.ms
})

closeFilesState(rig.db)
setVmCall(null)
if (keep) say(`the dummy library is at ${rig.team}`)
else rig.close()

const over = rows.filter((r) => r.budget !== null && r.ms > r.budget)
if (json) console.log(JSON.stringify({ runs: RUNS, pinned: process.env.TC_BENCH_PINNED ?? null, files: BIG + FOLDERS * PER_FOLDER, rows }, null, 2))
else {
  say('')
  for (const r of rows) say(`${String(r.ms).padStart(8)} ms  ${r.budget === null ? '          ' : `(under ${String(r.budget).padStart(3)})`}  ${r.what}`)
  say('')
  say(over.length ? `over budget: ${over.map((r) => r.what).join('; ')}` : `every budget met (median of ${RUNS}${process.env.TC_BENCH_PINNED ? `, cores ${process.env.TC_BENCH_PINNED}` : ''})`)
}
process.exit(over.length ? 1 : 0)
