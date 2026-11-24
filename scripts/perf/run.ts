/**
 * Times what he does in Work, in his shape: a window paired by a remote key to a host that holds the job, the link
 * between them slowed to his tunnel, the host loaded by stand-in threads, all of it on a few cores of this machine.
 *
 *   bun run perf [--rows view-*,list-A] [--shape A,B1] [--link 60/10|none] [--load 24|0] [--cores 24-31]
 *                [--seconds 60] [--label before] [--keep] [--list]
 *
 * It is built on the journeys' own harness (scripts/journeys/lib): `win` is a windowed isolated instance under
 * xvfb driven over CDP, `box` a headless one that holds the Work workspace, `desk` a third machine, each with its
 * own data, its own empty WINVM_DIR and an environment stripped to PATH and locale. It needs a built tree
 * (`heavy bunx electron-vite build`) and runs through the queue: `.temp-code/bin/heavy bun run perf …`.
 *
 * One pair a run, many rows in it, and at most `--seconds` of measured work (the sum of each press's pressed-to-
 * usable time): rows past that are written "not run" and taken by the next run. While it measures it asks the
 * LIVE box for its hello every 5 s and stops with "the live box slowed" when two in a row pass 800 ms
 * (lib/guard.ts). Results: `.temp-code/plans/perf/runs/<date>-<id>/results.json`; scripts/perf/table.ts sets them
 * beside the budgets.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { startSandbox } from '../journeys/lib/lifeos'
import { SECTOR } from '../journeys/lib/lifeosSeed'
import { mainCheckout } from '../journeys/lib/record'
import { Pair, words } from '../journeys/lib/shape'
import { guardLiveBox } from './lib/guard'
import { perfProvider, startLoad } from './lib/load'
import { Counter, middle, type Sample, type SocketKind } from './lib/probe'
import { perfCtx, type Row } from './lib/row'
import { rowsMatching } from './rows'

export const LINK = { delayMs: 30, rateMbit: 10 }
export const LOAD = 24
export const CORES = 8
export const SECONDS = 60

export interface RowResult {
  id: string
  title: string
  samples: Sample[]
  /** the middle press by usable time */
  middle?: Sample
  /** this machine while the row ran: 1-minute load and GiB of programs in the agents' slice */
  machine: { load: number; anonGiB: number | null }
  notRun?: string
}
export interface RunResults {
  id: string
  at: string
  commit: string
  label?: string
  /** there-and-back delay in ms and the rate each way in Mbit/s; null with no slowing */
  link: { rttMs: number; rateMbit: number } | null
  load: number
  cores: string
  rows: RowResult[]
  /** the live box's hello times while the run measured, ms */
  guard: (number | null)[]
  error?: string
}

export interface Flags {
  rows?: string[]
  shapes?: string[]
  link: { delayMs: number; rateMbit: number } | null
  load: number
  cores: string
  seconds: number
  label?: string
  keep: boolean
  list: boolean
}

/** `60/10` is 60 ms there and back at 10 Mbit/s each way; `none` leaves the link alone. */
export function parseLink(text: string | undefined): Flags['link'] {
  if (text === undefined) return LINK
  if (text === 'none') return null
  const match = text.match(/^(\d+)\/(\d+(?:\.\d+)?)$/)
  if (!match) throw new Error('--link is <ms there and back>/<Mbit a second>, or none')
  return { delayMs: Number(match[1]) / 2, rateMbit: Number(match[2]) }
}

/** The last `count` cores: the live service and the other threads' jobs start from the first. */
export const lastCores = (count: number, all = availableParallelism()): string => `${Math.max(0, all - count)}-${all - 1}`

