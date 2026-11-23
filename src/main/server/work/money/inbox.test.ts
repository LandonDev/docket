import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MONEY_PART_BYTES, type MoneyActed, type MoneyPicture, type MoneyRead, type MoneyReceived } from '@shared/contract-work-money'
import { requiredCapability } from '@shared/capabilities'
import type { Caller } from '../modules'
import { money } from '.'
import { FIXTURES, linesOf } from './fixtures/receipts'
import { read as readWaiting, resume } from './inbox'
import { movedHook, relink } from './moved'
import { linesOfExtract, LINES_PY, MONEY_CONVERTERS } from './reader'
import { bench, LOCAL, REMOTE, req, type Bench } from './testing'
import { moneyTools } from './tools'

/* Receipts in: what waits for his accept, what his accept keeps and writes, and who may leave what. */

let b: Bench
const call = async <T>(method: string, params: unknown, by: Caller = LOCAL): Promise<T> => ((await money.handle!(req(method, params), b.ctx, by)) as { result: T }).result
const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', name)
const bytes = (name: string): Buffer => readFileSync(fixture(name))
const settle = () => new Promise((r) => setTimeout(r, 20))
const view = () => call<MoneyRead>('work.money.read', { workspaceId: 'ws-ref', from: '2026-01-01', to: '2027-01-01' })
const ledger = (): string => join(b.ref, 'Money', 'Ledger.tcsheet')

/** Sends a file's bytes as the window does: in parts, one key. */
async function send(name: string, o: { key?: string; workspaceId?: string; sector?: string; part?: number; by?: Caller; more?: Record<string, unknown>; data?: Buffer } = {}): Promise<MoneyReceived> {
  const data = o.data ?? bytes(name)
  const parts = Math.max(1, Math.ceil(data.length / MONEY_PART_BYTES))
  let last!: MoneyReceived
  for (let part = 0; part < parts; part++) {
    last = await call<MoneyReceived>(
      'work.money.receive',
      { key: o.key ?? `key-${name}`, ...(o.sector ? { sector: o.sector } : { workspaceId: o.workspaceId ?? 'ws-ref' }), name, part, parts, dataBase64: data.subarray(part * MONEY_PART_BYTES, (part + 1) * MONEY_PART_BYTES).toString('base64'), ...o.more },
      o.by
    )
  }
  return last
}
const fields = (over: Record<string, unknown> = {}) => ({ date: '2026-11-21', who: 'Blue Heron Coffee', way: 'out', amount: 1043, category: 'Food', ...over })

beforeEach(() => {
  b = bench()
  for (const f of FIXTURES) b.lines.set(f.file, linesOf(f))
  b.lines.set('parking-scan.pdf', linesOf(FIXTURES.find((f) => f.file === 'parking-scan.pdf')!))
})

describe('the wire', () => {
  it('takes a receipt with operate and shows a picture with read', () => {
    expect(requiredCapability({ method: 'work.money.receive' })).toBe('operate')
    expect(requiredCapability({ method: 'work.money.accept' })).toBe('operate')
    expect(requiredCapability({ method: 'work.money.picture' })).toBe('read')
  })
})

