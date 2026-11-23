import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import { besideSeatId as seatId, type FilesListing, type FilesOpened, type FilesPlaces, type FilesTabs } from '@shared/contract-work-files'
import { filesPaneOf, type CanvasItem } from '@shared/work'
import type { FileEntry } from '@shared/work/files'
import type { Caller } from '../modules'
import { closeFilesState, filesState } from './handle'
import { SEATS_MOST } from './tabs'
import { registerFileMaker } from './hooks'
import { files } from './index'
import { at, HOST, makeRig, peer, phone, thread, window, WS, type Rig } from './testkit'

/** The files pillar's wire (handle.ts) through the module, each request as the contract reads it. */

let rig: Rig
beforeEach(() => {
  rig = makeRig()
})
afterEach(() => {
  closeFilesState(rig.db)
  rig.close()
})

/** One request as a socket sends it: parsed by the contract first, so a shape the wire would refuse fails here too. */
async function call<T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> {
  const req = ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } })
  const out = await files.handle!(req, rig.ctx, by)
  if (!out.handled) throw new Error(`${method} was not handled`)
  return out.result as T
}
const names = (l: { entries: (FileEntry | null)[] }): string[] => l.entries.map((e) => e?.name ?? '(none)')
const place = async (id: string, by: Caller = window) => (await call<FilesPlaces>('work.files.places', {}, by)).places.find((p) => p.id === id || p.name === id)!

describe('places', () => {
  it("lists his marks, the workspace's folder, and one place per channel, library and OneDrive, each as others can open it or not", async () => {
    const got = await call<FilesPlaces>('work.files.places', {})
    expect(got.host).toBe(HOST)
    expect(got.places.map((p) => [p.kind, p.name, p.shared, p.group ?? null])).toEqual([
      ['home', 'Home', false, null],
      ['recent', 'Recent', false, null],
      ['starred', 'Starred', false, null],
      ['made', 'Made by threads', false, null],
      ['trash', 'Trash', false, null],
      ['folder', 'Dummy Esports', false, null],
      ['teams', 'Events', true, 'Esports Staff'],
      ['teams', 'General', true, 'Esports Staff'],
      ['onedrive', 'My OneDrive', true, null],
      // The workspace is linked to a sector: LifeOS and From mail are listed, greyed while this host has no LifeOS session.
      ['lifeos', 'LifeOS', false, null],
      ['mail', 'From mail', false, null]
    ])
    const general = got.places.find((p) => p.name === 'General')!
    expect(general).toMatchObject({ key: 'esportsstaffgeneral', env: HOST, state: { state: 'ok' }, root: { at: 'file', host: HOST, path: join(rig.team, 'General') } })
    expect(got.sources).toEqual([{ kind: 'folders', state: 'ok', account: null }])
    expect(got.rev).toBe(0)
  })

  it('gives another host of his the libraries alone, a thread no marks, and a remote key only what it could name', async () => {
    expect((await call<FilesPlaces>('work.files.places', {}, peer)).places.map((p) => p.kind)).toEqual(['teams', 'teams', 'onedrive'])
    expect((await call<FilesPlaces>('work.files.places', {}, thread('t1'))).places.map((p) => p.kind)).toEqual(['folder', 'teams', 'teams', 'onedrive'])
    // A key without approve is given no From mail.
    expect((await call<FilesPlaces>('work.files.places', {}, phone)).places.map((p) => p.kind)).toEqual(['home', 'recent', 'starred', 'made', 'trash', 'folder', 'lifeos'])
    await expect(call('work.files.places', {}, thread('t2'))).rejects.toThrow("A thread reaches only its own workspace's files.")
  })

  it('answers the libraries for a workspace that lives on another host, with no rows of its own', async () => {
    const got = await call<FilesPlaces>('work.files.places', { workspaceId: 'far-workspace' })
    expect(got.places.map((p) => p.kind)).toEqual(['teams', 'teams', 'onedrive'])
    expect(got.rev).toBe(0)
  })
})