export function flags(args: string[]): Flags {
  const { values } = parseArgs({
    args,
    options: {
      rows: { type: 'string' }, shape: { type: 'string' }, link: { type: 'string' }, load: { type: 'string' }, cores: { type: 'string' },
      seconds: { type: 'string' }, label: { type: 'string' }, keep: { type: 'boolean' }, list: { type: 'boolean' }
    }
  })
  const number = (name: string, text: string | undefined, fallback: number): number => {
    if (text === undefined) return fallback
    if (!/^\d+$/.test(text)) throw new Error(`--${name} is a whole number`)
    return Number(text)
  }
  const cores = values.cores ?? lastCores(CORES)
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(cores)) throw new Error('--cores is a taskset list, as 24-31')
  return {
    rows: values.rows?.split(','), shapes: values.shape?.split(','), link: parseLink(values.link),
    load: number('load', values.load, LOAD), cores, seconds: number('seconds', values.seconds, SECONDS),
    label: values.label, keep: !!values.keep, list: !!values.list
  }
}

/** The rows a run takes: by id pattern, then by the shape a row's id ends in (a row with no shape runs in any). */
export function chosen(f: Pick<Flags, 'rows' | 'shapes'>): Row[] {
  const shape = (id: string): string | undefined => id.match(/-(A|B1|B2)$/)?.[1]
  return rowsMatching(f.rows).filter((row) => !f.shapes || !shape(row.id) || f.shapes.includes(shape(row.id)!))
}

/** How many cores of a taskset list. */
export const coreCount = (list: string): number =>
  list.split(',').reduce((n, part) => n + (part.includes('-') ? Number(part.split('-')[1]) - Number(part.split('-')[0]) + 1 : 1), 0)

function machine(): RowResult['machine'] {
  let anonGiB: number | null = null
  try {
    const anon = readFileSync('/sys/fs/cgroup/agents.slice/memory.stat', 'utf8').match(/^anon (\d+)/m)?.[1]
    if (anon) anonGiB = Math.round((Number(anon) / 2 ** 30) * 10) / 10
  } catch {
    // not the box
  }
  return { load: Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]), anonGiB }
}

const measured = (samples: Sample[]): number => samples.reduce((ms, s) => ms + (s.usable ?? 30_000), 0)

