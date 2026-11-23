import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import type { ClientRequest } from '@shared/contract'
import type { CanvasItem } from '@shared/work'
import { at, makeRig, peer, phone, thread, window, type Rig } from '../files/testkit'
import { GOOGLE_MIME } from '../google/client'
import { FakeGoogle, FAKE_TOKEN_URL } from '../google/fake'
import { resetGoogle, setGoogleDeps } from '../google/google'
import { google } from '../google/index'
import { registerUploadBytes } from '../google/uploads'
import type { Caller } from '../modules'
import { blankWorkbook } from './host/backends'
import { sheets } from './index'
import { previewsDir } from './preview'
import { canSaveToGoogle, SHARED_STAYS, sheetUploadBytes } from './toGoogle'

/**
 * "Save to Google Sheets" end to end on this host: the google pillar's own wire (`work.google.upload`) over its
 * fake Google, the sheets pillar's real provider (toGoogle.ts) over real workbooks in the Files rig's dummy
 * folders. No Google is reached and nothing is signed in: the fake is a `fetch` in Drive's shapes.
 */
const ME = 'landon@example.com'
const CORPUS = join(import.meta.dirname, 'harness/corpus')
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

let rig: Rig
let fake: FakeGoogle
let results: { kind: string; summary: string; account?: string }[]
let held: unknown[]
/** the sheet the Work service holds, as its `open` and `snapshot` answer it */
let service: unknown
let stop: () => void
let asked: number

const call = <T>(method: string, params: unknown, by: Caller = window) =>
  google.handle!({ id: '1', method, params } as unknown as ClientRequest, rig.ctx, by).then((r) => (r as { result: T }).result)
const upload = (item: CanvasItem, by: Caller = window) => call<{ fileId: string; url: string }>('work.google.upload', { itemId: item.id, account: ME }, by)
const open = (path: string, session = 't1'): CanvasItem => rig.ctx.canvas.open(session, 'sheet', at(path), path.split('/').pop()!)
const uploads = (): string[] => fake.calls.filter((c) => c.includes('/upload/'))
const book = (name: string, to: string): string => (copyFileSync(join(CORPUS, name), to), to)

beforeEach(() => {
  rig = makeRig()
  rig.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)')
  google.ensure(rig.db)
  sheets.ensure(rig.db)
  fake = new FakeGoogle().account(ME)
  results = []
  held = []
  service = null
  asked = 0
  Object.assign(rig.ctx, {
    lifeos: { jwt: async () => fake.jwt, connected: () => true, owner: () => ({ query: async () => [{ account: ME, files: true, writes: false }] }) },
    results: { add: (r: (typeof results)[number]) => results.push(r) },
    held: { create: (a: unknown) => (held.push(a), { state: 'held', summary: '' }) },
    service: {
      internal: async (route: string) => {
        const data = Buffer.from(JSON.stringify(service))
        if (route === '/internal/sheet/open') return { rev: 1 }
        if (route === '/internal/sheet/snapshot') return { data: data.toString('base64'), size: data.length }
        throw new Error(`no ${route}`)
      }
    }
  })
  setGoogleDeps({ fetch: fake.fetch, tokenUrl: FAKE_TOKEN_URL, blocksOf: async () => [] })
  // What sheets/index.ts does when the module loads, counted here.
  stop = registerUploadBytes('sheet', (ctx, item, signal) => (asked++, sheetUploadBytes(ctx, item, signal)))
})
afterEach(() => {
  stop()
  resetGoogle()
  rig.close()
})