describe('list', () => {
  it("lists the workspace's folder from its place, folders first, with the trail and no hidden name or link", async () => {
    const got = await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } })
    expect(names(got)).toEqual(['Events', 'Budget.xlsx', 'notes.txt', 'Run of show.tcdoc'])
    expect(got.place).toBe('folder')
    expect(got.trail).toEqual([{ name: 'Dummy Esports', at: { at: 'place', id: 'folder' } }])
    const [events, budget] = got.entries
    expect(events).toMatchObject({ kind: 'folder', ref: null, folder: at(join(rig.folder, 'Events')), key: `file:${HOST}:${join(rig.folder, 'Events')}` })
    expect(budget).toMatchObject({ kind: 'sheet', size: 1200, local: true, folder: null, ref: at(join(rig.folder, 'Budget.xlsx')) })
    expect(budget!.shared).toBeUndefined()
  })

  it('lists a folder inside it, with each step of the trail a folder to go to', async () => {
    const got = await call<FilesListing>('work.files.list', { at: at(join(rig.folder, 'Events', 'Spring LAN')) })
    expect(names(got)).toEqual(['Bracket.pdf'])
    expect(got.trail!.map((c) => c.name)).toEqual(['Dummy Esports', 'Events', 'Spring LAN'])
    expect(got.trail![1]!.at).toEqual(at(join(rig.folder, 'Events')))
  })

  it("lists a channel by its place, each row keyed by the place and the path inside it, shared, a cloud-only file marked and not read", async () => {
    const general = await place('General')
    const got = await call<FilesListing>('work.files.list', { at: general.root })
    expect(names(got)).toEqual(['Budgets', 'Cloud only.pdf', 'Plan.docx', 'Spring budget.xlsx'])
    expect(got.place).toBe(general.id)
    expect(got.trail).toEqual([{ name: 'General', at: general.root }])
    expect(got.entries.every((e) => e!.shared)).toBe(true)
    expect(got.entries[1]).toMatchObject({ key: 'lib:esportsstaffgeneral:Cloud only.pdf', local: false, state: { is: 'cloud' }, size: 200_000 })
    expect(got.entries[3]).toMatchObject({ key: 'lib:esportsstaffgeneral:Spring budget.xlsx', ref: at(join(rig.team, 'General', 'Spring budget.xlsx')) })
    // The same place by its id.
    expect(names(await call<FilesListing>('work.files.list', { at: { at: 'place', id: general.id } }))).toEqual(names(got))
    const deep = await call<FilesListing>('work.files.list', { at: at(join(rig.team, 'General', 'Budgets')) })
    expect(deep.entries[0]).toMatchObject({ key: 'lib:esportsstaffgeneral:Budgets/2026.xlsx' })
    expect(deep.trail!.map((c) => c.name)).toEqual(['General', 'Budgets'])
  })

  it('pages a big folder by its cursor, sorted as asked, and lists folders alone for the sidebar', async () => {
    const big = join(rig.folder, 'Big')
    mkdirSync(big)
    for (let i = 0; i < 620; i++) writeFileSync(join(big, `f${String(i).padStart(3, '0')}.txt`), 'x')
    const first = await call<FilesListing>('work.files.list', { at: at(big), sort: { by: 'name', dir: 'desc' } })
    expect(first.entries).toHaveLength(500)
    expect(first.entries[0]!.name).toBe('f619.txt')
    const rest = await call<FilesListing>('work.files.list', { at: at(big), sort: { by: 'name', dir: 'desc' }, cursor: first.next })
    expect(rest.entries).toHaveLength(120)
    expect(rest.next).toBeUndefined()
    // The trail comes with the first page only.
    expect(rest.trail).toBeUndefined()
    expect(names(await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' }, foldersOnly: true }))).toEqual(['Big', 'Events'])
  })

  it('pushes a folder a tab shows when a name in it changes, only to callers that could name it', async () => {
    await call<FilesListing>('work.files.list', { at: at(join(rig.folder, 'Events')) })
    writeFileSync(join(rig.folder, 'Events', 'New.txt'), 'x')
    await new Promise((r) => setTimeout(r, 400))
    const said = rig.pushes.filter(({ p }) => p.push === 'work.files')
    expect(said).toHaveLength(1)
    expect(said[0]!.p).toEqual({ push: 'work.files', workspaceId: WS, at: `file:${HOST}:${join(rig.folder, 'Events')}` })
    expect(said[0]!.to).toEqual({ need: 'read', path: join(rig.folder, 'Events') })
    expect(names(await call<FilesListing>('work.files.list', { at: at(join(rig.folder, 'Events')) }))).toContain('New.txt')
  })
})

describe('stat', () => {
  it('answers each row again, in order, null for one that is gone or out of reach', async () => {
    const got = await call<{ entries: (FileEntry | null)[] }>('work.files.stat', {
      refs: [at(join(rig.folder, 'Budget.xlsx')), at(join(rig.folder, 'gone.txt')), at(join(rig.team, 'General', 'Plan.docx')), at(join(rig.outside, 'secret.txt')), at(join(rig.folder, 'Events'))]
    })
    expect(names(got)).toEqual(['Budget.xlsx', '(none)', 'Plan.docx', '(none)', 'Events'])
    expect(got.entries[2]).toMatchObject({ shared: true, key: 'lib:esportsstaffgeneral:Plan.docx' })
    expect(got.entries[4]).toMatchObject({ kind: 'folder' })
  })
})