describe('a receipt comes in', () => {
  it('waits as reading, then ready with what the one parser read; nothing is in the ledger', async () => {
    const got = await send('coffee.png')
    // It answers at once, before the file is read: the window shows it as Reading.
    expect(got.state).toBe('reading')
    await settle()
    const waits = (await view()).toConfirm
    expect(waits).toMatchObject([{ id: got.id, state: 'ready', source: 'drop', name: 'coffee.png', picture: true, fields: { amount: 1043, date: '2026-11-21', who: 'Blue Heron Coffee', category: 'Meals' } }])
    expect((await view()).made).toBe(false)
    // The file waits under this host's data folder, not in the job's.
    expect(existsSync(join(b.ref, 'Money'))).toBe(false)
    // Every window is told how many wait.
    expect(b.pushed).toContainEqual({ push: 'work.money', workspaceId: 'ws-ref', toConfirm: 1 })
  })

  it('puts a file sent in three parts together whole, in any order, and answers partial until the last', async () => {
    const data = Buffer.alloc(5 * 1024 * 1024 + 7, 1)
    data.write('\x89PNG', 0, 'latin1')
    const part = (n: number) =>
      call<MoneyReceived>('work.money.receive', { key: 'big-one-key', workspaceId: 'ws-ref', name: 'big.png', part: n, parts: 3, dataBase64: data.subarray(n * MONEY_PART_BYTES, (n + 1) * MONEY_PART_BYTES).toString('base64') })
    expect((await part(2)).state).toBe('partial')
    expect((await part(0)).state).toBe('partial')
    expect((await view()).toConfirm).toEqual([])
    const done = await part(1)
    expect(done.state).toBe('reading')
    const kept = join(b.root, 'data', 'work-money', 'incoming', done.id, 'big.png')
    expect(readFileSync(kept).equals(data)).toBe(true)
    expect(readdirSync(join(kept, '..'))).toEqual(['big.png'])
  })

  it('files nothing twice for one key: a retry answers the first', async () => {
    const first = await send('coffee.png', { key: 'same-key-1' })
    await settle()
    const again = await send('coffee.png', { key: 'same-key-1' })
    expect(again).toEqual({ id: first.id, state: 'ready' })
    expect((await view()).toConfirm).toHaveLength(1)
  })

  it('refuses a part past 2 MB, a file past 25 MB, and a file that is no picture or PDF', async () => {
    const big = Buffer.alloc(MONEY_PART_BYTES + 1).toString('base64')
    await expect(call('work.money.receive', { key: 'too-big-part', workspaceId: 'ws-ref', name: 'a.png', part: 0, parts: 1, dataBase64: big })).rejects.toThrow()
    const chunk = Buffer.alloc(MONEY_PART_BYTES).toString('base64')
    let refused = ''
    for (let part = 0; part < 12 && !refused; part++) {
      await call('work.money.receive', { key: 'too-big-file', workspaceId: 'ws-ref', name: 'a.png', part, parts: 12, dataBase64: chunk }).catch((err: Error) => (refused = err.message))
    }
    expect(refused).toBe('That file is over 25 MB.')
    await expect(send('notes.docx', { data: Buffer.from('x') })).rejects.toThrow('Money files pictures and PDFs.')
    await expect(call('work.money.receive', { key: 'no-bytes-1', workspaceId: 'ws-ref', name: 'a.png' })).rejects.toThrow('its bytes or a file')
  })

  it('copies a file of this host by its path, and holds a remote key to what it reaches', async () => {
    const got = await call<MoneyReceived>('work.money.receive', { key: 'by-path-01', workspaceId: 'ws-ref', name: 'fuel.jpg', file: { at: 'file', host: 'env_box', path: fixture('fuel.jpg') } })
    expect(got.state).toBe('reading')
    await settle()
    expect((await view()).toConfirm[0].fields).toMatchObject({ amount: 4817, who: 'Northside Fuel Stop' })
    await expect(call('work.money.receive', { key: 'by-path-02', workspaceId: 'ws-ref', name: 'fuel.jpg', file: { at: 'file', host: 'env_box', path: fixture('fuel.jpg') } }, REMOTE)).rejects.toThrow('outside app-managed roots')
    await expect(call('work.money.receive', { key: 'by-path-03', workspaceId: 'ws-ref', name: 'fuel.jpg', file: { at: 'file', host: 'env_mac', path: fixture('fuel.jpg') } })).rejects.toThrow('another computer')
    // A remote key may not leave a receipt in a job it cannot reach.
    await expect(send('coffee.png', { key: 'remote-key-1', workspaceId: 'ws-purdue', by: REMOTE })).rejects.toThrow('outside app-managed roots')
    expect((await send('coffee.png', { key: 'remote-key-2', by: REMOTE })).state).toBe('reading')
  })

  it('names its job by sector when the sender knows no workspace (the phone)', async () => {
    const got = await send('meal.jpg', { sector: 'purdue', more: { source: 'phone' } })
    await settle()
    const purdue = await call<MoneyRead>('work.money.read', { workspaceId: 'ws-purdue', from: '2026-01-01', to: '2027-01-01' })
    expect(purdue.toConfirm).toMatchObject([{ id: got.id, source: 'phone', fields: { amount: 5929, category: 'Food' } }])
    await expect(send('meal.jpg', { key: 'no-such-job', sector: 'unify' })).rejects.toThrow('No workspace for that job on this computer.')
  })

  it('does not read again what the sender already read, and what he typed there wins', async () => {
    const got = await send('gear.png', { more: { source: 'phone', lines: linesOf(FIXTURES.find((f) => f.file === 'gear.png')!), fields: { amount: null, date: null, who: 'Ref Gear', category: null } } })
    expect(got.state).toBe('ready')
    expect(b.converted).toEqual([])
    expect((await view()).toConfirm[0].fields).toMatchObject({ amount: 5099, date: '2026-09-30', who: 'Ref Gear', category: 'Uniform and gear' })
  })

  it('files at once what he accepted where he sent it from: an amount and a date', async () => {
    const got = await send('fuel.jpg', { more: { source: 'phone', lines: [], fields: { amount: 4817, date: '2026-11-14', who: 'Northside Fuel Stop', category: 'Travel' } } })
    expect(got.state).toBe('filed')
    const now = await view()
    expect(now.toConfirm).toEqual([])
    expect(now.rows).toMatchObject([{ who: 'Northside Fuel Stop', out: 4817, category: 'Travel', receipt: 'Receipts/2026/2026-11-14 Northside Fuel Stop 48.17.jpg' }])
    expect(existsSync(join(b.ref, 'Money', 'Receipts', '2026', '2026-11-14 Northside Fuel Stop 48.17.jpg'))).toBe(true)
  })

  it('gives a seller the category he last gave it in this ledger', async () => {
    await call('work.money.entry', { workspaceId: 'ws-ref', fields: fields({ category: 'Crew coffee' }) })
    await send('coffee.png')
    await settle()
    expect((await view()).toConfirm[0].fields.category).toBe('Crew coffee')
  })

  it('opens with empty fields when the reader cannot be reached or reads nothing, with no error to show', async () => {
    b.readerDown = true
    await send('coffee.png')
    await settle()
    expect((await view()).toConfirm).toMatchObject([{ state: 'ready', picture: true, fields: { amount: null, date: null, who: null, category: null } }])
    b.readerDown = false
    await send('blank.png', { data: bytes('gear.png') })
    await settle()
    expect((await view()).toConfirm[1].fields).toEqual({ amount: null, date: null, who: null, category: null })
  })

  it('reads a PDF by its text, and a scan by its first page as a picture', async () => {
    b.blocks.set('invoice.pdf', [
      { page: 1, bbox: [0.1, 0.05, 0.5, 0.08], text: 'Lakeshore Print Co.' },
      { page: 1, bbox: [0.1, 0.1, 0.5, 0.16], text: 'Invoice 2217\nOctober 12, 2026' },
      { page: 1, bbox: [0.1, 0.3, 0.4, 0.33], text: 'Balance due' },
      { page: 1, bbox: [0.7, 0.3, 0.9, 0.33], text: '$312.50' }
    ])
    await send('invoice.pdf')
    await send('parking-scan.pdf')
    await settle()
    const [pdf, scan] = (await view()).toConfirm
    expect(pdf.fields).toMatchObject({ amount: 31250, date: '2026-10-12', who: 'Lakeshore Print Co.' })
    expect(scan.fields).toMatchObject({ amount: 1800, date: '2026-11-02', who: 'City Center Parking Garage' })
    // The text PDF never reached the picture reader; the scan was drawn at 2000 wide, then read.
    expect(b.converted.map((j) => `${j.from}>${j.to}`)).toEqual(['pdf>extract', 'pdf>extract', 'pdf>png', 'png>lines'])
    expect(b.converted[2].options).toEqual({ page: 1, width: 2000 })
  })

  it('makes a HEIC a JPEG first, then reads it', async () => {
    b.lines.set('IMG_0042.heic', linesOf(FIXTURES[0]))
    await send('IMG_0042.heic', { data: bytes('coffee.png') })
    await settle()
    expect(b.converted.map((j) => `${j.from}>${j.to}`)).toEqual(['heic>jpg', 'jpg>lines'])
    expect((await view()).toConfirm[0].fields.amount).toBe(1043)
  })

  it('picks reading up again after a restart, and lets go of parts nobody finished', async () => {
    const got = await send('coffee.png')
    await settle()
    b.db.prepare("UPDATE work_money_inbox SET state = 'reading', fields = NULL WHERE id = ?").run(got.id)
    await call('work.money.receive', { key: 'half-done-1', workspaceId: 'ws-ref', name: 'x.png', part: 0, parts: 2, dataBase64: 'AAAA' })
    b.db.prepare("UPDATE work_money_inbox SET updated_at = 1 WHERE state = 'partial'").run()
    const stop = resume(b.ctx)
    await settle()
    stop()
    expect((await view()).toConfirm).toMatchObject([{ id: got.id, state: 'ready', fields: { amount: 1043 } }])
    expect(b.db.prepare("SELECT COUNT(*) AS n FROM work_money_inbox WHERE state = 'partial'").get()).toEqual({ n: 0 })
  })
})

