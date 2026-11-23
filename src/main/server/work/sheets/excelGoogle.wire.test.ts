import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { SheetView } from '@shared/contract-work-sheets'
import type { SessionMeta } from '@shared/events'
import type { CanvasSource, WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { canvasStoreOf } from '../canvas/store'

/**
 * SHT9 through the mount (index.ts, held.ts, jobs.ts, tools.ts): what waits in Excel as the view and
 * `sheet_read` say it, Save to Google Sheets as the view offers it, and Check in Excel's two methods on a host
 * with no Office in reach. The parts themselves are checkExcel.test.ts, toGoogle.test.ts and excelWaits.test.ts.
 */
vi.mock('../scope', async (original) => ({
  ...(await original<typeof import('../scope')>()),
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: null, host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
vi.mock('../threads', () => ({ threadsPart: () => ({ threads: { start: async () => 'x', resume: async () => {}, ownerSaid: () => false } }) }))
const { startWork } = await import('../ctx')
const { canvas } = await import('../canvas/index')
const { sheets } = await import('./index')
const { setJobs } = await import('./held')
const { localJobs } = await import('./workerClient')
setJobs(localJobs)

const CORPUS = join(import.meta.dirname, 'harness/corpus')
let dir: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
const sessions = new Map<string, SessionMeta>()
const registry = { get: (id: string) => sessions.get(id) ?? null, onRemoved: () => () => {}, onWorkspaceDeleted: () => () => {} } as unknown as SessionRegistry

const call = async <T = unknown,>(method: string, params: unknown): Promise<T> => {
  const out = await work.handle(ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest), LOCAL_PRINCIPAL)
  return (out.handled ? out.result : undefined) as T
}
const tool = async (name: string, args: unknown): Promise<string> => {
  const r = (await work.tools.call({ id: 't1', scope: 'work' }, name, args, new AbortController().signal)) as { content: Array<{ text?: string }> }
  return r.content.map((c) => c.text ?? '').join('')
}
const file = (path: string, host = 'env_test'): CanvasSource => ({ at: 'file', host, path })
const open = (corpus: string, name: string, host?: string): string => {
  const path = join(dir, name)
  copyFileSync(join(CORPUS, corpus), path)
  return canvasStoreOf(db).open('t1', { kind: 'sheet', source: file(path, host), title: name }).id
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-sht9-'))
  db = openDb(join(dir, 'test.db'))
  sessions.set('t1', { id: 't1', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: { roots: () => [dir], denied: () => [] } }, [canvas, sheets])
  await call('work.set', { enabled: true })
})
afterEach(() => {
  work.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('what waits in Excel', () => {
  it('is counted in the view of an opened Excel file, and absent where the grid reaches everything', async () => {
    expect((await call<SheetView>('work.sheets.open', { itemId: open('pivot.xlsx', 'Pivot.xlsx') })).reach).toEqual({ parts: ['2 pivot tables'], to: 'excel' })
    expect((await call<SheetView>('work.sheets.open', { itemId: open('macro.xlsm', 'Macro.xlsm') })).reach?.parts).toEqual(['macros', 'a form control'])
    expect((await call<SheetView>('work.sheets.open', { itemId: open('formulas.xlsx', 'Budget.xlsx') })).reach).toBeUndefined()
  })

  it('is said to a thread that reads the workbook, once, after the cells', async () => {
    open('pivot.xlsx', 'Pivot.xlsx')
    const read = await tool('sheet_read', { file: join(dir, 'Pivot.xlsx'), range: 'A1:B2' })
    expect(read.endsWith('\n\nThis workbook also holds 2 pivot tables: only Excel changes those, and the owner opens the file there with the switch beside the sheet.')).toBe(true)
    open('formulas.xlsx', 'Budget.xlsx')
    expect(await tool('sheet_read', { file: join(dir, 'Budget.xlsx'), range: 'A1:B2' })).not.toContain('only Excel')
  })
})

describe('Save to Google Sheets, as the view offers it', () => {
  it('is offered for his own workbook and not for one on another host of his', async () => {
    expect((await call<SheetView>('work.sheets.open', { itemId: open('formulas.xlsx', 'Budget.xlsx') })).canUpload).toBe(true)
    const far = canvasStoreOf(db).open('t1', { kind: 'sheet', source: file(join(dir, 'Budget.xlsx'), 'env_other'), title: 'Far.xlsx' })
    const { canSaveToGoogle } = await import('./toGoogle')
    expect(canSaveToGoogle({ db, host: 'env_test', dataDir: dir }, far)).toBe(false)
  })
})

describe('Check in Excel on a host with no Office in reach', () => {
  it('says none, and a press is answered notInReach with nothing drawn', async () => {
    const itemId = open('formulas.xlsx', 'Budget.xlsx')
    expect(await call('work.sheets.previewOffice', { itemId })).toEqual({ app: 'excel', state: 'none' })
    expect(await call('work.sheets.preview', { itemId, format: 'xlsx', by: 'office' })).toEqual({ notInReach: 'none' })
  })
})