describe('tabs', () => {
  const page = (path: string, name: string) => ({ at: at(path), name })

  it('opens page tabs in order, moves one, stands one somewhere else, and counts every change in one revision', async () => {
    const a = await call<FilesTabs & { tabId: string }>('work.files.tabOpen', { page: { at: { at: 'place', id: 'folder' }, name: 'Dummy Esports' } })
    const b = await call<FilesTabs & { tabId: string }>('work.files.tabOpen', { page: page(join(rig.folder, 'Events'), 'Events') })
    const c = await call<FilesTabs & { tabId: string }>('work.files.tabOpen', { page: { at: { at: 'place', id: 'starred' }, name: 'Starred' }, after: a.tabId })
    expect(c.tabs.map((t) => t.name)).toEqual(['Dummy Esports', 'Starred', 'Events'])
    expect(c.rev).toBe(3)
    const moved = await call<FilesTabs>('work.files.tabMove', { tabId: b.tabId, before: a.tabId })
    expect(moved.tabs.map((t) => t.name)).toEqual(['Events', 'Dummy Esports', 'Starred'])
    const set = await call<FilesTabs>('work.files.tabSet', { tabId: b.tabId, page: page(join(rig.folder, 'Events', 'Spring LAN'), 'Spring LAN') })
    expect(set.tabs[0]).toMatchObject({ kind: 'page', name: 'Spring LAN', page: { at: at(join(rig.folder, 'Events', 'Spring LAN')) } })
    expect(set.rev).toBe(5)
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs.map((t) => t.id)).toEqual([b.tabId, a.tabId, c.tabId])
    // Each change was said once, with the revision it made.
    expect(rig.pushes.filter(({ p }) => p.push === 'work.files').map(({ p }) => (p as { tabs?: number }).tabs)).toEqual([1, 2, 3, 4, 5])
  })

  it('makes the first tab once for two windows that open an empty place together', async () => {
    const page = { at: { at: 'place', id: 'folder' }, name: 'Dummy Esports' }
    const a = await call<FilesTabs & { tabId: string }>('work.files.tabOpen', { page, first: true })
    const b = await call<FilesTabs & { tabId: string }>('work.files.tabOpen', { page, first: true })
    expect(b.tabId).toBe(a.tabId)
    expect(b.tabs).toHaveLength(1)
    expect(b.rev).toBe(1)
    // Without it a tab is a tab.
    expect((await call<FilesTabs>('work.files.tabOpen', { page })).tabs).toHaveLength(2)
  })

  it('opens a file in a tab of its own beside the tab it came from, with no thread, and never twice', async () => {
    const from = await call<FilesTabs & { tabId: string }>('work.files.tabOpen', { page: { at: { at: 'place', id: 'folder' }, name: 'Dummy Esports' } })
    await call('work.files.tabOpen', { page: { at: { at: 'place', id: 'starred' }, name: 'Starred' } })
    const opened = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'Budget.xlsx')), opener: from.tabId })
    expect(opened.item).toMatchObject({ sessionId: filesPaneOf(WS), kind: 'sheet', title: 'Budget.xlsx', source: at(join(rig.folder, 'Budget.xlsx')) })
    expect(opened.tabs.map((t) => [t.kind, t.name])).toEqual([['page', 'Dummy Esports'], ['file', 'Budget.xlsx'], ['page', 'Starred']])
    expect(opened.tabs[1]).toMatchObject({ id: opened.tabId, itemId: opened.item!.id, opener: from.tabId, key: `file:${HOST}:${join(rig.folder, 'Budget.xlsx')}` })
    const again = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'Budget.xlsx')) })
    expect(again.tabId).toBe(opened.tabId)
    expect(again.tabs).toHaveLength(3)
    expect(rig.canvas.list(filesPaneOf(WS))).toHaveLength(1)
    // He opened it: it is recent.
    expect(names(await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'recent' } }))).toEqual(['Budget.xlsx'])
  })

  it('opens each kind that has a viewer on the pane owner: a sheet, a PDF, a document, a picture, a text file', async () => {
    const kinds: Record<string, string> = {}
    for (const path of [join(rig.folder, 'Budget.xlsx'), join(rig.folder, 'Events', 'Spring LAN', 'Bracket.pdf'), join(rig.folder, 'Run of show.tcdoc'), join(rig.folder, 'Events', 'Poster.png'), join(rig.folder, 'notes.txt')]) {
      const { item } = await call<FilesOpened>('work.files.open', { ref: at(path) })
      kinds[item!.title] = item!.kind
      expect(item!.sessionId).toBe(filesPaneOf(WS))
    }
    expect(kinds).toEqual({ 'Budget.xlsx': 'sheet', 'Bracket.pdf': 'pdf', 'Run of show.tcdoc': 'document', 'Poster.png': 'media', 'notes.txt': 'file' })
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs).toHaveLength(5)
  })

  it("opens a library's Office file in the editor itself once that editor's build says it edits the form in place", async () => {
    const path = join(rig.team, 'General', 'Spring budget.xlsx')
    const off = registerFileMaker('sheet', { forms: ['tcsheet', 'xlsx'], blank: async () => undefined })
    try {
      const { item } = await call<FilesOpened>('work.files.open', { ref: at(path) })
      expect(item).toMatchObject({ kind: 'sheet', source: at(path) })
    } finally {
      off()
    }
    // A form no editor has taken keeps its app behind it.
    await call('work.files.tabClose', { tabId: (await call<FilesTabs>('work.files.tabs', {})).tabs[0]!.id })
    expect((await call<FilesOpened>('work.files.open', { ref: at(path) })).item).toMatchObject({ kind: 'sheet', source: { at: 'microsoft', app: 'excel' } })
  })

  it('opens a library Office file with its app behind it, and a file no viewer shows as the file kind: every file opens', async () => {
    const { item } = await call<FilesOpened>('work.files.open', { ref: at(join(rig.team, 'General', 'Spring budget.xlsx')) })
    expect(item).toMatchObject({ kind: 'sheet', source: { at: 'microsoft', app: 'excel', host: HOST, ref: { kind: 'path', path: join(rig.team, 'General', 'Spring budget.xlsx') } } })
    writeFileSync(join(rig.folder, 'bundle.zip'), 'zip')
    expect((await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'bundle.zip')) })).item).toMatchObject({ kind: 'file', source: at(join(rig.folder, 'bundle.zip')) })
    // Text in a library is the file it is, never an import beside it.
    writeFileSync(join(rig.team, 'General', 'Agenda.md'), 'team text')
    expect((await call<FilesOpened>('work.files.open', { ref: at(join(rig.team, 'General', 'Agenda.md')) })).item).toMatchObject({ kind: 'file', source: at(join(rig.team, 'General', 'Agenda.md')) })
    await expect(call('work.files.open', { ref: at(join(rig.folder, 'Events')) })).rejects.toThrow('That is a folder: it opens in its tab.')
    // Open as a document overrules the name.
    const as = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'notes.txt')), as: 'document' })
    expect(as.item!.kind).toBe('document')
  })

  it("closes a file tab and its item in one step; the last tab closed becomes the workspace's folder", async () => {
    const a = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'Budget.xlsx')) })
    const b = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'notes.txt')), opener: a.tabId })
    expect(b.tabs[1]!.opener).toBe(a.tabId)
    const closed = await call<FilesTabs>('work.files.tabClose', { tabId: a.tabId })
    expect(closed.tabs.map((t) => t.name)).toEqual(['notes.txt'])
    // The tab it opened returns to nothing now, not to a closed tab.
    expect(closed.tabs[0]!.opener).toBeUndefined()
    expect(rig.canvas.get(a.item!.id)).toBeNull()
    expect(rig.removed.at(-1)!.map((i) => i.id)).toEqual([a.item!.id])
    const last = await call<FilesTabs>('work.files.tabClose', { tabId: b.tabId })
    expect(last.tabs).toMatchObject([{ kind: 'page', name: 'Dummy Esports', page: { at: { at: 'place', id: 'folder' } } }])
    expect(rig.canvas.list(filesPaneOf(WS))).toEqual([])
    // Closing a tab another window already closed is nothing.
    expect((await call<FilesTabs>('work.files.tabClose', { tabId: a.tabId })).rev).toBe(last.rev)
  })

  it('refuses the 33rd file in one sentence and writes nothing: no tab, no item, no revision', async () => {
    for (let i = 0; i < 32; i++) {
      writeFileSync(join(rig.folder, `f${i}.pdf`), 'pdf')
      await call('work.files.open', { ref: at(join(rig.folder, `f${i}.pdf`)) })
    }
    const before = await call<FilesTabs>('work.files.tabs', {})
    writeFileSync(join(rig.folder, 'one more.pdf'), 'pdf')
    await expect(call('work.files.open', { ref: at(join(rig.folder, 'one more.pdf')) })).rejects.toThrow('32 files are open. Close one to open another.')
    expect(await call<FilesTabs>('work.files.tabs', {})).toEqual(before)
    expect(rig.canvas.list(filesPaneOf(WS))).toHaveLength(32)
  })

  it('follows an item that took another\'s place: the tab of a Word file shows the document made of it, and opening the file again selects it', async () => {
    writeFileSync(join(rig.folder, 'Plan.docx'), 'word')
    const word = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'Plan.docx')) })
    const doc = rig.canvas.replace(filesPaneOf(WS), word.item!.id, { kind: 'document', source: at(join(rig.folder, 'Plan.tcdoc')), title: 'Plan' })
    const tabs = await call<FilesTabs>('work.files.tabs', {})
    expect(tabs.tabs).toMatchObject([{ id: word.tabId, kind: 'file', name: 'Plan', itemId: doc.id }])
    expect((await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'Plan.docx')) })).tabId).toBe(word.tabId)
    expect(rig.canvas.list(filesPaneOf(WS)).map((i) => i.id)).toEqual([doc.id])
  })

  it("closes the tab when its item is closed from the pane's own menu", async () => {
    const a = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'Budget.xlsx')) })
    rig.canvas.close(a.item!.id)
    files.itemsRemoved!(rig.removed.at(-1)!, rig.ctx)
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs).toEqual([])
  })

  it('opens a deck, whose marks are kept by item, in the thread that already holds it, and makes no second seat', async () => {
    const deck = join(rig.folder, 'Events', 'Pitch.pptx')
    writeFileSync(deck, 'deck')
    const held = rig.canvas.open('t1', { kind: 'slides', source: at(deck), title: 'Pitch.pptx' })
    const got = await call<FilesOpened>('work.files.open', { ref: at(deck), as: 'slides' })
    expect(got.held).toEqual({ sessionId: 't1', itemId: held.id })
    expect(got.item).toBeUndefined()
    expect(got.tabs).toEqual([])
    // A sheet keeps its state by the file: it opens in a tab even while a thread holds it.
    rig.canvas.open('t1', { kind: 'sheet', source: at(join(rig.folder, 'Budget.xlsx')), title: 'Budget.xlsx' })
    expect((await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'Budget.xlsx')) })).item).toBeDefined()
  })

  it('opens a PDF or a video a thread holds in a tab of its own: the two share its marks by the file', async () => {
    const pdf = join(rig.folder, 'Events', 'Spring LAN', 'Bracket.pdf')
    rig.canvas.open('t1', { kind: 'pdf', source: at(pdf), title: 'Bracket.pdf' })
    const got = await call<FilesOpened>('work.files.open', { ref: at(pdf) })
    expect(got.held).toBeUndefined()
    expect(got.item).toMatchObject({ kind: 'pdf', sessionId: filesPaneOf(WS), source: at(pdf) })
    expect(got.tabs.map((t) => t.itemId)).toEqual([got.item!.id])
    const clip = join(rig.folder, 'Events', 'Recap.mp4')
    writeFileSync(clip, 'mp4')
    rig.canvas.open('t1', { kind: 'media', source: at(clip), title: 'Recap.mp4' })
    expect((await call<FilesOpened>('work.files.open', { ref: at(clip) })).item).toMatchObject({ kind: 'media', sessionId: filesPaneOf(WS) })
  })
})

