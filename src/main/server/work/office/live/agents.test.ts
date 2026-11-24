import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { TeamsLibrary } from '@shared/contract-work-office'
import type { HeldItem, WorkToolResult } from '@shared/work'
import type { ActCtx, ToolCtx } from '../../modules'
import { ensureSuggestionTables, SuggestionStore } from '../../sheets/suggestions'
import { withAddin } from '../addin/carrier'
import { AddinHub } from '../addin/hub'
import { addinTools, type AddinToolsOptions } from '../addin/index'
import type { AddinKeys } from '../addin/keys'
import type { OfficeApp } from '@shared/contract-work-office'
import type { OfficeCarrier } from '../carrier'
import { ensureExcelTables, ExcelHelper } from '../excel'
import { FakeOffice } from '../fake'
import { officeActs, OfficeEditSchema } from '../held'
import { openAddress, sameCloudFile, syncedFilesOf } from './address'
import { BEHIND, keyedArgs, openByAddress, syncedCopies } from './agents'

/**
 * An agent's office tools on a live file: the tab names it by its address, the add-in or Word in the VM by their own
 * form of it. A held edit finds the add-in's session first, then Word in the VM, never a path copy, and nothing is
 * written before his press.
 */

const PATH = '/personal/owner_purdue_edu/Documents/TempCode proof live 1.docx'
/** the live tab's address (liveAddress) */
const TAB = `https://purdue0-my.sharepoint.com${PATH.replace(/ /g, '%20')}?web=1`
/** what the add-in says: `Office.context.document.url` */
const ADDIN_KEY = `https://purdue0-my.sharepoint.com/:w:/r${PATH.replace(/ /g, '%20')}`
/** another file beside it */
const OTHER = TAB.replace('live%201', 'live%202')
/** Word's `FullName` for the same file opened by its address */
const FULL_NAME = `https://purdue0-my.sharepoint.com${PATH.replace(/ /g, '%20')}`

const noKeys = { check: () => 'key1', pair: () => null } as unknown as AddinKeys

/** A hub with one Word add-in on `key`, whose calls the test answers from `doc`. */
function hubWith(key: string | null, doc: { paragraphs: string[] }, ops: { op: string; args: unknown }[]): AddinHub {
  const hub: AddinHub = new AddinHub({ keys: noKeys, heard: () => {}, log: () => {} })
  hub.attach({
    send(text) {
      const m = JSON.parse(text) as { t: string; conn: number; data?: { t: string; id: number; op: string; args: { edit: { find: string; replace: string } } } }
      if (m.t !== 'send' || m.data?.t !== 'call') return
      const { id, op, args } = m.data
      ops.push({ op, args })
      let value: unknown = null
      if (op === 'word.read') value = [...doc.paragraphs]
      if (op === 'word.edit') {
        const { find, replace } = args.edit
        value = doc.paragraphs.reduce((n, p) => n + p.split(find).length - 1, 0)
        doc.paragraphs = doc.paragraphs.map((p) => p.split(find).join(replace))
      }
      queueMicrotask(() => hub.receive(JSON.stringify({ t: 'msg', conn: m.conn, data: { t: 'result', id, value } })))
    }
  })
  if (key) {
    hub.receive(JSON.stringify({ t: 'open', conn: 7, first: { t: 'hello', key: 'k', app: 'word', platform: 'OfficeOnline' }, from: 'x' }))
    hub.receive(JSON.stringify({ t: 'msg', conn: 7, data: { t: 'file', file: { key, name: 'TempCode proof live 1.docx' } } }))
  }
  return hub
}

/** Word in the VM: opening by address lists the file under its FullName. */
class VmWord extends FakeOffice {
  override async open(app: OfficeApp, ref: unknown) {
    await super.open(app, ref)
    if (app === 'word' && (ref as { kind: string }).kind === 'url') this.docs.set(FULL_NAME, { paragraphs: ['Draft one.'], tracked: [] })
  }
}