describe('his accept', () => {
  it('keeps the file under Receipts/<year>/ by day, seller and amount, appends the row with its path, and files the waiting one', async () => {
    const got = await send('coffee.png')
    await settle()
    const acted = await call<MoneyActed>('work.money.accept', { id: got.id, fields: fields() })
    expect(acted).toMatchObject({ ok: true, row: 2 })
    const kept = join(b.ref, 'Money', 'Receipts', '2026', '2026-11-21 Blue Heron Coffee 10.43.png')
    expect(readFileSync(kept).equals(bytes('coffee.png'))).toBe(true)
    expect(b.sheets.grid(ledger())[1].slice(0, 9)).toEqual(['2026-11-21', 'Blue Heron Coffee', '', 'Food', '', 10.43, 'Paid', '', 'Receipts/2026/2026-11-21 Blue Heron Coffee 10.43.png'])
    const now = await view()
    expect(now.toConfirm).toEqual([])
    expect(existsSync(join(b.root, 'data', 'work-money', 'incoming', got.id))).toBe(false)
    expect(b.pushed.at(-1)).toEqual({ push: 'work.money', workspaceId: 'ws-ref', toConfirm: 0 })
    // A second accept answers the first and writes nothing.
    const rev = b.sheets.sheets.get(ledger())!.rev
    expect(await call('work.money.accept', { id: got.id, fields: fields({ amount: 999 }) })).toEqual(acted)
    expect(b.sheets.sheets.get(ledger())!.rev).toBe(rev)
  })

  it('never replaces a kept file: a second receipt of the same day, seller and amount takes a name of its own', async () => {
    const one = await send('coffee.png', { key: 'twin-one-1' })
    const two = await send('coffee.png', { key: 'twin-two-2' })
    await settle()
    await call('work.money.accept', { id: one.id, fields: fields() })
    await call('work.money.accept', { id: two.id, fields: fields() })
    expect(readdirSync(join(b.ref, 'Money', 'Receipts', '2026')).sort()).toEqual(['2026-11-21 Blue Heron Coffee 10.43 (2).png', '2026-11-21 Blue Heron Coffee 10.43.png'])
    expect((await view()).rows.map((r) => r.receipt).sort()).toEqual(['Receipts/2026/2026-11-21 Blue Heron Coffee 10.43 (2).png', 'Receipts/2026/2026-11-21 Blue Heron Coffee 10.43.png'])
  })

  it('sends it to another job when he says so', async () => {
    const got = await send('meal.jpg')
    await settle()
    await call('work.money.accept', { id: got.id, workspaceId: 'ws-purdue', fields: fields({ who: 'Trattoria Luna', amount: 5929, date: '2026-10-09' }) })
    expect(existsSync(join(b.purdue, 'Money', 'Receipts', '2026', '2026-10-09 Trattoria Luna 59.29.jpg'))).toBe(true)
    expect(existsSync(join(b.ref, 'Money'))).toBe(false)
    expect((await view()).toConfirm).toEqual([])
  })

  it('keeps nothing when the row cannot be written, and the receipt still waits', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    b.sheets.type(ledger(), 'A1', 'When')
    const got = await send('coffee.png')
    await settle()
    await expect(call('work.money.accept', { id: got.id, fields: fields() })).rejects.toThrow("The ledger's columns changed.")
    expect(existsSync(join(b.ref, 'Money', 'Receipts', '2026', '2026-11-21 Blue Heron Coffee 10.43.png'))).toBe(false)
    expect((await view()).toConfirm).toHaveLength(1)
  })

  it('drops a waiting one and its file; a dropped one cannot be accepted, and a retry does not bring it back', async () => {
    const got = await send('coffee.png', { key: 'to-drop-01' })
    await settle()
    expect(await call('work.money.drop', { id: got.id })).toBeNull()
    expect((await view()).toConfirm).toEqual([])
    expect(existsSync(join(b.root, 'data', 'work-money', 'incoming', got.id))).toBe(false)
    await expect(call('work.money.accept', { id: got.id, fields: fields() })).rejects.toThrow('not waiting any more')
    expect((await send('coffee.png', { key: 'to-drop-01' })).state).toBe('dropped')
  })

  it('is his alone: a thread’s own call may neither receive, accept nor drop', async () => {
    const MODEL: Caller = { kind: 'model', caps: ['read', 'operate'], sessionId: 't-ref' }
    const got = await send('coffee.png')
    await expect(send('fuel.jpg', { by: MODEL })).rejects.toThrow('Only the owner')
    await expect(call('work.money.accept', { id: got.id, fields: fields() }, MODEL)).rejects.toThrow('Only the owner')
    await expect(call('work.money.drop', { id: got.id }, MODEL)).rejects.toThrow('Only the owner')
  })
})