describe('the Beside seat', () => {
  const budget = (): ReturnType<typeof at> => at(join(rig.folder, 'Budget.xlsx'))
  const notes = (): ReturnType<typeof at> => at(join(rig.folder, 'notes.txt'))

  it("shows a file in the window's one seat with no tab, and re-points it: the file it showed goes", async () => {
    await call('work.files.tabOpen', { page: { at: { at: 'place', id: 'folder' }, name: 'Dummy Esports' } })
    const first = await call<FilesOpened>('work.files.open', { ref: budget(), beside: 'w1' })
    expect(first.tabId).toBeUndefined()
    expect(first.item).toMatchObject({ sessionId: filesPaneOf(WS), kind: 'sheet', title: 'Budget.xlsx' })
    expect(first.tabs.map((t) => t.name)).toEqual(['Dummy Esports'])
    // The same file again is the same item; another file takes the seat and the first item goes.
    expect((await call<FilesOpened>('work.files.open', { ref: budget(), beside: 'w1' })).item!.id).toBe(first.item!.id)
    const second = await call<FilesOpened>('work.files.open', { ref: notes(), beside: 'w1' })
    expect(second.item!.title).toBe('notes.txt')
    expect(rig.canvas.list(filesPaneOf(WS)).map((i) => i.title)).toEqual(['notes.txt'])
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs.map((t) => t.name)).toEqual(['Dummy Esports'])
    // He opened them there: they are recent.
    expect(names(await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'recent' } })).sort()).toEqual(['Budget.xlsx', 'notes.txt'])
  })

  it('never seats a file twice: a tab that holds it is answered, two windows share one item, and a tab takes the seat\'s item', async () => {
    const tab = await call<FilesOpened>('work.files.open', { ref: budget() })
    const seated = await call<FilesOpened>('work.files.open', { ref: budget(), beside: 'w1' })
    expect([seated.tabId, seated.item!.id]).toEqual([tab.tabId, tab.item!.id])
    // Two windows on one file: one item, kept until the last seat lets go.
    const a = await call<FilesOpened>('work.files.open', { ref: notes(), beside: 'w1' })
    const b = await call<FilesOpened>('work.files.open', { ref: notes(), beside: 'w2' })
    expect(b.item!.id).toBe(a.item!.id)
    await call('work.files.tabClose', { tabId: seatId('w1') })
    expect(rig.canvas.get(a.item!.id)).not.toBeNull()
    // Return on it: the tab is made with the item the seat has, and the seat is gone.
    const opened = await call<FilesOpened>('work.files.open', { ref: notes() })
    expect(opened.item!.id).toBe(a.item!.id)
    expect(opened.tabs.map((t) => t.name)).toEqual(['Budget.xlsx', 'notes.txt'])
    expect(rig.db.prepare(`SELECT COUNT(*) AS n FROM work_files_tabs WHERE kind = 'seat'`).get()).toEqual({ n: 0 })
  })

  it('closes with its item, leaves the tabs alone, and is no tab to move or stand somewhere', async () => {
    const page = await call<FilesTabs & { tabId: string }>('work.files.tabOpen', { page: { at: { at: 'place', id: 'folder' }, name: 'Dummy Esports' } })
    await call<FilesOpened>('work.files.open', { ref: budget(), beside: 'w1' })
    await expect(call('work.files.tabMove', { tabId: seatId('w1'), before: page.tabId })).rejects.toThrow('That tab is closed.')
    const closed = await call<FilesTabs>('work.files.tabClose', { tabId: seatId('w1') })
    expect(closed.tabs.map((t) => t.id)).toEqual([page.tabId])
    expect(rig.canvas.list(filesPaneOf(WS))).toEqual([])
    // Closing it again is nothing.
    expect((await call<FilesTabs>('work.files.tabClose', { tabId: seatId('w1') })).tabs).toHaveLength(1)
  })

  it('keeps eight seats a workspace at most, lets go of a file that went to Trash, and none outlives a start of the host', async () => {
    for (let i = 0; i < SEATS_MOST + 2; i++) {
      writeFileSync(join(rig.folder, `seat-${i}.txt`), 'x')
      await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, `seat-${i}.txt`)), beside: `w${i}` })
    }
    expect(rig.canvas.list(filesPaneOf(WS))).toHaveLength(SEATS_MOST)
    await call('work.files.trash', { refs: [at(join(rig.folder, `seat-${SEATS_MOST + 1}.txt`))], op: 'op-seat-trash-0001' })
    expect(rig.canvas.list(filesPaneOf(WS))).toHaveLength(SEATS_MOST - 1)
    expect(filesState(rig.ctx).tabs.check()).toEqual({ tabs: 0, items: SEATS_MOST - 1 })
    expect(rig.canvas.list(filesPaneOf(WS))).toEqual([])
  })

  it('refuses a file of another host: its copy is a tab\'s', async () => {
    await expect(call('work.files.open', { ref: { at: 'file', host: 'env_1gP-MhkVVRaMwHbVCysYow', path: '/Users/landon/Team/Plan.docx' }, beside: 'w1' })).rejects.toThrow('A file on another computer opens in a tab of its own.')
  })
})

