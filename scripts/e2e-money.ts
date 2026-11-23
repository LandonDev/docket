/**
 * Money, end to end on a real host with no window (docs/agents/work-money.md
 * "What is proven"): the server and the Work service of this tree in one
 * process, a temp database and a Work workspace of its own, the host's own
 * installed tools, and every call made over the host's own socket, as the
 * window makes them. No model, no LifeOS, nothing of anyone's: the receipts
 * are the made-up fixtures.
 *
 *   bun run script:e2e-money        (on the box: through .temp-code/bin/heavy)
 *
 * It proves: the books are made as two real `.tcsheet` files on first use;
 * entries land as rows and one read paints the view; an edit made in the
 * sheet (through the service's own sheet host, as the editor writes) is what
 * Money shows, and an act on the old reading is refused; three dropped
 * fixtures are read by the real reader (a picture, a JPEG, a scan with no
 * text layer), two accepted and one discarded, with the files in
 * `Money/Receipts/<year>/` and the rows in the sheet; a PDF's picture is its
 * first page; a trip writes the mileage log with a formula the sheet works
 * out; a year exports to a CSV and an Excel file; an invoice's printed page
 * is kept and filed as its row. The print itself needs Electron and is not
 * run here: a made-up PDF stands in for the printed page.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure } from 'aliax-core'
import { PDFDocument } from 'pdf-lib'
import { startServer } from '../src/main/server/index'
import { FIXTURES } from '../src/main/server/work/money/fixtures/receipts'
import { serviceSeamsFor } from '../src/main/server/work/service/ctx'
import { servicePaths } from '../src/main/server/work/service/config'
import { startWorkService, type RunningService } from '../src/main/server/work/service/serve'
import type { ServiceChild } from '../src/main/server/work/service/supervisor'
import type { FromService, ToService } from '../src/main/server/work/service/wire'
import { MONEY_PART_BYTES, type MoneyActed, type MoneyExport, type MoneyKept, type MoneyPicture, type MoneyRead, type MoneyReceived, type MoneyTripped } from '../src/shared/contract-work-money'
import { sigOf } from '../src/shared/work/money'

const TOOLS = process.env.E2E_WORK_TOOLS ?? '/srv/agents/temp-code-data/work-tools'
const root = mkdtempSync(join(tmpdir(), 'tc-money-e2e-'))
const data = join(root, 'data')
const work = join(root, 'work')
for (const d of [data, work]) mkdirSync(d, { recursive: true })

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  if (!ok) failures++
  return ok
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// The host's installed tools, each folder linked; the run keeps its own jobs.
const hasTools = existsSync(join(TOOLS, 'state.json'))
if (hasTools) {
  const mine = join(data, 'work-tools')
  mkdirSync(mine, { recursive: true })
  for (const name of readdirSync(TOOLS)) {
    if (['jobs', 'run', 'downloads'].includes(name)) mkdirSync(join(mine, name), { recursive: true })
    else if (name === 'state.json') writeFileSync(join(mine, name), readFileSync(join(TOOLS, name)))
    else symlinkSync(join(TOOLS, name), join(mine, name))
  }
}

configure({
  dataDir: join(root, 'aliax'),
  fetch: async (url) => {
    throw new Error(`unexpected fetch ${url}`)
  },
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-e2e'
})

// The Work service in this process, where the app forks it as a utility process (scripts/ios-client-test-server.ts does the same).
serviceSeamsFor.current = {
  hostedDir: join(data, 'hosted'),
  spawn: (): ServiceChild => {
    const onMessage: ((m: FromService) => void)[] = []
    const onExit: ((code: number | null) => void)[] = []
    const asked = new Map<number, (m: Extract<ToService, { t: 'jwt' }>) => void>()
    let running: RunningService | null = null
    let n = 0
    const emit = (m: FromService): void => queueMicrotask(() => onMessage.forEach((f) => f(m)))
    return {
      post(m: ToService) {
        if (m.t === 'config')
          startWorkService(m.config, {
            jwt: () => new Promise((ok, bad) => (asked.set(++n, (a) => (a.jwt ? ok(a.jwt) : bad(new Error(a.error ?? 'no JWT')))), emit({ t: 'jwt?', id: n }))),
            log: (line) => emit({ t: 'log', line })
          }).then(
            (s) => ((running = s), emit({ t: 'ready', port: s.port })),
            (err: Error) => emit({ t: 'fault', message: err.stack ?? err.message })
          )
        else if (m.t === 'jwt') asked.get(m.id)?.(m)
        else if (m.t === 'links') running?.setLinks(m.links)
        else if (m.t === 'trusted') running?.setTrusted(m.trusted)
        else if (m.t === 'stop') void (running?.stop() ?? Promise.resolve()).then(() => (emit({ t: 'stopped' }), onExit.forEach((f) => f(0))))
      },
      onMessage: (f) => void onMessage.push(f),
      onExit: (f) => void onExit.push(f),
      kill: () => void running?.stop().catch(() => {})
    }
  }
}

const server = await startServer(join(data, 'app.db'), { claimShim: false, remotePort: 0 })
server.store.setSetting('workspace.root', work)

/** One request on the host's own socket: the window's. */
const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
await new Promise<void>((ok, bad) => {
  ws.addEventListener('open', () => ok())
  ws.addEventListener('error', () => bad(new Error('no socket')))
})
const pending = new Map<string, (frame: { ok?: boolean; result?: unknown; error?: string }) => void>()
const pushes: { push?: string; workspaceId?: string; toConfirm?: number }[] = []
ws.addEventListener('message', (ev) => {
  const frame = JSON.parse(String(ev.data)) as { id?: string; push?: string }
  if (frame.id) pending.get(frame.id)?.(frame)
  else if (frame.push === 'work.money') pushes.push(frame)
})
let next = 0
function rpc<T>(method: string, params: unknown = {}): Promise<T> {
  return new Promise<T>((ok, bad) => {
    const id = `m${++next}`
    const timer = setTimeout(() => bad(new Error(`no answer to ${method}`)), 180_000)
    pending.set(id, (frame) => {
      clearTimeout(timer)
      pending.delete(id)
      if (frame.ok) ok(frame.result as T)
      else bad(new Error(frame.error ?? `${method} failed`))
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const refusal = (p: Promise<unknown>): Promise<string> => p.then(() => '', (err: Error) => err.message)

/** The service's own sheet routes, behind its secret: how the sheet editor's writes reach the same sheet host. */
function service<T>(route: string, body: unknown): Promise<T> {
  const paths = servicePaths(data)
  const secret = readFileSync(paths.secretFile, 'utf8').trim()
  const payload = JSON.stringify(body)
  return new Promise<T>((ok, bad) => {
    const req = httpRequest({ socketPath: paths.socketPath, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${secret}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => (res.statusCode === 200 ? ok(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T) : bad(new Error(`${route}: ${res.statusCode} ${Buffer.concat(chunks).toString('utf8')}`))))
    })
    req.on('error', bad)
    req.end(payload)
  })
}

const fixture = (name: string): Buffer => readFileSync(join(import.meta.dir, '../src/main/server/work/money/fixtures', name))
async function send(workspaceId: string, name: string, bytes: Buffer, key: string): Promise<MoneyReceived> {
  const parts = Math.max(1, Math.ceil(bytes.length / MONEY_PART_BYTES))
  let last!: MoneyReceived
  for (let part = 0; part < parts; part++) {
    last = await rpc<MoneyReceived>('work.money.receive', { key, workspaceId, name, part, parts, dataBase64: bytes.subarray(part * MONEY_PART_BYTES, (part + 1) * MONEY_PART_BYTES).toString('base64') })
  }
  return last
}

try {
  await rpc('work.set', { enabled: true })
  const job = await rpc<{ id: string; path: string }>('workspace.create', { kind: 'work', sector: 'ref', name: 'E2E money' })
  const read = (from = '2026-01-01', to = '2027-01-01'): Promise<MoneyRead> => rpc<MoneyRead>('work.money.read', { workspaceId: job.id, from, to })
  const money = join(job.path, 'Money')
  const ledger = join(money, 'Ledger.tcsheet')

  // ── the books ───────────────────────────────────────────────────────
  const empty = await read()
  check('a job with no ledger reads as empty, and reading makes nothing', empty.made === false && !existsSync(money))

  // The ledger filled by the fixtures' own rows.
  for (const f of FIXTURES.slice(3)) {
    await rpc<MoneyActed>('work.money.entry', { workspaceId: job.id, fields: { date: f.expected.date, who: f.expected.who, way: 'out', amount: f.expected.amount, category: f.expected.category ?? '' } })
  }
  await rpc('work.money.entry', { workspaceId: job.id, fields: { date: '2026-11-07', who: 'West Side HS', way: 'in', amount: 8000, status: 'Unpaid', category: 'Game fees', what: 'Varsity' } })
  check('the books are two real sheets in the job’s own Money folder', existsSync(ledger) && existsSync(join(money, 'Mileage.tcsheet')), readdirSync(money).join(', '))
  const first = await read()
  check('one read paints the view: rows, sums, what is owed, the categories', first.made && first.rows.length === 6 && first.sums.out === 5929 + 5099 + 31250 + 1800 + 1900 && first.owed.length === 1 && first.owed[0].amount === 8000, JSON.stringify(first.sums))
  const header = await service<{ cells: { v?: unknown }[][] }>('/internal/sheet/range', { sheet: { tcsheet: ledger }, range: 'A1:J1' })
  check('the sheet holds the ledger’s headers', header.cells[0].map((c) => c.v).join('|') === 'Date|Who|For|Category|In|Out|Status|Paid on|Receipt|Ref')

  // ── the sheet is the truth ──────────────────────────────────────────
  const owed = first.rows.find((r) => r.who === 'West Side HS')!
  await service('/internal/sheet/cells', { sheet: { tcsheet: ledger }, cells: [{ at: `E${owed.row}`, v: 85 }], by: 'owner', suggest: false })
  const stale = await rpc<MoneyActed>('work.money.paid', { workspaceId: job.id, at: { ref: null, row: owed.row, sig: sigOf(owed) } })
  check('an act on a row he changed in the sheet is refused, and nothing is written', 'changed' in stale)
  const edited = (await read()).rows.find((r) => r.who === 'West Side HS')!
  check('what he edits in the sheet is what Money shows', edited.in === 8500, String(edited.in))
  const paid = await rpc<MoneyActed>('work.money.paid', { workspaceId: job.id, at: { ref: edited.ref, row: edited.row, sig: sigOf(edited) }, on: '2026-11-23' })
  check('Paid writes the status and the day', 'ok' in paid && (await read()).owed.length === 0)

  // ── receipts in ─────────────────────────────────────────────────────
  if (!hasTools) check('the host’s tools are installed (the reader)', false, `no ${TOOLS}/state.json: the three drops were not read`)
  else {
    const drops = ['coffee.png', 'fuel.jpg', 'parking-scan.pdf'].map((name) => ({ name, f: FIXTURES.find((x) => x.file === name)! }))
    const ids: Record<string, string> = {}
    for (const d of drops) ids[d.name] = (await send(job.id, d.name, fixture(d.name), `e2e-money-${d.name}`)).id
    let waits = (await read()).toConfirm
    for (let i = 0; i < 240 && waits.some((w) => w.state === 'reading'); i++) {
      await sleep(1000)
      waits = (await read()).toConfirm
    }
    check('three dropped files wait in To confirm, each read', waits.length === 3 && waits.every((w) => w.state === 'ready'), waits.map((w) => `${w.name}:${w.state}`).join(' '))
    for (const d of drops) {
      const got = waits.find((w) => w.id === ids[d.name])?.fields
      // The category comes from the job's own list (ref) and what the ledger already knows of the seller.
      check(`${d.name} was read by the real reader: amount, date and seller`, !!got && got.amount === d.f.expected.amount && got.date === d.f.expected.date && got.who === d.f.expected.who, JSON.stringify(got))
    }
    check('every window was told how many wait', pushes.some((p) => p.workspaceId === job.id && p.toConfirm === 3))
    const pic = await rpc<MoneyPicture>('work.money.picture', { id: ids['parking-scan.pdf'], part: 0 })
    check('a waiting PDF shows as its first page, a picture', pic.mime === 'image/png' && Buffer.from(pic.dataBase64, 'base64').subarray(1, 4).toString() === 'PNG', `${pic.mime} ${pic.size} bytes`)

    const accept = async (name: string): Promise<MoneyActed> => {
      const f = waits.find((w) => w.id === ids[name])!.fields
      return rpc<MoneyActed>('work.money.accept', { id: ids[name], fields: { date: f.date, who: f.who, way: 'out', amount: f.amount, category: f.category ?? '' } })
    }
    const a = await accept('coffee.png')
    const b = await accept('parking-scan.pdf')
    await rpc('work.money.drop', { id: ids['fuel.jpg'] })
    const kept = readdirSync(join(money, 'Receipts', '2026')).sort()
    check('two were accepted: their files are in Money/Receipts/2026 by day, seller and amount', 'ok' in a && 'ok' in b && kept.join('|') === '2026-11-02 City Center Parking Garage 18.00.pdf|2026-11-21 Blue Heron Coffee 10.43.png', kept.join(', '))
    check('the kept file is the dropped file, byte for byte', readFileSync(join(money, 'Receipts', '2026', '2026-11-21 Blue Heron Coffee 10.43.png')).equals(fixture('coffee.png')))
    const after = await read()
    check('one was discarded, and nothing waits', after.toConfirm.length === 0 && !after.rows.some((r) => r.who === 'Northside Fuel Stop'))
    const row = 'ok' in a ? a.row : 0
    const cells = await service<{ cells: { v?: unknown }[][] }>('/internal/sheet/range', { sheet: { tcsheet: ledger }, range: `A${row}:I${row}` })
    check('the accepted row is in the sheet with its receipt’s path', cells.cells[0][1].v === 'Blue Heron Coffee' && cells.cells[0][5].v === 10.43 && cells.cells[0][8].v === 'Receipts/2026/2026-11-21 Blue Heron Coffee 10.43.png', JSON.stringify(cells.cells[0].map((c) => c.v)))
    const filed = await rpc<MoneyPicture>('work.money.picture', { workspaceId: job.id, receipt: 'Receipts/2026/2026-11-21 Blue Heron Coffee 10.43.png', part: 0 })
    check('a filed row’s receipt shows from its Receipt cell', Buffer.from(filed.dataBase64, 'base64').equals(fixture('coffee.png')))
    check('a retry of an accepted drop files nothing twice', (await send(job.id, 'coffee.png', fixture('coffee.png'), 'e2e-money-coffee.png')).state === 'filed')
  }
  check('a file that is no picture or PDF is refused', (await refusal(send(job.id, 'notes.docx', Buffer.from('x'), 'e2e-money-docx'))).includes('pictures and PDFs'))

  // ── mileage ─────────────────────────────────────────────────────────
  const trip = await rpc<MoneyTripped>('work.money.trip', { workspaceId: job.id, date: '2026-11-21', title: 'Varsity at Harrison HS', place: 'Harrison HS', miles: 24, fee: 7500 })
  const log = await service<{ cells: { v?: unknown; f?: string }[][] }>('/internal/sheet/range', { sheet: { tcsheet: join(money, 'Mileage.tcsheet') }, range: 'A2:F2' })
  check('a trip writes the mileage log, its value a formula the sheet works out', trip.trip?.row === 2 && log.cells[0][3].v === 24 && log.cells[0][4].v === 0.7 && !!log.cells[0][5].f && Math.abs(Number(log.cells[0][5].v) - 16.8) < 1e-9, JSON.stringify(log.cells[0]))
  const withTrip = await read()
  check('the view reads the miles and their value, and the pay is owed', withTrip.miles.miles === 24 && withTrip.miles.value === 1680 && withTrip.owed.some((o) => o.who === 'Harrison HS' && o.amount === 7500), JSON.stringify(withTrip.miles))
  check('the rate is his to set', (await rpc<{ rate: number; own: boolean }>('work.money.rate', { workspaceId: job.id, year: 2026, rate: 0.725 })).own && (await read()).rate.rate === 0.725)

  // ── out ─────────────────────────────────────────────────────────────
  const out = await rpc<MoneyExport>('work.money.export', { workspaceId: job.id, year: 2026 })
  const tax = join(money, 'Tax 2026')
  const csv = existsSync(join(tax, 'Ledger 2026.csv')) ? readFileSync(join(tax, 'Ledger 2026.csv'), 'utf8') : ''
  check('the year exports to a CSV with the ledger’s rows and the mileage', out.files.includes('Ledger 2026.csv') && csv.startsWith('Date,Who,For,Category,In,Out,Status,Paid on,Receipt,Ref\r\n') && csv.includes('Varsity at Harrison HS,Harrison HS,24,0.7,16.80'), out.files.join(', '))
  if (hasTools) {
    const xlsx = existsSync(join(tax, 'Ledger 2026.xlsx')) ? readFileSync(join(tax, 'Ledger 2026.xlsx')) : Buffer.alloc(0)
    check('and to an Excel file, made from it by the conversion runner', out.files.includes('Ledger 2026.xlsx') && xlsx.subarray(0, 2).toString() === 'PK' && xlsx.length > 2000, `${xlsx.length} bytes; ${out.warnings.join('; ')}`)
  }
  check('the summary’s page is answered for the window to print', !!out.summary && out.summary.name === 'Summary 2026.pdf' && out.summary.html.includes('E2E money: 2026') && out.summary.html.includes('24 mi'))

  // The print needs Electron: a made-up one-page PDF stands in for the page the window prints.
  const doc = await PDFDocument.create()
  doc.addPage([612, 792]).drawText('Made-up page', { x: 72, y: 720, size: 14 })
  const pdf = Buffer.from(await doc.save())
  const keep = (over: Record<string, unknown>): Promise<MoneyKept> => rpc<MoneyKept>('work.money.keep', { workspaceId: job.id, part: 0, parts: 1, dataBase64: pdf.toString('base64'), ...over })
  const summary = await keep({ key: 'e2e-money-summary', what: 'summary', year: 2026 })
  check('the printed summary is kept in the year’s folder', summary.receipt === 'Tax 2026/Summary 2026.pdf' && readFileSync(join(tax, 'Summary 2026.pdf')).equals(pdf))

  const number = (await rpc<{ number: string; from: unknown; dueDays: number }>('work.money.invoiceNext', { workspaceId: job.id })).number
  const invoice = { kind: 'invoice', number, to: 'Rivera Dental', date: '2026-11-23', due: '2026-12-07', lines: [{ what: 'Clinic, two days', quantity: 2, rate: 15000 }], from: { name: 'E2E Officials', address: '1 Main St', pay: 'Check' } }
  const page = await rpc<{ name: string; html: string }>('work.money.invoice', { workspaceId: job.id, invoice })
  check('the first invoice is 1001, and its page is answered to print', number === '1001' && page.name === 'Invoice 1001 Rivera Dental.pdf' && page.html.includes('$300.00'))
  const filedInvoice = await keep({ key: 'e2e-money-invoice', what: 'invoice', invoice })
  const withInvoice = await read()
  check(
    'the printed invoice is kept under Money/Invoices and filed as its row: money in, unpaid',
    filedInvoice.receipt === 'Invoices/Invoice 1001 Rivera Dental.pdf' && existsSync(join(money, 'Invoices', 'Invoice 1001 Rivera Dental.pdf')) && withInvoice.owed.some((o) => o.who === 'Rivera Dental' && o.amount === 30000),
    filedInvoice.receipt
  )
  check('the next number is one past it, and his details come back', (await rpc<{ number: string; from: { name: string } | null }>('work.money.invoiceNext', { workspaceId: job.id })).number === '1002')

  // ── for the others ──────────────────────────────────────────────────
  const sums = await rpc<{ rows: { workspaceId: string; in: number; out: number; owedToHim: number; miles: number }[] }>('work.money.sums', { from: '2026-01-01', to: '2027-01-01' })
  check('the weekly review’s sums answer for the job', sums.rows.length === 1 && sums.rows[0].workspaceId === job.id && sums.rows[0].miles === 24, JSON.stringify(sums.rows))
  const hits = await rpc<{ hits: { who: string }[] }>('work.money.search', { workspaceId: job.id, query: 'rivera' })
  check('search finds a row by its words', hits.hits.length === 1 && hits.hits[0].who === 'Rivera Dental')
  const hash = createHash('sha256').update(readFileSync(ledger)).digest('hex').slice(0, 12)
  console.log(`NOTE  the ledger is ${readFileSync(ledger).length} bytes (${hash}); the job's folder: ${readdirSync(money).sort().join(', ')}`)
} catch (err) {
  check('the run finished', false, err instanceof Error ? (err.stack ?? err.message) : String(err))
} finally {
  ws.close()
  await server.close().catch(() => {})
  if (failures === 0 && !process.env.E2E_KEEP) rmSync(root, { recursive: true, force: true })
  else console.log(`left for inspection: ${root}`)
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
