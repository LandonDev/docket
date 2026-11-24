import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkToolResult } from '@shared/work'
import type { ToolCtx } from '../../modules'
import { ensureSuggestionTables, SuggestionStore } from '../../sheets/suggestions'
import type { OfficeCarrier } from '../carrier'
import { ensureExcelTables, ExcelHelper } from '../excel'
import { FakeOffice } from '../fake'
import { addinTools, placesOf } from './index'

/**
 * Where an Office tool runs from a host whose own carrier has no Excel, Word or PowerPoint (the box:
 * Outlook on the web): its mail here, a file's tool in the Windows VM or on the desktop host by the
 * file's key. A host with the apps runs everything itself, as before.
 */

const GUEST = 'C:\\Users\\tcuser\\Documents\\Budget.xlsx'
const MAC = '/Users/him/Documents/Plan.xlsx'
const URL = 'https://purdue0.sharepoint.com/sites/RecWell/Shared Documents/Plan.xlsx'
const as = (kind: OfficeCarrier['kind']): OfficeCarrier => Object.assign(new FakeOffice(), { kind }) as unknown as OfficeCarrier

describe('the places a tool call is tried in', () => {
  it('a host with the apps runs everything itself', () => {
    for (const kind of ['mac', 'com', 'fake'] as const) {
      expect(placesOf(as(kind), 'office_range_read', { workbook: GUEST }, true, null)).toEqual(['here'])
      expect(placesOf(as(kind), 'office_files', {}, true, null)).toEqual(['here'])
      expect(placesOf(as(kind), 'office_mail_send', {}, true, null)).toEqual(['here'])
    }
  })
  it('the box keeps mail and calendar, and sends a file by its key', () => {
    const owa = as('owa')
    expect(placesOf(owa, 'office_mail_list', {}, true, null)).toEqual(['here'])
    expect(placesOf(owa, 'office_calendar_create', {}, true, null)).toEqual(['here'])
    expect(placesOf(owa, 'office_range_read', { workbook: GUEST }, true, null)).toEqual(['vm'])
    expect(placesOf(owa, 'office_doc_read', { document: MAC }, true, null)).toEqual(['away'])
    expect(placesOf(owa, 'office_slides_read', { deck: URL }, true, null)).toEqual(['vm', 'away'])
    expect(placesOf(owa, 'office_range_write', { workbook: 'Plan.xlsx' }, true, null)).toEqual(['vm', 'away'])
    expect(placesOf(owa, 'office_files', {}, true, null)).toEqual(['vm', 'away'])
  })
  it('without the VM (the setting off, or no Office in it) a file goes to the desktop host alone', () => {
    const owa = as('owa')
    expect(placesOf(owa, 'office_range_read', { workbook: URL }, false, null)).toEqual(['away'])
    expect(placesOf(owa, 'office_range_read', { workbook: GUEST }, false, null)).toEqual(['away'])
    expect(placesOf(owa, 'office_files', {}, false, null)).toEqual(['away'])
  })
  it('a host with no carrier at all sends its mail away too', () => {
    expect(placesOf(null, 'office_mail_list', {}, false, null)).toEqual(['away'])
    expect(placesOf(null, 'office_range_read', { workbook: GUEST }, true, null)).toEqual(['vm'])
  })
})