describe('two files in one tab', () => {
  const budget = (): ReturnType<typeof at> => at(join(rig.folder, 'Budget.xlsx'))
  const notes = (): ReturnType<typeof at> => at(join(rig.folder, 'notes.txt'))
  const poster = (): ReturnType<typeof at> => at(join(rig.folder, 'Events', 'Poster.png'))

  it("opens a file at the side of a file tab, in the same tab, and closes it alone", async () => {
    const main = await call<FilesOpened>('work.files.open', { ref: budget() })
    const side = await call<FilesOpened>('work.files.open', { ref: notes(), side: main.tabId })
    expect(side.tabId).toBe(main.tabId)
    expect(side.item).toMatchObject({ sessionId: filesPaneOf(WS), kind: 'file', title: 'notes.txt' })
    expect(side.tabs).toHaveLength(1)
    expect(side.tabs[0]).toMatchObject({ id: main.tabId, itemId: main.item!.id, name: 'Budget.xlsx', side: { itemId: side.item!.id, name: 'notes.txt', key: `file:${HOST}:${join(rig.folder, 'notes.txt')}` } })
    // He opened it: it is recent.
    expect(names(await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'recent' } })).sort()).toEqual(['Budget.xlsx', 'notes.txt'])
    const closed = await call<FilesTabs>('work.files.tabClose', { tabId: main.tabId, side: true })
    expect(closed.tabs[0]!.side).toBeUndefined()
    expect(rig.canvas.list(filesPaneOf(WS)).map((i) => i.title)).toEqual(['Budget.xlsx'])
    // Closing a side that is not there is nothing.
    expect((await call<FilesTabs>('work.files.tabClose', { tabId: main.tabId, side: true })).tabs).toHaveLength(1)
  })

  it('never shows a file twice: a tab of its own moves to the side with its item, opening it again answers the tab it is in, and another side takes its place', async () => {
    const main = await call<FilesOpened>('work.files.open', { ref: budget() })
    const own = await call<FilesOpened>('work.files.open', { ref: notes() })
    const moved = await call<FilesOpened>('work.files.open', { ref: notes(), side: main.tabId })
    expect(moved.item!.id).toBe(own.item!.id)
    expect(moved.tabs.map((t) => [t.name, t.side?.name ?? null])).toEqual([['Budget.xlsx', 'notes.txt']])
    // Opened again from a folder: the tab that shows it at its side is answered, and nothing is made.
    const again = await call<FilesOpened>('work.files.open', { ref: notes() })
    expect([again.tabId, again.item!.id, again.tabs.length]).toEqual([main.tabId, own.item!.id, 1])
    // The tab's own file is not put beside itself.
    expect((await call<FilesOpened>('work.files.open', { ref: budget(), side: main.tabId })).tabs[0]!.side!.name).toBe('notes.txt')
    // Another file takes the side: the one it showed goes.
    const next = await call<FilesOpened>('work.files.open', { ref: poster(), side: main.tabId })
    expect(next.tabs[0]!.side!.name).toBe('Poster.png')
    expect(rig.canvas.list(filesPaneOf(WS)).map((i) => i.title).sort()).toEqual(['Budget.xlsx', 'Poster.png'])
  })

  it('closes both with the tab, follows a rename, and lets go of a file that went to Trash or whose item was closed', async () => {
    const main = await call<FilesOpened>('work.files.open', { ref: budget() })
    const side = await call<FilesOpened>('work.files.open', { ref: notes(), side: main.tabId })
    await call('work.files.rename', { ref: notes(), name: 'minutes.txt', op: 'op-side-rename-0001' })
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs[0]!.side).toMatchObject({ itemId: side.item!.id, name: 'minutes.txt', key: `file:${HOST}:${join(rig.folder, 'minutes.txt')}` })
    await call('work.files.trash', { refs: [at(join(rig.folder, 'minutes.txt'))], op: 'op-side-trash-0001' })
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs.map((t) => [t.name, t.side ?? null])).toEqual([['Budget.xlsx', null]])
    // An item closed from the pane's own menu leaves its tab.
    const poster2 = await call<FilesOpened>('work.files.open', { ref: poster(), side: main.tabId })
    rig.canvas.remove([poster2.item!.id])
    files.itemsRemoved!([poster2.item!], rig.ctx)
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs.map((t) => [t.name, t.side ?? null])).toEqual([['Budget.xlsx', null]])
    // The tab closed: its side's item goes with it.
    await call<FilesOpened>('work.files.open', { ref: poster(), side: main.tabId })
    await call('work.files.tabClose', { tabId: main.tabId })
    expect(rig.canvas.list(filesPaneOf(WS))).toEqual([])
  })

  it("keeps a side's item through the boot check, refuses a page tab and a file of another host, and tells a key of no side it could not name", async () => {
    const main = await call<FilesOpened>('work.files.open', { ref: budget() })
    await call<FilesOpened>('work.files.open', { ref: notes(), side: main.tabId })
    expect(filesState(rig.ctx).tabs.check()).toEqual({ tabs: 0, items: 0 })
    expect(rig.canvas.list(filesPaneOf(WS))).toHaveLength(2)
    const page = await call<FilesTabs & { tabId: string }>('work.files.tabOpen', { page: { at: { at: 'place', id: 'folder' }, name: 'Dummy Esports' } })
    await expect(call('work.files.open', { ref: poster(), side: page.tabId })).rejects.toThrow('That tab is closed.')
    await expect(call('work.files.open', { ref: { at: 'file', host: 'env_1gP-MhkVVRaMwHbVCysYow', path: '/Users/landon/Team/Plan.docx' }, side: main.tabId })).rejects.toThrow('A file on another computer opens in a tab of its own.')
    // The phone's key reaches the workspace's folder: it is told of the side. A key with no reach there is told of neither.
    expect((await call<FilesTabs>('work.files.tabs', {}, phone)).tabs.find((t) => t.id === main.tabId)?.side?.name).toBe('notes.txt')
  })
})