async function main(): Promise<number> {
  const f = flags(process.argv.slice(2))
  const rows = chosen(f)
  if (f.list) {
    for (const row of rows) console.log(`${row.id} · ${row.title}`)
    return 0
  }
  if (!rows.length) throw new Error('No perf rows match those flags')
  if (coreCount(f.cores) > CORES) throw new Error(`A perf run takes at most ${CORES} cores`)
  // Every process this run starts inherits the pin.
  execFileSync('taskset', ['-cp', f.cores, String(process.pid)], { stdio: 'ignore' })
  const repo = resolve(import.meta.dir, '../..')
  const { requireBuild } = await import('../journeys/run')
  requireBuild(repo)
  const base = join(mainCheckout(repo), '.temp-code')
  mkdirSync(join(base, 'journeys'), { recursive: true })
  // The LifeOS sandbox takes only a walk folder two levels under the journeys' runs.
  const runRoot = realpathSync(mkdtempSync(join(base, 'journeys', new Date().toISOString().slice(0, 10) + '-perf')))
  const folder = join(runRoot, 'pair')
  mkdirSync(folder)
  const id = basename(runRoot)
  const out = join(base, 'plans/perf/runs', id)
  mkdirSync(out, { recursive: true })
  const results: RunResults = {
    id, at: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    ...(f.label ? { label: f.label } : {}),
    link: f.link ? { rttMs: f.link.delayMs * 2, rateMbit: f.link.rateMbit } : null, load: f.load, cores: f.cores, rows: [], guard: []
  }
  const save = (): void => writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  const pair = new Pair(repo, folder)
  const guard = guardLiveBox(pair.abort)
  const onSignal = (signal: NodeJS.Signals): void => pair.abort.abort(new Error(`Run stopped by ${signal}`))
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const stop = new Promise<never>((_, reject) => pair.abort.signal.addEventListener('abort', () => reject(pair.abort.signal.reason), { once: true }))
  void stop.catch(() => undefined)
  console.log(`Perf run ${id}: ${rows.length} rows, link ${f.link ? `${f.link.delayMs * 2} ms, ${f.link.rateMbit} Mbit/s` : 'unslowed'}, ${f.load} stand-in threads, cores ${f.cores}`)
  try {
    const need = (key: 'sandbox' | 'fake' | 'desk'): boolean => rows.some((row) => row.needs?.[key])
    if (need('sandbox')) pair.sandbox = await startSandbox(folder, pair.abort.signal, false)
    // The load's streams outlast the run: the provider ends each after an hour.
    const workspace = await pair.open(need('desk'), `Perf ${id.slice(-6)}`, {
      fake: true, localTools: true, sector: SECTOR, ...(f.link ? { link: f.link } : {}), provider: perfProvider(3600)
    })
    const other = await pair.workspace(`Perf other ${id.slice(-6)}`, 'life')
    const lifeos = pair.sandbox ? new URL(pair.sandbox.url).port : ''
    const link = String(pair.windowLink?.port ?? pair.box.remote)
    const kindOf = (url: string): SocketKind => {
      const port = new URL(url).port
      return port === link ? 'box' : lifeos && port === lifeos ? 'lifeos' : port === String(pair.win.port) ? 'own' : 'other'
    }
    const counter = new Counter(pair.page, kindOf)
    // The sockets opened before the counter was there are opened again under it.
    await pair.page.reload()
    await pair.page.until('the window link to box again', 60_000, () => pair.page.eval(
      `window.__monocode?.registry.has(${JSON.stringify(pair.box.host)}) && window.__monocode.registry.statusOf(${JSON.stringify(pair.box.host)}).transport === 'open'`))
    if (pair.sandbox) await pair.checkSeededMail(workspace)
    if (f.load > 0) {
      const busy = await pair.workspace(`Perf load ${id.slice(-6)}`, 'ref')
      await startLoad(pair, busy.id, f.load)
    }
    const ctx = perfCtx({ pair, page: pair.page, counter, workspace, other, repo, folder })
    let spent = 0
    for (const row of rows) {
      pair.abort.signal.throwIfAborted()
      const result: RowResult = { id: row.id, title: row.title, samples: [], machine: machine() }
      results.rows.push(result)
      if (spent >= f.seconds * 1000) {
        result.notRun = `the run's ${f.seconds} s of measured work were used`
        continue
      }
      try {
        result.samples = await Promise.race([row.run(ctx), stop])
        result.middle = middle(result.samples)
        spent += measured(result.samples)
        const m = result.middle
        console.log(`ROW ${row.id}: ${m?.usable == null ? 'never usable' : Math.round(m.usable) + ' ms'}, T ${m?.counts.tAll ?? '-'}, C ${m?.counts.c ?? '-'}${m?.error ? ' (' + m.error + ')' : ''}`)
      } catch (error) {
        result.notRun = words(error)
        console.error(`ROW ${row.id} did not run: ${result.notRun}`)
        await pair.page.shot(join(out, row.id + '.png')).catch(() => undefined)
        await pair.page.dismissPopups().catch(() => undefined)
      }
      save()
    }
  } catch (error) {
    results.error = words(pair.abort.signal.aborted ? pair.abort.signal.reason : error)
    console.error(results.error)
  } finally {
    results.guard = guard.stop()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    save()
    const stopped = await pair.stop().catch((error) => ({ remainingPids: [], remainingPorts: [], errors: [words(error)] }))
    if (stopped.errors.length) console.error('Cleanup: ' + stopped.errors.join(' | '))
    if (!f.keep && !stopped.remainingPids.length && !stopped.remainingPorts.length) rmSync(runRoot, { recursive: true, force: true })
    else console.log(`Kept ${runRoot}`)
  }
  console.log(`Results ${join(out, 'results.json')}`)
  return results.error ? 1 : 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(words(error))
    process.exitCode = 1
  }
}