describe('a tool call from a box thread', () => {
  let db: DatabaseSync
  let vmOffice: FakeOffice
  let woke: number
  let peer: { verb: string; args: unknown }[]
  let offered: boolean
  let desktops: string[]
  let wakeFails: boolean
  const text = (r: WorkToolResult): string => r.content.map((c) => ('text' in c ? c.text : '')).join('')
  const ctx = (): ToolCtx =>
    ({
      db,
      host: 'env_box',
      settings: { workspace: () => ({ mayUseDesktop: desktops }) },
      threads: { ownerSaid: () => false },
      peer: () => ({
        call: async (_m: string, verb: string, args: unknown) => {
          peer.push({ verb, args })
          const tool = (args as { tool: string }).tool
          return { content: [{ type: 'text', text: tool === 'office_files' ? JSON.stringify({ apps: [], workbooks: [{ key: MAC }], documents: [], decks: [] }) : 'from the Mac' }] }
        }
      }),
      scope: { workspaceId: 'w1' },
      sessionId: 't1'
    }) as unknown as ToolCtx
  const tools = () => {
    const owa = as('owa')
    const suggestions = new SuggestionStore(db)
    const here = () => ({ carrier: owa, excel: new ExcelHelper(owa, db, suggestions), suggestions })
    const inVm = { carrier: vmOffice, excel: new ExcelHelper(vmOffice, db, suggestions), suggestions }
    const all = addinTools(here as never, {
      offered: () => offered,
      awake: async () => {
        woke++
        if (wakeFails) throw new Error('Windows did not come up within 300 s')
      },
      here: () => inVm,
      open: { ms: 4, every: 2, sleep: async () => {} }
    })
    return (name: string, args: unknown) => all.find((t) => t.name === name)!.run(args, ctx() as never)
  }

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    ensureSuggestionTables(db)
    ensureExcelTables(db)
    vmOffice = new FakeOffice()
    vmOffice.addBook(GUEST, { Sheet1: { A1: 'Item', B1: 120 } })
    woke = 0
    peer = []
    offered = true
    desktops = ['env_mac']
    wakeFails = false
  })

  it("reads a workbook in the Windows VM through Excel there, waking the machine first", async () => {
    const out = JSON.parse(text(await tools()('office_range_read', { workbook: GUEST, range: "'Sheet1'!A1:B1" })))
    expect(out.values).toEqual([['Item', 120]])
    expect(woke).toBe(1)
    expect(peer).toEqual([])
  })
  it("sends a Mac file's tool to the Mac and never wakes the VM for it", async () => {
    expect(text(await tools()('office_doc_read', { document: MAC }))).toBe('from the Mac')
    expect(woke).toBe(0)
    expect(peer[0]).toMatchObject({ verb: 'read', args: { tool: 'office_doc_read' } })
  })
  it('tries the VM, then the Mac, for a file named by a URL', async () => {
    expect(text(await tools()('office_doc_read', { document: URL }))).toBe('from the Mac')
    expect(woke).toBe(1)
    // Word in the VM was asked to open it by its address first
    expect(vmOffice.opened).toEqual([{ app: 'word', ref: { kind: 'url', url: 'https://purdue0.sharepoint.com/sites/RecWell/Shared%20Documents/Plan.xlsx' } }])
  })
  it('lists open files on every computer, each under its own', async () => {
    const out = JSON.parse(text(await tools()('office_files', {}))) as { computers: { on: string; workbooks: { key: string }[] }[] }
    expect(out.computers.map((c) => [c.on, c.workbooks.map((w) => w.key)])).toEqual([
      ['the Windows VM', [GUEST]],
      ['the desktop', [MAC]]
    ])
  })
  it('with the VM out of reach, a file there fails in words, and the list still shows the Mac', async () => {
    wakeFails = true
    const r = await tools()('office_range_read', { workbook: GUEST, range: "'Sheet1'!A1" })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/Windows VM could not be reached: Windows did not come up/)
    expect(JSON.parse(text(await tools()('office_files', {}))).workbooks).toEqual([{ key: MAC }])
  })
  it("with no desktop and no VM, says so rather than 'not on the box'", async () => {
    offered = false
    desktops = []
    const r = await tools()('office_range_read', { workbook: URL, range: "'Sheet1'!A1" })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/may use no desktop/)
  })
  it("keeps the box's own mail on the box", async () => {
    const r = await tools()('office_mail_list', { folder: 'inbox', limit: 5 })
    expect(r.isError).toBeFalsy()
    expect(peer).toEqual([])
    expect(woke).toBe(0)
  })
})