describe('the boot check', () => {
  it('drops a tab whose item is gone and an item whose tab is gone', async () => {
    const a = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'Budget.xlsx')) })
    const b = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'notes.txt')) })
    await call('work.files.tabOpen', { page: { at: { at: 'place', id: 'folder' }, name: 'Dummy Esports' } })
    // A database restored half way: one tab lost its item, one item lost its tab.
    rig.db.prepare('DELETE FROM work_canvas_items WHERE id = ?').run(a.item!.id)
    rig.db.prepare('DELETE FROM work_files_tabs WHERE id = ?').run(b.tabId!)
    expect(filesState(rig.ctx).tabs.check()).toEqual({ tabs: 1, items: 1 })
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs.map((t) => t.name)).toEqual(['Dummy Esports'])
    expect(rig.canvas.list(filesPaneOf(WS))).toEqual([])
    expect(filesState(rig.ctx).tabs.check()).toEqual({ tabs: 0, items: 0 })
  })

  it('runs when the module starts, and the module stops what it watches', async () => {
    const a = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'Budget.xlsx')) })
    rig.db.prepare('DELETE FROM work_canvas_items WHERE id = ?').run(a.item!.id)
    const stop = files.start!(rig.ctx)
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs).toEqual([])
    stop()
  })
})

describe('marks', () => {
  it('stars a file and a folder, lists them by name, and takes a star back', async () => {
    expect(await call('work.files.star', { ref: at(join(rig.folder, 'notes.txt')), name: 'notes.txt', on: true })).toEqual({ starred: true })
    await call('work.files.star', { ref: at(join(rig.folder, 'Events')), name: 'Events', on: true })
    await call('work.files.star', { ref: at(join(rig.team, 'General', 'Plan.docx')), name: 'Plan.docx', on: true })
    const starred = await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'starred' } })
    expect(starred.entries.map((e) => [e.name, e.kind, e.starred, e.key])).toEqual([
      ['Events', 'folder', true, `file:${HOST}:${join(rig.folder, 'Events')}`],
      ['notes.txt', 'text', true, `file:${HOST}:${join(rig.folder, 'notes.txt')}`],
      ['Plan.docx', 'document', true, 'lib:esportsstaffgeneral:Plan.docx']
    ])
    expect(starred.entries[0]).toMatchObject({ ref: null, folder: at(join(rig.folder, 'Events')) })
    // A listed row says it is starred.
    const listed = await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } })
    expect(listed.entries.filter((e) => e.starred).map((e) => e.name)).toEqual(['Events', 'notes.txt'])
    await call('work.files.star', { ref: at(join(rig.folder, 'notes.txt')), name: 'notes.txt', on: false })
    expect(names(await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'starred' } }))).toEqual(['Events', 'Plan.docx'])
  })

  it('lists what he opened, newest first, once each', async () => {
    await call('work.files.seen', { ref: at(join(rig.folder, 'notes.txt')), name: 'notes.txt' })
    await new Promise((r) => setTimeout(r, 5))
    await call('work.files.seen', { ref: at(join(rig.folder, 'Budget.xlsx')), name: 'Budget.xlsx' })
    await new Promise((r) => setTimeout(r, 5))
    await call('work.files.seen', { ref: at(join(rig.folder, 'notes.txt')), name: 'notes.txt' })
    expect(names(await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'recent' } }))).toEqual(['notes.txt', 'Budget.xlsx'])
  })
})

