import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import j01 from './J01-deck-title'
import j02 from './J02-workbook-close'
import j03 from './J03-library-chart'
import j04 from './J04-library-word'
import j05 from './J05-document-export'
import j06 from './J06-new-deck'
import j07 from './J07-library-text'
import j08 from './J08-pdf-marks'
import j09 from './J09-library-media'
import j10 from './J10-ask-a-pdf'
import j11 from './J11-dock-and-side-files'
import j12 from './J12-row-and-chip'
import j13 from './J13-rename-open-file'
import j14 from './J14-move-open-file'
import j15 from './J15-trash-and-restore'
import j16 from './J16-outside-files'
import j17 from './J17-file-actions'
import j18 from './J18-file-search'
import j19 from './J19-starred-recent'
import j22 from './J22-full-sheet-editor'
import j23 from './J23-legacy-copies'
import j25 from './J25-document-history'
import j26 from './J26-print-editors'
import { mainCheckout, saveResults, walk, type Results } from './lib/record'
import { Pair, SHAPES, words } from './lib/shape'
import { writeJourneysTable } from './table'

export const JOURNEYS = [j01, j02, j03, j04, j05, j06, j07, j08, j09, j10, j11, j12, j13, j14, j15, j16, j17, j18, j19, j22, j23, j25, j26]

export function options(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      only: { type: 'string' },
      shape: { type: 'string' },
      tier: { type: 'string' },
      list: { type: 'boolean' },
      keep: { type: 'boolean' },
      desk: { type: 'boolean' }
    }
  })
  const ids = values.only?.split(',')
  const shapes = values.shape?.split(',')
  if (ids?.some((id) => !JOURNEYS.some((j) => j.id === id))) throw new Error('Unknown journey in --only')
  if (shapes?.some((shape) => !SHAPES.some((s) => s === shape))) throw new Error('Unknown shape in --shape')
  if (values.tier && !/^[1-9]\d*$/.test(values.tier)) throw new Error('--tier must be a positive integer')
  const jobs = JOURNEYS.flatMap((spec) => {
    if ((ids && !ids.includes(spec.id)) || (values.tier && spec.tier !== Number(values.tier))) return []
    return spec.shapes.filter((shape) => !shapes || shapes.includes(shape)).map((shape) => ({ spec, shape }))
  })
  if (!jobs.length) throw new Error('No journeys match those flags')
  return { jobs, list: values.list, keep: values.keep, desk: values.desk || jobs.some(({ shape }) => shape === 'B2') }
}

export function requireBuild(repo: string): void {
  const files = ['out/main/boot.js', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
  const advice = 'Run heavy bunx electron-vite build.'
  if (files.some((file) => !existsSync(join(repo, file)))) throw new Error(`The built tree is missing. ${advice}`)
  const oldest = Math.min(...files.map((file) => statSync(join(repo, file)).mtimeMs))
  const src = join(repo, 'src')
  for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && statSync(join(entry.parentPath, entry.name)).mtimeMs > oldest) {
      throw new Error(`The built tree is older than src/. ${advice}`)
    }
  }
}

async function main(): Promise<number> {
  const flags = options(process.argv.slice(2))
  if (flags.list) {
    for (const { spec, shape } of flags.jobs) console.log(`${spec.id} ${shape} tier ${spec.tier} · ${spec.title}`)
    return 0
  }
  const repo = resolve(import.meta.dir, '../..')
  requireBuild(repo)
  const base = join(mainCheckout(repo), '.temp-code')
  const runs = join(base, 'journeys')
  mkdirSync(runs, { recursive: true })
  const root = realpathSync(mkdtempSync(join(runs, new Date().toISOString().slice(0, 10) + '-')))
  const pair = new Pair(repo, root)
  const results: Results = { journeys: [] }
  const stop = new Promise<never>((_, reject) => {
    pair.abort.signal.addEventListener('abort', () => reject(pair.abort.signal.reason), { once: true })
  })
  void stop.catch(() => undefined)
  const onSignal = (signal: NodeJS.Signals): void => pair.abort.abort(new Error(`Run stopped by ${signal}`))
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  console.log(`Journey run ${root}`)
  try {
    const setup = {
      fake: flags.jobs.some(({ spec }) => spec.id === 'J12'),
      fullEditor: flags.jobs.some(({ spec }) => spec.id === 'J22')
    }
    for (const [i, { spec, shape }] of flags.jobs.entries()) {
      pair.abort.signal.throwIfAborted()
      const name = `${spec.id} ${shape} ${root.slice(-6)}`
      const workspace = i === 0 ? await pair.open(!!flags.desk, name, setup) : await pair.workspace(name)
      const folder = join(root, `${spec.id}-${shape}`)
      results.journeys.push(await walk(spec, { pair, shape, workspace, folder }, stop))
      saveResults(root, results)
    }
    pair.abort.signal.throwIfAborted()
  } catch (error) {
    results.error = words(error)
    console.error(results.error)
  } finally {
    try {
      results.cleanup = await pair.stop()
      if (!flags.keep && !results.cleanup.remainingPids.length && !results.cleanup.errors.length) {
        for (const seat of ['win', 'box', 'desk']) {
          for (const suffix of ['home', 'data', 'tmp']) rmSync(join(root, seat + '-' + suffix), { recursive: true, force: true })
        }
        rmSync(join(root, 'bin'), { recursive: true, force: true })
      }
    } catch (error) {
      results.error ??= words(error)
      console.error(words(error))
    } finally {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      saveResults(root, results)
    }
  }
  writeJourneysTable(join(base, 'plans/landed/POLISH-work.md'), results)
  console.log(`Results ${join(root, 'results.json')}`)
  const failed = results.error || results.cleanup?.errors.length || results.cleanup?.remainingPids.length
    || results.journeys.some(({ steps }) => steps.some((step) => step.error))
  return failed ? 1 : 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(words(error))
    process.exitCode = 1
  }
}
