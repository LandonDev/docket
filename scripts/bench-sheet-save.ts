/**
 * What saving one cell into an opened Excel file costs (docs/agents/work-sheets.md "Packages";
 * the editors plan's sheets decision 3). The sheet research lab's bench, in the repo:
 *
 *   taskset -c 2,3 bun scripts/bench-sheet-save.ts
 *   taskset -c 2,3 bun scripts/bench-sheet-save.ts --sizes 100,10000 --runs 5 --json /tmp/save.json
 *   taskset -c 2,3 bun scripts/bench-sheet-save.ts --sizes 0 --dense-runs 3      (the dense file alone)
 *
 * It makes the lab's four workbooks (two number columns, a formula every tenth row, one more that
 * hangs off the first), sets A1 and times, per size:
 *
 *   worker      the save job the sheet worker runs (jobs.ts), here in this process through
 *               `localJobs`, so with no message to a utility process: read, patch, IronCalc, zip,
 *               write. The workbook's import is kept between runs, as the lab's was.
 *   commit      his edit to the committed revision (`PackageStore.edit`): the plan, the job, the
 *               rename over the file, the kept copy, the rows. Each run saves on the last, so the
 *               import is fresh every time, as it is in the app.
 *   bold        his press to the committed revision for formatting alone (SHT2: the format writer)
 *   lone        the same for a value typed where no formula reads it (SHT2: the proof, no engine);
 *               the name says which path the proof chose
 *   floor-skip  the patch writer with no engine and no audit, on a cell nothing reads: what a save
 *               costs once the engine is skipped.
 *   floor-style a bold font appended and A1 pointed at it, both parts zipped: the least a style-only
 *               save can cost.
 *
 * and the dense corpus file (800,002 formulas; `--dense <path>`, else the research lab's copy) on
 * the first two, three runs (`--dense-runs`), its import warmed first. The box's measuring rules (MASTER-NOTES): pin the cores with taskset, the
 * variants interleaved so they see the same load, five runs, the median with the load average
 * beside it, and a mark where the spread is too wide to rule on.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SET_RANGE_VALUES } from '../src/main/server/work/sheets/mutations'
import { ensurePackageTables, PACKAGE_UNIT, PackageStore } from '../src/main/server/work/sheets/packages'
import { patchXlsx } from '../src/main/server/work/sheets/patch/patch'
import type { EngineResult } from '../src/main/server/work/sheets/patch/recalc'
import { readText, readZip, writeZip } from '../src/main/server/work/sheets/patch/zip'
import { EMPTY_ZIP } from '../src/main/server/work/sheets/writer'
import { localJobs } from '../src/main/server/work/sheets/workerClient'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? undefined : process.argv[i + 1]
}
const SIZES = (arg('sizes') ?? '100,10000,100000,500000').split(',').map(Number).filter((n) => n > 0)
const RUNS = Number(arg('runs') ?? 5)
const DENSE_RUNS = Number(arg('dense-runs') ?? 3)
const IRONCALC = process.env.IRONCALC_DIR ?? '/srv/agents/temp-code-data/work-tools/ironcalc/0.9.1'
/** The research lab's corpus holds the two big files (roundtrip.test.ts reads them from the same place). */
const DENSE = arg('dense') ?? join(process.env.SHEET_CORPUS_BIG ?? '/srv/agents/work/temp-code/.temp-code/reports/nJLC5WoplSWf/lab/corpus', 'big_100k.xlsx')
/** `--fixtures <dir>` times workbooks made elsewhere (`rows-<n>.xlsx`, the lab's own) in place of ours. */
const FIXTURES = arg('fixtures')
const scratch = arg('dir') ?? mkdtempSync(join(tmpdir(), 'bench-sheet-save-'))
mkdirSync(scratch, { recursive: true })

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml'
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** The lab's workbook of `n` rows, as XlsxWriter wrote it: A and B numbers, C a formula every tenth row, D1 on C1. */
export function rowsWorkbook(n: number): Uint8Array {
  const rows: string[] = []
  for (let r = 1; r <= n; r++) {
    let cells = `<c r="A${r}"><v>${r}</v></c><c r="B${r}"><v>${r + 1}</v></c>`
    if (r % 10 === 1) cells += `<c r="C${r}"><f>A${r}*2</f><v>${r * 2}</v></c>`
    if (r === 1) cells += '<c r="D1"><f>C1+1</f><v>3</v></c>'
    rows.push(`<row r="${r}">${cells}</row>`)
  }
  const enc = new TextEncoder()
  const parts = new Map<string, string>([
    [
      '[Content_Types].xml',
      `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.worksheet+xml"/></Types>`
    ],
    ['_rels/.rels', `${HEAD}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${HEAD}<workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`],
    [
      'xl/_rels/workbook.xml.rels',
      `${HEAD}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`
    ],
    [
      'xl/styles.xml',
      `${HEAD}<styleSheet xmlns="${NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
    ],
    ['xl/worksheets/sheet1.xml', `${HEAD}<worksheet xmlns="${NS}"><dimension ref="A1:D${n}"/><sheetData>${rows.join('')}</sheetData></worksheet>`]
  ])
  return writeZip(readZip(EMPTY_ZIP), new Map(), new Set(), new Map([...parts].map(([name, xml]) => [name, enc.encode(xml)])))
}

const SHEET = 'xl/worksheets/sheet1.xml'
const STYLES = 'xl/styles.xml'
const cached = (bytes: Uint8Array, cell: string): number => {
  const m = new RegExp(`<c r="${cell}"[^>]*>[\\s\\S]*?<v>([^<]+)</v>`).exec(readText(readZip(bytes), SHEET))
  if (!m) throw new Error(`${cell} has no value`)
  return Number(m[1])
}
const check = (bytes: Uint8Array, want: Record<string, number>): void => {
  for (const [cell, value] of Object.entries(want)) if (cached(bytes, cell) !== value) throw new Error(`${cell} is ${cached(bytes, cell)}, wanted ${value}`)
}
const noEngine = (): EngineResult => ({ engine: 'none', ok: true, changed: [], editValues: {}, editErrors: [], auditBefore: {}, timings: { loadMs: 0, evalMs: 0, applyMs: 0, snapshotMs: 0 } })

interface Variant {
  name: string
  /** one timed save; answers milliseconds */
  run(i: number): Promise<number>
}

async function variantsFor(input: string, label: string, dense: boolean): Promise<Variant[]> {
  const jobs = await localJobs()
  const dir = join(scratch, label)
  mkdirSync(dir, { recursive: true })
  const edit = dense
    ? ((JSON.parse(readFileSync(resolve(__dirname, '../src/main/server/work/sheets/harness/corpus/manifest.json'), 'utf8')) as { files: { file: string; edit: { sheet: string; cell: string; value: string } }[] }).files.find((f) => f.file === 'big_100k.xlsx')!.edit)
    : null

  // commit: a store of its own over a copy the saves pile onto
  const live = join(dir, 'live.xlsx')
  copyFileSync(input, live)
  const db = new DatabaseSync(join(dir, 'bench.db'))
  ensurePackageTables(db)
  const store = new PackageStore(db, jobs, join(dir, 'copies'), () => IRONCALC)
  const opened = await store.open(live)
  const sheet = opened.inspected.sheets.find((s) => s.name === (edit?.sheet ?? 'Data')) ?? opened.inspected.sheets[0]
  const at = edit ? /^([A-Z]+)(\d+)$/.exec(edit.cell)! : null
  const row = at ? Number(at[2]) - 1 : 0
  const col = at ? [...at[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : 0
  let rev = opened.rev

  const out = join(dir, 'worker.xlsx')
  const variants: Variant[] = [
    {
      name: 'worker',
      async run(i) {
        const value = 117 + i
        const t = performance.now()
        const got = await jobs.save(input, out, [edit ? { ...edit, value: String(Number(edit.value) + i) } : { sheet: 'Data', cell: 'A1', value }], IRONCALC)
        const ms = performance.now() - t
        if (!got.report.recalc.ok) throw new Error(`recalc failed: ${got.report.recalc.error}`)
        if (!dense) check(new Uint8Array(readFileSync(out)), { A1: value, B1: 2, C1: value * 2, D1: value * 2 + 1 })
        return ms
      }
    },
    {
      name: 'commit',
      async run(i) {
        const value = edit ? Number(edit.value) + i : 117 + i
        const t = performance.now()
        const got = await store.edit(live, rev, [{ id: SET_RANGE_VALUES, params: { unitId: PACKAGE_UNIT, subUnitId: sheet.id, cellValue: { [row]: { [col]: { v: value } } } } }], 'owner')
        const ms = performance.now() - t
        if ('conflict' in got) throw new Error('the bench met a conflict')
        rev = got.rev
        if (!dense) check(new Uint8Array(readFileSync(live)), { A1: value, C1: value * 2, D1: value * 2 + 1 })
        return ms
      }
    }
  ]
  // SHT2's two light paths, timed as he meets them: his press to the committed revision.
  // bold: formatting alone (the format writer; no workbook model, no engine).
  // lone: a value typed where no formula reads it (the proof reads every formula's text; no engine).
  const far = dense ? { row: 5, col: 700 } : { row: 0, col: 1 }
  const tab = sheet.name
  const farAt = `${colLetters(far.col)}${far.row + 1}`
  const path = async (edits: { sheet: string; cell: string; value: number }[], formats: unknown[]): Promise<string> => (await jobs.save(live, join(dir, 'probe.xlsx'), edits, IRONCALC, formats as never)).report.path
  const bold = { id: SET_RANGE_VALUES, params: { subUnitId: tab, cellValue: { [row]: { [col]: { s: { bl: 1 } } } } } }
  if ((await path([], [bold])) !== 'format') throw new Error('a bold cell did not take the format path')
  const lonePath = await path([{ sheet: tab, cell: farAt, value: 1 }], [])
  if (!dense && lonePath !== 'independent') throw new Error(`a value nothing reads took the ${lonePath} path`)
  variants.push(
    {
      name: 'bold',
      async run(i) {
        const t = performance.now()
        const got = await store.edit(live, rev, [{ id: SET_RANGE_VALUES, params: { unitId: PACKAGE_UNIT, subUnitId: sheet.id, cellValue: { [row]: { [col]: { s: { bl: i % 2 ? null : 1 } } } } } }], 'owner')
        const ms = performance.now() - t
        if ('conflict' in got) throw new Error('the bench met a conflict')
        rev = got.rev
        return ms
      }
    },
    {
      // On the dense file this says which path the proof chose: its 800,002 formulas are all read first.
      name: `lone(${lonePath})`,
      async run(i) {
        const t = performance.now()
        const got = await store.edit(live, rev, [{ id: SET_RANGE_VALUES, params: { unitId: PACKAGE_UNIT, subUnitId: sheet.id, cellValue: { [far.row]: { [far.col]: { v: 200 + i } } } } }], 'owner')
        const ms = performance.now() - t
        if ('conflict' in got) throw new Error('the bench met a conflict')
        rev = got.rev
        return ms
      }
    }
  )
  if (dense) return variants
  return [
    ...variants,
    {
      name: 'floor-skip',
      async run() {
        const t = performance.now()
        const { bytes } = await patchXlsx(new Uint8Array(readFileSync(input)), [{ sheet: 'Data', cell: 'B1', value: 117 }], { audit: false, inputPath: input, recalc: noEngine })
        writeFileSync(join(dir, 'skip.xlsx'), bytes)
        const ms = performance.now() - t
        check(bytes, { A1: 1, B1: 117, C1: 2, D1: 3 })
        return ms
      }
    },
    {
      name: 'floor-style',
      async run() {
        const t = performance.now()
        const z = readZip(new Uint8Array(readFileSync(input)))
        const sheetXml = readText(z, SHEET).replace('<c r="A1">', '<c r="A1" s="1">')
        const styles = readText(z, STYLES)
        const font = /<font>.*?<\/font>/.exec(styles)![0].replace('<font>', '<font><b/>')
        const xf = /<cellXfs count="1">(<xf.*?\/>)<\/cellXfs>/.exec(styles)![1].replace('fontId="0"', 'fontId="1" applyFont="1"')
        const patched = styles.replace('<fonts count="1">', '<fonts count="2">').replace('</fonts>', `${font}</fonts>`).replace('<cellXfs count="1">', '<cellXfs count="2">').replace('</cellXfs>', `${xf}</cellXfs>`)
        const enc = new TextEncoder()
        const bytes = writeZip(z, new Map([[SHEET, enc.encode(sheetXml)], [STYLES, enc.encode(patched)]]), new Set(), new Map())
        writeFileSync(join(dir, 'style.xlsx'), bytes)
        const ms = performance.now() - t
        if (!/<c r="A1" s="1">/.test(readText(readZip(bytes), SHEET))) throw new Error('A1 was not styled')
        check(bytes, { A1: 1, B1: 2, C1: 2, D1: 3 })
        return ms
      }
    }
  ]
}

function colLetters(col: number): string {
  let name = ''
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const cpus = /^Cpus_allowed_list:\s*(.+)$/m.exec(existsSync('/proc/self/status') ? readFileSync('/proc/self/status', 'utf8') : '')?.[1] ?? 'unknown'

interface Row {
  file: string
  mib: number
  variant: string
  runs: number[]
  median: number
  spread: number
  load: number
}

/** One warm-up each, then the variants in turn, `runs` times over: A, B, C, A, B, C. */
async function bench(input: string, label: string, runs: number, dense: boolean): Promise<Row[]> {
  const variants = await variantsFor(input, label, dense)
  const samples = new Map(variants.map((v) => [v.name, [] as number[]]))
  const loads: number[] = []
  // A warm-up each; the dense file's is its import alone (a save of it takes ten seconds and more).
  if (dense) await (await localJobs()).inspect(input)
  else for (const v of variants) await v.run(0)
  for (let i = 1; i <= runs; i++) {
    for (const v of variants) {
      Bun.gc(true)
      samples.get(v.name)!.push(await v.run(i))
      loads.push(loadavg()[0])
    }
  }
  return variants.map((v) => {
    const xs = samples.get(v.name)!
    const m = median(xs)
    return { file: label, mib: statSync(input).size / 1048576, variant: v.name, runs: xs.map((x) => Math.round(x * 10) / 10), median: Math.round(m * 10) / 10, spread: xs.length > 1 ? (Math.max(...xs) - Math.min(...xs)) / m : 0, load: Math.round(median(loads) * 100) / 100 }
  })
}

const rows: Row[] = []
try {
  for (const n of SIZES) {
    const label = `rows-${n}`
    const input = FIXTURES ? join(FIXTURES, `${label}.xlsx`) : join(scratch, `${label}.xlsx`)
    if (!FIXTURES) writeFileSync(input, rowsWorkbook(n))
    rows.push(...(await bench(input, label, RUNS, false)))
  }
  if (DENSE_RUNS > 0 && existsSync(DENSE)) rows.push(...(await bench(DENSE, 'dense-100k', DENSE_RUNS, true)))
  else if (DENSE_RUNS > 0) console.error(`no dense file at ${DENSE}: skipped`)
} finally {
  // a 500,000-row run leaves gigabytes behind
  if (!arg('dir')) rmSync(scratch, { recursive: true, force: true })
}

console.log(`cores ${cpus}; ${RUNS} runs a variant (${DENSE_RUNS} on the dense file), interleaved; load is the one-minute average while it ran`)
console.log('file          MiB     variant       median ms   spread   load   runs')
for (const r of rows) {
  const wide = r.spread > 0.25 && r.median >= 5 ? '  too wide to rule on' : ''
  console.log(`${r.file.padEnd(13)} ${r.mib.toFixed(2).padStart(6)}  ${r.variant.padEnd(12)} ${r.median.toFixed(1).padStart(10)}   ${(r.spread * 100).toFixed(0).padStart(4)}%  ${r.load.toFixed(2).padStart(5)}   ${r.runs.join(', ')}${wide}`)
}
const json = arg('json')
if (json) writeFileSync(json, JSON.stringify({ at: new Date().toISOString(), cores: cpus, runs: RUNS, sha: createHash('sha256').update(readFileSync(__filename)).digest('hex').slice(0, 12), rows }, null, 1))