describe('threads and fetch', () => {
  it('names the threads whose open items show a file, and none for a file nobody holds', async () => {
    const pdf = join(rig.folder, 'Events', 'Spring LAN', 'Bracket.pdf')
    const item: CanvasItem = rig.canvas.open('t1', { kind: 'pdf', source: at(pdf), title: 'Bracket.pdf' })
    expect(await call('work.files.threads', { ref: at(pdf) })).toEqual({ threads: [{ sessionId: 't1', itemId: item.id, source: at(pdf) }] })
    expect(await call('work.files.threads', { ref: at(join(rig.folder, 'notes.txt')) })).toEqual({ threads: [] })
    // A tab is never listed as a thread.
    await call('work.files.open', { ref: at(join(rig.folder, 'notes.txt')) })
    expect(await call('work.files.threads', { ref: at(join(rig.folder, 'notes.txt')) })).toEqual({ threads: [] })
  })

  it('downloads a file its place keeps in the cloud on its own host, and answers it as it is now', async () => {
    const got = await call<{ entry: FileEntry }>('work.files.fetch', { ref: at(join(rig.team, 'General', 'Cloud only.pdf')) })
    expect(got.entry).toMatchObject({ name: 'Cloud only.pdf', size: 200_000 })
    await expect(call('work.files.fetch', { ref: at(join(rig.outside, 'secret.txt')) })).rejects.toThrow("That is not in this workspace's folder or a library it may use.")
  })
})