describe('one cloud file by every form of its address', () => {
  it('matches the tab, the add-in and Word, and no other file', () => {
    expect(sameCloudFile(TAB, ADDIN_KEY)).toBe(true)
    expect(sameCloudFile(TAB, FULL_NAME)).toBe(true)
    expect(sameCloudFile(TAB.replace('Documents', 'DOCUMENTS'), FULL_NAME)).toBe(true)
    expect(sameCloudFile(TAB, OTHER)).toBe(false)
    expect(sameCloudFile('/Users/him/Plan.docx', '/Users/him/Plan.docx')).toBe(true)
    expect(sameCloudFile('/Users/him/Plan.docx', '/users/him/plan.docx')).toBe(false)
  })
  it('opens the direct link in Office, a GUID redirect as it is', () => {
    expect(openAddress(TAB)).toBe(FULL_NAME)
    expect(openAddress(ADDIN_KEY)).toBe(FULL_NAME)
    const guid = 'https://purdue0-my.sharepoint.com/personal/x/_layouts/15/Doc.aspx?sourcedoc=%7Bab%7D&action=edit'
    expect(openAddress(guid)).toBe(guid)
  })
  it('the hub finds an add-in by any form of its file, and lists one file once', () => {
    const hub = hubWith(ADDIN_KEY, { paragraphs: [] }, [])
    expect(hub.sessionFor('word', TAB)?.conn).toBe(7)
    expect(hub.sessionFor('word', FULL_NAME)?.conn).toBe(7)
    expect(hub.sessionFor('excel', TAB)).toBeUndefined()
    expect(hub.sessionFor('word', OTHER)).toBeUndefined()
    hub.receive(JSON.stringify({ t: 'open', conn: 8, first: { t: 'hello', key: 'k', app: 'word', platform: 'Mac' }, from: 'x' }))
    hub.receive(JSON.stringify({ t: 'msg', conn: 8, data: { t: 'file', file: { key: FULL_NAME, name: 'TempCode proof live 1.docx' } } }))
    expect(hub.files('word').map((s) => s.conn)).toEqual([8])
  })
  it("names the file by the carrier's own key, and leaves a path alone", async () => {
    const word = new FakeOffice()
    word.docs.set(FULL_NAME, { paragraphs: [], tracked: [] })
    expect(await keyedArgs(word, { document: TAB, find: 'a', replace: 'b' })).toEqual({ document: FULL_NAME, find: 'a', replace: 'b' })
    expect(await keyedArgs(word, { document: '/Users/him/Plan.docx' })).toEqual({ document: '/Users/him/Plan.docx' })
    expect(await keyedArgs(word, { document: OTHER })).toEqual({ document: OTHER })
  })
  it('opens by address once, and says so when Word never lists it', async () => {
    const vm = new VmWord()
    expect(await openByAddress(vm, { app: 'word', key: TAB }, { sleep: async () => {} })).toBe(FULL_NAME)
    expect(await openByAddress(vm, { app: 'word', key: ADDIN_KEY }, { sleep: async () => {} })).toBe(FULL_NAME)
    expect(vm.opened).toEqual([{ app: 'word', ref: { kind: 'url', url: FULL_NAME } }])
    await expect(openByAddress(new FakeOffice(), { app: 'word', key: TAB }, { ms: 4, every: 2, sleep: async () => {} })).rejects.toThrow('did not open the file by its address within 0 s')
    const elsewhere = new VmWord()
    await expect(openByAddress(elsewhere, { app: 'word', key: 'https://example.com/Plan.docx' }, { sleep: async () => {} })).rejects.toThrow("only on Microsoft's own sites")
    expect(elsewhere.opened).toEqual([])
  })
})

