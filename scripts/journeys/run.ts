import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
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
import j20 from './J20-guest-link'
import j21 from './J21-office-live'
import j24 from './J24-away-library'
import j27 from './J27-show-clicker'
import j28 from './J28-templates'
import j29 from './J29-held-word'
import j30 from './J30-direct-undo'
import j31 from './J31-thread-file'
import j32 from './J32-held-mail'
import j33 from './J33-mail-undo'
import j34 from './J34-mail-scheduled'
import j40 from './J40-task-today'
import j41 from './J41-agenda-clash'
import j43 from './J43-meeting-recording'
import j45 from './J45-receipt'
import j46 from './J46-invoice-export'
import j47 from './J47-routine'
import j48, { PLAY_SECTOR } from './J48-play'
import j49 from './J49-capture'
import j52 from './J52-return'
import j53 from './J53-work-switch'
import j54 from './J54-pair-computer'
import j55 from './J55-connections'
import j56 from './J56-link-loss'
import j57 from './J57-two-windows'
import j58 from './J58-chat-starts'
import j59 from './J59-light-windows'
import j60 from './J60-browser-canvas'
import { startSandbox } from './lib/lifeos'
import { SECTOR, ZONE } from './lib/lifeosSeed'
import { mainCheckout, saveResults, step, walk, type Results } from './lib/record'
import { Pair, SHAPES, words } from './lib/shape'
import { writeJourneysTable } from './table'

export const JOURNEYS = [j01, j02, j03, j04, j05, j06, j07, j08, j09, j10, j11, j12, j13, j14, j15, j16, j17, j18, j19, j20, j21, j22, j23, j24, j25, j26, j27, j28, j29, j30, j31, j32, j33, j34, j40, j41, j43, j45, j46, j47, j48, j49, j52, j53, j54, j55, j56, j57, j58, j59, j60]

const needsSandbox = ({ id, shapes }: typeof JOURNEYS[number]) => shapes.includes('S') || ['J48', 'J49', 'J59'].includes(id)

export function options(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      only: { type: 'string' },
      shape: { type: 'string' },
      tier: { type: 'string' },
      list: { type: 'boolean' },
      keep: { type: 'boolean' },
      desk: { type: 'boolean' },
      'no-table': { type: 'boolean' }
    }
  })
  const ids = values.only?.split(',')
  const shapes = values.shape?.split(',')
  if (ids?.some((id) => !JOURNEYS.some((j) => j.id === id))) throw new Error('Unknown journey in --only')
  if (shapes?.some((shape) => !SHAPES.some((s) => s === shape))) throw new Error('Unknown shape in --shape')
  if (values.tier && !/^[1-9]\d*$/.test(values.tier)) throw new Error('--tier must be a positive integer')
  const selected = ids ? [...new Set(ids)].map((id) => JOURNEYS.find((spec) => spec.id === id)!) : JOURNEYS
  const jobs = selected.flatMap((spec) => {
    if (values.tier && spec.tier !== Number(values.tier)) return []
    return spec.shapes.filter((shape) => !shapes || shapes.includes(shape)).map((shape) => ({ spec, shape }))
  })
  if (!jobs.length) throw new Error('No journeys match those flags')
  return {
    jobs, list: values.list, keep: values.keep, noTable: values['no-table'],
    sandbox: jobs.some(({ spec }) => needsSandbox(spec)),
    desk: values.desk || jobs.some(({ shape }) => shape === 'B2')
  }
}

export function boxChromium(cache: string): string | undefined {
  if (!existsSync(cache)) return undefined
  return readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    .flatMap(name => ['chrome-linux64', 'chrome-linux'].map(dir => join(cache, name, dir, 'chrome'))).find(path => existsSync(path))
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
    if (flags.sandbox) {
      try {
        pair.sandbox = await startSandbox(root, pair.abort.signal, flags.jobs.some(({ spec }) => spec.id === 'J32'))
        for (const url of [pair.sandbox.url, pair.sandbox.siteUrl, pair.sandbox.mcpUrl]) pair.trackPort(Number(new URL(url).port))
      } catch (error) {
        results.journeys = flags.jobs.filter(({ spec }) => needsSandbox(spec)).map(({ spec, shape }) => ({
          id: spec.id, title: spec.title, shape, steps: [], notRun: 'no sandbox'
        }))
        throw new Error('not run: no sandbox: ' + words(error))
      }
    }
    let checkedMail = false
    const has = (id: string) => flags.jobs.some(({ spec }) => spec.id === id)
    const setup = {
      browser: has('J60'),
      zone: has('J47') ? ZONE : undefined,
      chromium: has('J60') ? boxChromium(join(homedir(), '.cache/ms-playwright')) : undefined,
      localTools: ['J43', 'J45', 'J46', 'J59', 'J60'].some(has),
      fake: flags.jobs.some(({ spec }) => ['J12', 'J31', 'J47', 'J48', 'J49', 'J58', 'J60'].includes(spec.id)),
      capture: flags.jobs.some(({ spec }) => spec.id === 'J49'),
      hosted: ['J22', 'J29', 'J59'].some(has),
      guests: has('J20'),
      guestTheme: has('J59'),
      cut: flags.jobs.some(({ spec }) => spec.id === 'J56')
    }
    for (const [i, { spec, shape }] of flags.jobs.entries()) {
      pair.abort.signal.throwIfAborted()
      const name = `${spec.id} ${shape} ${root.slice(-6)}`
      const sector = spec.shapes.includes('S') ? SECTOR : undefined
      const workspaceSector = spec.id === 'J45' ? 'ref' : spec.id === 'J46' ? 'unify' : spec.id === 'J48' ? PLAY_SECTOR : sector
      const workspace = i === 0
        ? await pair.open(!!flags.desk, name, { ...setup, sector: workspaceSector })
        : await pair.workspace(name, workspaceSector)
      const folder = join(root, `${spec.id}-${shape}`)
      try {
        const steps = sector && !checkedMail
          ? [step('See the seeded Spring LAN mail in the window', async () => {
              await pair.checkSeededMail(workspace)
              checkedMail = true
            }), ...spec.steps]
          : spec.steps
        results.journeys.push(await walk({ ...spec, steps }, { pair, shape, workspace, folder }, stop))
        saveResults(root, results)
      } finally {
        await pair.afterWalk()
        if (sector && i < flags.jobs.length - 1 && !pair.abort.signal.aborted) {
          await pair.rpc(pair.box, 'workspace.delete', { workspaceId: workspace.id })
        }
      }
    }
    pair.abort.signal.throwIfAborted()
  } catch (error) {
    results.error = words(error)
    console.error(results.error)
  } finally {
    try {
      results.cleanup = await pair.stop()
      if (!flags.keep && !results.cleanup.remainingPids.length && !results.cleanup.errors.length) {
        for (const seat of ['win', 'box', 'desk', 'given', 'giver']) {
          for (const suffix of ['home', 'data', 'tmp']) rmSync(join(root, seat + '-' + suffix), { recursive: true, force: true })
        }
        rmSync(join(root, 'bin'), { recursive: true, force: true })
        const lifeos = join(root, 'lifeos')
        if (existsSync(lifeos)) {
          for (const entry of readdirSync(lifeos).filter((file) => !file.endsWith('.log'))) {
            rmSync(join(lifeos, entry), { recursive: true, force: true })
          }
        }
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
  if (!flags.noTable) writeJourneysTable(join(base, 'plans/landed/POLISH-work.md'), results)
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