describe('a deleted workspace', () => {
  it('drops its tabs, its marks and what Trash, the journal and Go to kept of it', async () => {
    await call('work.files.open', { ref: at(join(rig.folder, 'Budget.xlsx')) })
    await call('work.files.star', { ref: at(join(rig.folder, 'notes.txt')), name: 'notes.txt', on: true })
    rig.db.prepare(`INSERT INTO work_files_trash (id, workspace_id, ref, name, place, was_at, state, deleted_at, by) VALUES ('x', ?, '{}', 'a', 'folder', '{}', 'held', 1, 'owner')`).run(WS)
    rig.db.prepare(`INSERT INTO work_files_marks (workspace_id, ref_key, ref, name, starred) VALUES ('w2', 'k', '{"file":{"at":"thread"}}', 'other', 1)`).run()
    files.workspaceRemoved!(WS, rig.ctx)
    for (const table of ['work_files_tabs', 'work_files_revs', 'work_files_trash']) expect(rig.db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 })
    // Another workspace's rows stay.
    expect(rig.db.prepare(`SELECT count(*) AS n FROM work_files_marks`).get()).toEqual({ n: 1 })
    expect(existsSync(rig.folder)).toBe(true)
  })
})

describe('the journal at boot', () => {
  it('marks a change a dead process left running as failed, and drops rows past a week', async () => {
    const put = rig.db.prepare(`INSERT INTO work_files_ops (id, workspace_id, verb, refs, state, result, at) VALUES (?, ?, 'rename', '[]', ?, NULL, ?)`)
    put.run('left-running', WS, 'running', Date.now())
    put.run('old-done-row', WS, 'done', Date.now() - 8 * 24 * 60 * 60 * 1000)
    files.start!(rig.ctx)()
    expect(rig.db.prepare(`SELECT id, state FROM work_files_ops ORDER BY id`).all()).toEqual([{ id: 'left-running', state: 'failed' }])
  })
})