describe('his own workbook', () => {
  it('goes to his Drive as the Excel file it is, converted by Google into a spreadsheet, with a result and no held act', async () => {
    const path = book('formulas.xlsx', join(rig.folder, 'Budget.xlsx'))
    const item = open(path)
    expect(canSaveToGoogle(rig.ctx, item)).toBe(true)
    const got = await upload(item)
    const made = fake.files.get(got.fileId)!
    expect(made).toMatchObject({ name: 'Budget', mimeType: GOOGLE_MIME.sheet, reach: new Set([ME]) })
    expect(made.uploaded?.mime).toBe(XLSX)
    // The file's own bytes: nothing was re-written on the way.
    expect(made.uploaded?.bytes.equals(readFileSync(path))).toBe(true)
    expect(got.url).toContain(got.fileId)
    expect(results).toMatchObject([{ kind: 'google.sheet.upload', summary: 'Saved Budget to Google Sheets', account: ME }])
    expect(held).toEqual([])
    // Reading the workbook drew nothing and left nothing behind.
    expect(existsSync(previewsDir(rig.dataDir)) ? readdirSync(previewsDir(rig.dataDir)) : []).toEqual([])
  })

  it('sends a macro workbook as one: Drive is told the type, and its name loses the extension', async () => {
    const item = open(book('macro.xlsm', join(rig.folder, 'Macros.xlsm')))
    const got = await upload(item)
    expect(fake.files.get(got.fileId)).toMatchObject({ name: 'Macros', mimeType: GOOGLE_MIME.sheet, uploaded: { mime: 'application/vnd.ms-excel.sheet.macroEnabled.12' } })
  })

  it('sends a sheet of ours as the .xlsx the model writer makes of it as it stands', async () => {
    const wb = blankWorkbook('wb1', 'Roster')
    const first = wb.sheetOrder[0]!
    wb.sheets[first]!.cellData = { 0: { 0: { v: 'Player' }, 1: { v: 'Rank' } }, 1: { 0: { v: 'Ada' }, 1: { v: 3 } } }
    service = wb
    const item = open(join(rig.folder, 'Roster.tcsheet'))
    expect(canSaveToGoogle(rig.ctx, item)).toBe(true)
    const got = await upload(item)
    const made = fake.files.get(got.fileId)!
    expect(made).toMatchObject({ name: 'Roster', mimeType: GOOGLE_MIME.sheet })
    expect(made.uploaded?.mime).toBe(XLSX)
    const back = importXlsx(new Uint8Array(made.uploaded!.bytes)).workbook
    const cells = back.sheets[back.sheetOrder[0]!]!.cellData!
    expect([cells[0]![0]!.v, cells[0]![1]!.v, cells[1]![0]!.v, cells[1]![1]!.v]).toEqual(['Player', 'Rank', 'Ada', 3])
  })
})

describe('who may', () => {
  it('refuses a thread and another host of his before the workbook is read; a remote key is held to the file fence', async () => {
    const item = open(book('formulas.xlsx', join(rig.folder, 'Budget.xlsx')))
    await expect(upload(item, thread())).rejects.toThrow('Only the owner saves a file to Google, from his own window.')
    await expect(upload(item, peer)).rejects.toThrow('Only the owner saves a file to Google, from his own window.')
    expect(asked).toBe(0)
    // A remote key that could not name the file itself is stopped at the item's fence.
    rig.roots.length = 0
    await expect(upload(item, phone)).rejects.toThrow(/outside app-managed roots/)
    expect(asked).toBe(0)
    expect(uploads()).toEqual([])
    expect(results).toEqual([])
    expect(held).toEqual([])
  })
})

describe('workbooks that stay here', () => {
  it("keeps a team library's workbook on this host: no row in More, and the upload is refused before any byte is read", async () => {
    const path = book('formulas.xlsx', join(rig.team, 'General', 'Spring budget.xlsx'))
    const item = open(path)
    expect(canSaveToGoogle(rig.ctx, item)).toBe(false)
    await expect(upload(item)).rejects.toThrow('A file from a shared library stays on this host.')
    expect(asked).toBe(0)
    // And this pillar's own provider says the same, should anything ever ask it past that check.
    await expect(sheetUploadBytes(rig.ctx, item)).rejects.toThrow(SHARED_STAYS)
    expect(uploads()).toEqual([])
    expect(existsSync(join(rig.dataDir, 'work-files'))).toBe(false)
  })

  it('keeps a workbook on another host of his, his own OneDrive and a Teams snapshot here too', () => {
    const elsewhere = rig.ctx.canvas.open('t1', 'sheet', at(join(rig.folder, 'Budget.xlsx'), 'env_mac'), 'Budget.xlsx')
    const cloud = open(book('formulas.xlsx', join(rig.mine, 'Mine.xlsx')))
    const snapshot = open(join(rig.dataDir, 'attachments', 'teams-files', 't1', 'snapshot', 'Budget.xlsx'))
    for (const item of [elsewhere, cloud, snapshot]) expect(canSaveToGoogle(rig.ctx, item), JSON.stringify(item.source)).toBe(false)
  })

  it('offers nothing for a spreadsheet Google already holds, and the upload says so', async () => {
    const item = rig.ctx.canvas.open('t1', 'sheet', { at: 'google', account: ME, fileId: 'sh1', mime: GOOGLE_MIME.sheet } as CanvasItem['source'], 'Budget')
    expect(canSaveToGoogle(rig.ctx, item)).toBe(false)
    await expect(upload(item)).rejects.toThrow('Budget is in Google Sheets already.')
    expect(asked).toBe(0)
  })

  it('stops before the upload when the call is cancelled', async () => {
    const item = open(book('formulas.xlsx', join(rig.folder, 'Budget.xlsx')))
    const gone = new AbortController()
    gone.abort()
    await expect(sheetUploadBytes(rig.ctx, item, gone.signal)).rejects.toThrow()
    expect(uploads()).toEqual([])
  })
})