describe('the synced copies of a file named by its address', () => {
  const web = 'https://purdue0.sharepoint.com/sites/RecWell/Shared%20Documents'
  const base = { tenant: 'Purdue University', channels: [] as string[], found: true, library: null }
  const vm: TeamsLibrary = { ...base, id: 'env_box~vm', host: 'env_box', vm: true, path: 'C:\\Sync\\RecWell - Documents', team: 'RecWell', kind: 'channels', channels: ['Team RecWell'], web }
  const mac: TeamsLibrary = { ...base, id: 'env_mac~team', host: 'env_mac', path: '/sync/RecWell-TeamRecWell', team: 'RecWell-TeamRecWell', kind: 'library', web: null }
  const url = `${web}/Team%20RecWell/FY%2026/Plan.docx?web=1`

  it('finds the library whose web folder holds it, then its twin elsewhere', () => {
    expect(syncedFilesOf([mac, vm], url).map((s) => [s.library.id, s.path])).toEqual([
      ['env_box~vm', 'C:\\Sync\\RecWell - Documents\\Team RecWell\\FY 26\\Plan.docx'],
      ['env_mac~team', '/sync/RecWell-TeamRecWell/FY 26/Plan.docx']
    ])
    expect(syncedCopies([mac, vm], url, false).map((s) => s.library.id)).toEqual(['env_mac~team'])
  })
  it('refuses a file outside every web folder or a path that climbs out', () => {
    expect(syncedFilesOf([mac, vm], 'https://purdue0.sharepoint.com/sites/Other/Plan.docx')).toEqual([])
    expect(syncedFilesOf([vm], `${web}/a/..%2F..%2Fx.docx`)).toEqual([])
    expect(syncedFilesOf([vm], '/Users/him/Plan.docx')).toEqual([])
  })
})