describe('a picture', () => {
  const whole = async (params: Record<string, unknown>, by: Caller = LOCAL): Promise<{ first: MoneyPicture; bytes: Buffer }> => {
    const first = await call<MoneyPicture>('work.money.picture', params, by)
    const parts = [Buffer.from(first.dataBase64, 'base64')]
    for (let part = 1; part < first.parts; part++) parts.push(Buffer.from((await call<MoneyPicture>('work.money.picture', { ...params, part }, by)).dataBase64, 'base64'))
    return { first, bytes: Buffer.concat(parts) }
  }

  it('shows a waiting receipt, and a filed one by its row’s Receipt', async () => {
    const got = await send('coffee.png')
    const waits = await whole({ id: got.id })
    expect(waits.first).toMatchObject({ mime: 'image/png', name: 'coffee.png', parts: 1 })
    expect(waits.bytes.equals(bytes('coffee.png'))).toBe(true)
    await settle()
    await call('work.money.accept', { id: got.id, fields: fields() })
    const filed = await whole({ workspaceId: 'ws-ref', receipt: 'Receipts/2026/2026-11-21 Blue Heron Coffee 10.43.png' })
    expect(filed.bytes.equals(bytes('coffee.png'))).toBe(true)
  })

  it('draws a PDF as its first page, and gives a large picture in parts', async () => {
    const pdf = await send('invoice.pdf')
    const shown = await whole({ id: pdf.id })
    expect(shown.first.mime).toBe('image/png')
    expect(b.converted.some((j) => j.from === 'pdf' && j.to === 'png' && (j.options as { width: number }).width === 1200)).toBe(true)
    const data = Buffer.alloc(MONEY_PART_BYTES + 100, 7)
    const big = await send('big.jpg', { data })
    const got = await whole({ id: big.id })
    expect(got.first.parts).toBe(2)
    expect(got.bytes.equals(data)).toBe(true)
  })

  it('reaches nothing outside the job’s Money folder, and holds a remote key to its fence', async () => {
    await call('work.money.open', { workspaceId: 'ws-ref' })
    writeFileSync(join(b.ref, 'secret.png'), 'x')
    await expect(whole({ workspaceId: 'ws-ref', receipt: '../secret.png' })).rejects.toThrow('not in the Money folder')
    await expect(whole({ workspaceId: 'ws-ref', receipt: 'Ledger.tcsheet' })).rejects.toThrow('no picture')
    await call('work.money.open', { workspaceId: 'ws-purdue' })
    mkdirSync(join(b.purdue, 'Money', 'Receipts'), { recursive: true })
    copyFileSync(fixture('coffee.png'), join(b.purdue, 'Money', 'Receipts', 'a.png'))
    await expect(whole({ workspaceId: 'ws-purdue', receipt: 'Receipts/a.png' }, REMOTE)).rejects.toThrow('outside app-managed roots')
    await expect(call('work.money.picture', { part: 0 })).rejects.toThrow('by its id')
  })
})