describe('a held edit on a live file', () => {
  let db: DatabaseSync
  let held: { kind: string; sessionId: string | null; payload: unknown }[]
  let peer: unknown[]
  let woke: number
  let offered: boolean
  let desktops: string[]
  const text = (r: WorkToolResult): string => r.content.map((c) => ('text' in c ? c.text : '')).join('')
  const ctx = (): ToolCtx =>
    ({
      db,
      host: 'env_box',
      held: {
        create(act: { kind: string; sessionId: string | null; payload: unknown }) {
          held.push(act)
          return { state: 'held', summary: `held ${act.kind}` } as HeldItem
        }
      },
      threads: { ownerSaid: () => false },
      settings: { workspace: () => ({ mayUseDesktop: desktops }) },
      peer: () => ({ call: async (...a: unknown[]) => (peer.push(a), { content: [{ type: 'text', text: 'from the Mac' }], isError: true }) }),
      scope: { workspaceId: 'w1' },
      sessionId: 't1'
    }) as unknown as ToolCtx
  /** The box: Outlook on the web as its own carrier, the add-in riding on it, Word in the VM beside. */
  const box = (hub: AddinHub, vmWord: FakeOffice, synced?: AddinToolsOptions['synced'], mayOpen: AddinToolsOptions['mayOpen'] = async () => true) => {
    const owa = Object.assign(new FakeOffice(), { kind: 'owa' }) as unknown as OfficeCarrier
    const carrier = withAddin(owa, () => hub)
    const suggestions = new SuggestionStore(db)
    const tools = addinTools(() => ({ carrier, excel: new ExcelHelper(carrier, db, suggestions), suggestions }), {
      offered: () => offered,
      awake: async () => void woke++,
      here: () => ({ carrier: vmWord, excel: new ExcelHelper(vmWord, db, suggestions), suggestions }),
      open: { sleep: async () => {} }
    }, { synced, hub: () => hub, mayOpen })
    return { carrier, run: (name: string, args: unknown) => tools.find((t) => t.name === name)!.run(args, ctx()) }
  }
  const press = (carrier: OfficeCarrier, vmWord: FakeOffice) =>
    officeActs({ carrier: () => carrier, vm: async () => vmWord }).find((a) => a.kind === 'office.edit')!.execute(OfficeEditSchema.parse(held[0]!.payload), { host: 'env_box' } as ActCtx)

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    ensureSuggestionTables(db)
    ensureExcelTables(db)
    held = []
    peer = []
    woke = 0
    offered = true
    desktops = ['env_mac']
  })

  it("goes to the add-in's session by the tab's address, and is written only on his press", async () => {
    const doc = { paragraphs: ['Draft one.'] }
    const ops: { op: string; args: unknown }[] = []
    const vmWord = new VmWord()
    const { carrier, run } = box(hubWith(ADDIN_KEY, doc, ops), vmWord)
    expect(text(await run('office_doc_read', { document: TAB }))).toContain('Draft one.')
    const r = await run('office_doc_edit', { document: TAB, find: 'one', replace: 'two', because: 'own' })
    expect(text(r)).toMatch(/Nothing in the file changed/)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ kind: 'office.edit', payload: { app: 'word', key: ADDIN_KEY, places: 1 } })
    expect(held[0]!.payload).not.toHaveProperty('vm')
    // read twice, written never; the VM, the Mac and any path untouched
    expect(ops.map((o) => o.op)).toEqual(['word.read', 'word.read'])
    expect(doc.paragraphs).toEqual(['Draft one.'])
    expect([woke, vmWord.opened.length, peer.length]).toEqual([0, 0, 0])

    expect(await press(carrier, vmWord)).toEqual({ summary: 'Changed TempCode proof live 1.docx' })
    // with what his press was shown, which the add-in reads again before it writes
    expect(ops.at(-1)).toEqual({ op: 'word.edit', args: { edit: { find: 'one', replace: 'two' }, tracked: false, bound: { places: 1, at: [[0, 'Draft one.']] } } })
    expect(doc.paragraphs).toEqual(['Draft two.'])
    expect(vmWord.log.some((l) => l.verb === 'editDocument')).toBe(false)
  })

  it('with no add-in, Word in the VM opens it by its address, and the press goes there', async () => {
    const vmWord = new VmWord()
    const { carrier, run } = box(hubWith(null, { paragraphs: [] }, []), vmWord)
    await run('office_doc_edit', { document: TAB, find: 'one', replace: 'two', because: 'own' })
    expect(vmWord.opened).toEqual([{ app: 'word', ref: { kind: 'url', url: FULL_NAME } }])
    expect(held[0]).toMatchObject({ kind: 'office.edit', payload: { key: FULL_NAME, vm: true } })
    expect(vmWord.log.some((l) => l.verb === 'editDocument')).toBe(false)
    expect(vmWord.docs.get(FULL_NAME)!.paragraphs).toEqual(['Draft one.'])
    expect(peer).toEqual([])

    await press(carrier, vmWord)
    expect(vmWord.log.filter((l) => l.verb === 'editDocument').map((l) => l.args[0])).toEqual([FULL_NAME])
    expect(vmWord.docs.get(FULL_NAME)!.paragraphs).toEqual(['Draft two.'])
    // opened once: the press found it by its FullName
    expect(vmWord.opened).toHaveLength(1)
  })

  it('never has the VM open an address outside every library the thread may reach', async () => {
    const vmWord = new VmWord()
    const { run } = box(hubWith(null, { paragraphs: [] }, []), vmWord, undefined, async () => false)
    const r = await run('office_doc_read', { document: TAB })
    expect(JSON.stringify(r)).toContain('not in a Teams or OneDrive library this thread may reach')
    expect(vmWord.opened).toEqual([])
  })

  it('with neither, a read comes from the synced copy and says it may be behind; a change is not made of a copy', async () => {
    offered = false
    desktops = []
    const asked: string[] = []
    const { run } = box(hubWith(null, { paragraphs: [] }, []), new VmWord(), async (_ctx, url, vm) => (asked.push(`${url} ${vm}`), { text: 'Draft one.', truncated: false }))
    const r = await run('office_doc_read', { document: TAB })
    expect(r.isError).toBeFalsy()
    expect(text(r)).toBe(`${BEHIND}\n\nDraft one.`)
    expect(asked).toEqual([`${TAB} false`])
    const edit = await run('office_doc_edit', { document: TAB, find: 'one', replace: 'two', because: 'own' })
    expect(edit.isError).toBe(true)
    expect(held).toEqual([])
    expect(asked).toHaveLength(1)
  })
})