describe('a file that moves', () => {
  it('rewrites the Receipt cell when he renames a kept receipt in Files, and follows the ledger itself', async () => {
    vi.useFakeTimers()
    try {
      const got = await send('coffee.png')
      await vi.advanceTimersByTimeAsync(50)
      await call('work.money.accept', { id: got.id, fields: fields() })
      const dir = join(b.ref, 'Money', 'Receipts', '2026')
      const from = join(dir, '2026-11-21 Blue Heron Coffee 10.43.png')
      const to = join(dir, 'Coffee with the crew.png')
      const hook = movedHook(b.ctx)
      renameSync(from, to)
      hook({ at: 'file', host: 'env_box', path: from }, { at: 'file', host: 'env_box', path: to }, { db: b.db, dataDir: '', host: 'env_box' })
      await vi.advanceTimersByTimeAsync(50)
      expect(b.sheets.grid(ledger())[1][8]).toBe('Receipts/2026/Coffee with the crew.png')

      const moved = join(b.ref, 'Money', 'Books 2026.tcsheet')
      b.sheets.sheets.set(moved, b.sheets.sheets.get(ledger())!)
      renameSync(ledger(), moved)
      hook({ at: 'file', host: 'env_box', path: ledger() }, { at: 'file', host: 'env_box', path: moved }, { db: b.db, dataDir: '', host: 'env_box' })
      expect((await call<{ ledger: { path: string } }>('work.money.open', { workspaceId: 'ws-ref' })).ledger.path).toBe(moved)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rewrites only the rows that held the old name', async () => {
    await call('work.money.entry', { workspaceId: 'ws-ref', fields: fields() })
    b.sheets.type(ledger(), 'I2', 'Receipts/2026/a.png')
    expect(await relink(b.ctx, 'ws-ref', 'Receipts/2026/a.png', 'Receipts/2026/b.png')).toBe(1)
    expect(await relink(b.ctx, 'ws-ref', 'Receipts/2026/a.png', 'Receipts/2026/c.png')).toBe(0)
    expect(b.sheets.grid(ledger())[1][8]).toBe('Receipts/2026/b.png')
  })
})

describe('what a thread may leave', () => {
  const tool = (name: string) => moneyTools.find((t) => t.name === name)!
  const run = (name: string, args: unknown, sessionId = 't-ref') =>
    tool(name)
      .run(args, { ...b.ctx, sessionId, scope: b.ctx.scopeOf(sessionId)!, signal: new AbortController().signal } as never)
      .then((r) => ({ text: (r.content[0] as { text: string }).text, isError: r.isError }))

  it('offers two tools that change something and one that reads, and none that writes the ledger', () => {
    expect(moneyTools.map((t) => [t.name, t.readOnly])).toEqual([
      ['money_read', true],
      ['money_add', false],
      ['money_receipt', false]
    ])
  })

  it('money_add lands in To confirm with the thread named, never in the ledger, and never twice', async () => {
    const args = { date: '2026-11-07', who: 'West Side HS', amount: 80, way: 'in', category: 'Game fees', for: 'Varsity' }
    const got = await run('money_add', args)
    expect(got.isError).toBeUndefined()
    expect(got.text).toContain('It is not in the ledger until he accepts it.')
    expect((await run('money_add', args)).text).toContain('nothing was added twice')
    const now = await view()
    expect(now.made).toBe(false)
    expect(now.toConfirm).toMatchObject([{ state: 'ready', source: 'agent', threadId: 't-ref', picture: false, name: null, fields: { amount: 8000, date: '2026-11-07', who: 'West Side HS', category: 'Game fees', way: 'in', what: 'Varsity' } }])
    // His accept files it as money in.
    await call('work.money.accept', { id: now.toConfirm[0].id, fields: fields({ date: '2026-11-07', who: 'West Side HS', way: 'in', amount: 8000, category: 'Game fees', what: 'Varsity', status: 'Unpaid' }) })
    expect((await view()).owed).toMatchObject([{ who: 'West Side HS', amount: 8000, way: 'toHim' }])
  })

  it('money_receipt hands over a file of the job’s own folder, which is read like any receipt', async () => {
    copyFileSync(fixture('fuel.jpg'), join(b.ref, 'fuel.jpg'))
    expect((await run('money_receipt', { file: join(b.ref, 'fuel.jpg') })).text).toContain('will wait for the owner to confirm')
    await settle()
    expect((await view()).toConfirm).toMatchObject([{ source: 'agent', threadId: 't-ref', picture: true, fields: { amount: 4817 } }])
  })

  it('refuses a file outside the job’s folder, a file that is none, and both or neither of file and item', async () => {
    expect((await run('money_receipt', { file: fixture('fuel.jpg') })).text).toContain("its job's own folder")
    expect((await run('money_receipt', { file: join(b.ref, 'gone.jpg') })).isError).toBe(true)
    expect((await run('money_receipt', {})).text).toContain('one of the two')
    expect((await run('money_receipt', { item: 'nope' })).text).toContain('no item nope')
    expect((await view()).toConfirm).toEqual([])
  })

  it('takes a mail’s file from the canvas item it was opened in', async () => {
    const dir = join(b.root, 'data', 'canvas', 't-ref', 'item-1', 'file')
    mkdirSync(dir, { recursive: true })
    copyFileSync(fixture('invoice.pdf'), join(dir, 'invoice.pdf'))
    Object.assign(b.ctx.canvas, { get: (id: string) => (id === 'item-1' ? { id, sessionId: 't-ref', title: 'invoice.pdf', kind: 'pdf', source: { at: 'mail', threadId: 'm', messageId: 'x', partId: '1', name: 'invoice.pdf' } } : null) })
    expect((await run('money_receipt', { item: 'item-1' })).isError).toBeUndefined()
    expect((await view()).toConfirm).toMatchObject([{ name: 'invoice.pdf', source: 'agent' }])
  })
})

describe('the reader', () => {
  it('registers jpg and png to lines, on the Docling tool folder, so a host without it forwards', () => {
    expect(MONEY_CONVERTERS.map((c) => [c.from, c.to, c.needs])).toEqual([
      ['jpg', 'lines', 'docling-models'],
      ['png', 'lines', 'docling-models']
    ])
    expect(money.convert).toBe(MONEY_CONVERTERS)
  })

  it('ships a script with no backtick and no dollar-brace, which calls no model service and reads offline', () => {
    expect(LINES_PY).not.toMatch(/`|\$\{/)
    expect(LINES_PY).toContain('PP-OCRv6_det_small.pth')
    expect(LINES_PY).not.toMatch(/http|requests|urllib/)
  })

  it('cuts a PDF block of several lines into its lines, top to bottom, a later page under an earlier', () => {
    const lines = linesOfExtract({
      blocks: [
        { page: 2, bbox: [0.1, 0.1, 0.5, 0.2], text: 'Page two' },
        { page: 1, bbox: [0.1, 0.1, 0.5, 0.3], text: 'A\n\nB' }
      ]
    })
    expect(lines.map((l) => [l.text, l.box![1]])).toEqual([
      ['Page two', 1.1],
      ['A', 0.1],
      ['B', 0.2]
    ])
  })

  it('reads a waiting file only while it is still waiting', async () => {
    const got = await send('coffee.png')
    await call('work.money.drop', { id: got.id })
    await readWaiting(b.ctx, got.id)
    expect((await view()).toConfirm).toEqual([])
  })
})
