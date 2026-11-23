import { mkdirSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilesHome, FilesListing, FilesPlaces, SavedFileSearch } from '@shared/contract-work-files'
import type { FileEntry } from '@shared/work/files'

/**
 * Search, Home and saved searches (search.ts) through the module, each request as the wire parses it. Every
 * way this process reads a file is watched, as reads.test.ts watches it: a search reads no byte of a file kept
 * in the cloud, of a library's file or of a file over the cap.
 */

const opened = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const note =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (typeof args[0] === 'string') opened.push(args[0])
      return fn(...args)
    }
  return { ...fs, openSync: note(fs.openSync), readFileSync: note(fs.readFileSync), createReadStream: note(fs.createReadStream) }
})
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const note =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (typeof args[0] === 'string') opened.push(args[0])
      return fn(...args)
    }
  return { ...fs, open: note(fs.open), readFile: note(fs.readFile) }
})

const { ClientRequestSchema } = await import('@shared/contract')
const { closeFilesState } = await import('./handle')
const { files } = await import('./index')
const { forgetSearches, passesFilter, searchCounts, setSearchCaps, walkNames } = await import('./search')
const { at, makeRig, peer, phone, thread, window, WS } = await import('./testkit')
const { ensureViewsTable, listViews, saveView } = await import('../docs/find')
const { setVmCall } = await import('../office/vm/link')
const { setVmState } = await import('../office/vm/office')
const { DEFAULT_SPEC, passes } = await import('@shared/work/docFind')
const { searchOfView } = await import('@shared/work/fileSearch')
type FindEntry = import('@shared/work/docFind').FindEntry
type FindFilter = import('@shared/work/docFind').FindFilter
type Caller = import('../modules').Caller

let rig: ReturnType<typeof makeRig>
beforeEach(() => {
  rig = makeRig()
  ensureViewsTable(rig.db)
  writeFileSync(join(rig.team, 'General', 'Budgets', 'Budget 2027.xlsx'), 'workbook')
  opened.length = 0
})
afterEach(() => {
  setSearchCaps(null)
  forgetSearches(rig.db)
  closeFilesState(rig.db)
  rig.close()
})

async function call<T>(method: string, params: Record<string, unknown>, by: Caller = window, signal?: AbortSignal): Promise<T> {
  const req = ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } })
  const out = await files.handle!(req, rig.ctx, by, signal)
  if (!out.handled) throw new Error(`${method} was not handled`)
  return out.result as T
}
const search = (query: string, o: { filter?: Record<string, unknown>; cursor?: string } = {}, by: Caller = window) => call<FilesListing>('work.files.search', { query, ...o }, by)
const names = (l: FilesListing): string[] => l.entries.map((e) => e.name).sort()
const settle = (): Promise<void> => new Promise((done) => setImmediate(() => setImmediate(done)))
const generalId = async (): Promise<string> => (await call<FilesPlaces>('work.files.places', {})).places.find((p) => p.name === 'General')!.id

describe('a search by name', () => {
  it('finds names in the folder and in a library, each once, saying where it lives', async () => {
    // The folder's names are already in the table: the walk finds them again, and each is one row.
    await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } })
    await settle()
    const got = await search('BUDGET')
    expect(names(got)).toEqual(['Budget 2027.xlsx', 'Budget.xlsx', 'Budgets', 'Spring budget.xlsx'])
    const id = await generalId()
    const by = (name: string): FileEntry => got.entries.find((e) => e.name === name)!
    expect(by('Budget.xlsx')).toMatchObject({ kind: 'sheet', ref: at(join(rig.folder, 'Budget.xlsx')), where: { place: 'folder', name: 'Dummy Esports', trail: [] } })
    expect(by('Budget.xlsx').shared).toBeUndefined()
    expect(by('Spring budget.xlsx')).toMatchObject({ shared: true, key: 'lib:esportsstaffgeneral:Spring budget.xlsx', where: { place: id, name: 'General', trail: [] } })
    expect(by('Budget 2027.xlsx').where).toEqual({ place: id, name: 'General', trail: ['Budgets'] })
    expect(by('Budgets')).toMatchObject({ kind: 'folder', ref: null, folder: at(join(rig.team, 'General', 'Budgets')) })
    expect(got.more).toBeUndefined()
  })

  it('finds a name deep in the folder with the folders down to it, and no hidden name or link', async () => {
    const got = await search('bracket')
    expect(got.entries).toMatchObject([{ name: 'Bracket.pdf', where: { place: 'folder', trail: ['Events', 'Spring LAN'] } }])
    expect(names(await search('secret'))).toEqual([])
  })

  it('lists newest change first', async () => {
    utimesSync(join(rig.folder, 'Budget.xlsx'), 5_000, 5_000)
    utimesSync(join(rig.team, 'General', 'Spring budget.xlsx'), 9_000, 9_000)
    const got = (await search('budget')).entries.map((e) => e.name)
    expect(got.slice(-2)).toEqual(['Spring budget.xlsx', 'Budget.xlsx'])
  })

  it('keeps what it found by name, for Go to', async () => {
    await search('poster')
    await settle()
    expect((await call<{ entries: FileEntry[] }>('work.files.names', { text: 'poster' })).entries.map((e) => e.name)).toEqual(['Poster.png'])
  })
})

describe('the filter', () => {
  beforeEach(() => {
    utimesSync(join(rig.folder, 'Budget.xlsx'), 1_000, 1_000)
    utimesSync(join(rig.team, 'General', 'Spring budget.xlsx'), 3_000, 3_000)
  })

  it('narrows by kind, by place, by time and by who else can open it', async () => {
    expect(names(await search('budget', { filter: { kinds: ['folder'] } }))).toEqual(['Budgets'])
    expect(names(await search('budget', { filter: { places: ['folder'] } }))).toEqual(['Budget.xlsx'])
    expect(names(await search('budget', { filter: { places: [await generalId()] } }))).toEqual(['Budget 2027.xlsx', 'Budgets', 'Spring budget.xlsx'])
    expect(names(await search('budget', { filter: { after: 2_000_000, before: 4_000_000 } }))).toEqual(['Spring budget.xlsx'])
    expect(names(await search('budget', { filter: { shared: false } }))).toEqual(['Budget.xlsx'])
    expect(names(await search('budget', { filter: { shared: true, kinds: ['sheet'] } }))).toEqual(['Budget 2027.xlsx', 'Spring budget.xlsx'])
  })

  it('takes no words with a filter: every PDF', async () => {
    expect(names(await search('', { filter: { kinds: ['pdf'] } }))).toEqual(['Bracket.pdf', 'Cloud only.pdf'])
  })

  it('matches who made it where the row says, and leaves out a row that cannot say', async () => {
    rig.db.prepare(`INSERT INTO work_files_marks (workspace_id, ref_key, ref, name, made_by, made_at) VALUES (?, ?, ?, ?, ?, ?)`).run(WS, `file:env_box:${join(rig.folder, 'notes.txt')}`, JSON.stringify({ file: at(join(rig.folder, 'notes.txt')) }), 'notes.txt', 's9', 1)
    expect((await search('', { filter: { who: 'agent' } })).entries.map((e) => [e.name, e.madeBy])).toEqual([['notes.txt', 's9']])
    expect(names(await search('', { filter: { who: 'Dana' } }))).toEqual([])
    const row = (o: Partial<FileEntry>): FileEntry => ({ key: 'k', ref: null, folder: null, name: 'x', kind: 'sheet', ...o })
    expect(passesFilter(row({ by: 'Dana Smith' }), 'folder', { who: 'dana' }, null)).toBe(true)
    expect(passesFilter(row({ by: 'Dana Smith' }), 'folder', { who: 'me' }, 'Dana Smith')).toBe(true)
    expect(passesFilter(row({ by: 'Dana Smith' }), 'folder', { who: 'me' }, 'Lee')).toBe(false)
    expect(passesFilter(row({ by: 'Dana', madeBy: 's1' }), 'folder', { who: 'Dana' }, null)).toBe(false)
    expect(passesFilter(row({}), 'folder', { who: 'me' }, 'Lee')).toBe(false)
  })

  it('matches only rows that carry suggestions or a project, and no file of a disk here does (LifeOS rows: places/lifeos.test.ts)', async () => {
    expect(names(await search('budget', { filter: { review: true } }))).toEqual([])
    expect(names(await search('budget', { filter: { project: 'p1' } }))).toEqual([])
    expect(names(await search('budget', { filter: { review: false } }))).toHaveLength(4)
  })
})

describe('pages', () => {
  beforeEach(() => {
    mkdirSync(join(rig.folder, 'Sheets'))
    for (let i = 0; i < 250; i++) {
      const path = join(rig.folder, 'Sheets', `Page ${String(i).padStart(3, '0')}.txt`)
      writeFileSync(path, 'x')
      // Some share a time: the key orders them.
      utimesSync(path, 10_000 + Math.floor(i / 3), 10_000 + Math.floor(i / 3))
    }
  })

  it('come a hundred at a time, newest first, no row twice, from one run', async () => {
    const runs = searchCounts.runs
    const first = await search('page')
    const second = await search('page', { cursor: first.next })
    const third = await search('page', { cursor: second.next })
    expect([first.entries.length, second.entries.length, third.entries.length]).toEqual([100, 100, 50])
    expect(third.next).toBeUndefined()
    const all = [...first.entries, ...second.entries, ...third.entries]
    expect(new Set(all.map((e) => e.key)).size).toBe(250)
    expect(all[0]!.name).toBe('Page 249.txt')
    expect(searchCounts.runs - runs).toBe(1)
  })

  it('stay in order when the kept search is gone, and say stale for a cursor of another search', async () => {
    const first = await search('page')
    // Times tie in threes: a page ends inside a tie, and the next goes on from its key.
    expect(first.entries.slice(-3).map((e) => e.name)).toEqual(['Page 150.txt', 'Page 151.txt', 'Page 152.txt'])
    const kept = await search('page', { cursor: first.next })
    forgetSearches(rig.db)
    const again = await search('page', { cursor: first.next })
    expect(again.entries.map((e) => e.key)).toEqual(kept.entries.map((e) => e.key))
    expect(again.entries[0]!.name).toBe('Page 147.txt')
    expect(await search('pages', { cursor: first.next })).toEqual({ entries: [], stale: true })
    expect(await search('page', { cursor: 'nonsense' })).toEqual({ entries: [], stale: true })
  })
})

describe('a search by words inside', () => {
  beforeEach(() => {
    writeFileSync(join(rig.folder, 'Agenda.md'), '# Day one\nKickoff with the captains')
    writeFileSync(join(rig.team, 'General', 'Team agenda.txt'), 'kickoff for the team')
    writeFileSync(join(rig.folder, 'Cloud notes.txt'), '')
    truncateSync(join(rig.folder, 'Cloud notes.txt'), 200_000)
    writeFileSync(join(rig.folder, 'Big.txt'), `${'x'.repeat(600 * 1024)} kickoff`)
    writeFileSync(join(rig.folder, 'Roster.csv'), 'name,role\nKai,kickoff lead')
    opened.length = 0
  })

  it('finds small text files of his own, and reads no file kept in the cloud, no library file and no big file', async () => {
    expect(names(await search('kickoff'))).toEqual(['Agenda.md', 'Roster.csv', 'notes.txt'])
    expect(opened.filter((p) => /Cloud |Big\.txt|Team agenda/.test(p))).toEqual([])
    expect(opened).toContain(join(rig.folder, 'Agenda.md'))
  })

  it('reads a text once while it is unchanged', async () => {
    await search('kickoff')
    forgetSearches(rig.db)
    opened.length = 0
    await search('kickoff captains')
    expect(opened.filter((p) => p.endsWith('Agenda.md'))).toEqual([])
  })
})

describe('caps and the signal', () => {
  it('says more when a walk stops at its cap', async () => {
    setSearchCaps({ hits: 1 })
    expect((await search('budget')).more).toBe(true)
    forgetSearches(rig.db)
    setSearchCaps({ hits: 2_000, dirs: 1 })
    const got = await search('bracket')
    expect(got.more).toBe(true)
    expect(got.entries).toEqual([])
  })

  it('stops a walk when its signal is cancelled, and answers nothing', async () => {
    for (let i = 0; i < 30; i++) mkdirSync(join(rig.folder, `Folder ${i}`))
    const before = searchCounts.folders
    const stop = new AbortController()
    const walking = walkNames(rig.folder, ['x'], { signal: stop.signal })
    stop.abort()
    await expect(walking).rejects.toThrow('cancelled')
    expect(searchCounts.folders - before).toBe(1)
    const gone = new AbortController()
    gone.abort()
    await expect(call('work.files.search', { query: 'budget' }, window, gone.signal)).rejects.toThrow('cancelled')
    // A search cancelled under another runs again for the next caller.
    expect(names(await search('budget'))).toHaveLength(4)
  })
})

describe('the fence', () => {
  it('gives a thread its own workspace and its libraries, and another workspace’s thread nothing', async () => {
    expect(names(await search('budget', {}, thread('t1')))).toHaveLength(4)
    await expect(search('budget', {}, thread('t2'))).rejects.toThrow("A thread reaches only its own workspace's files.")
    await expect(search('payroll', {}, thread('chat'))).rejects.toThrow("A thread reaches only its own workspace's files.")
    expect(names(await search('payroll'))).toEqual([])
  })

  it('gives another host of his the libraries alone', async () => {
    await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } })
    await settle()
    expect(names(await search('budget', {}, peer))).toEqual(['Budget 2027.xlsx', 'Budgets', 'Spring budget.xlsx'])
  })

  it('gives a remote key no library hit outside its roots', async () => {
    expect(names(await search('budget', {}, phone))).toEqual(['Budget.xlsx'])
    rig.roots.push(join(rig.team, 'Events'))
    forgetSearches(rig.db)
    expect(names(await search('budget', {}, phone))).toEqual(['Budget.xlsx'])
    expect(names(await search('deck', {}, phone))).toEqual(['Deck.pptx'])
    rig.roots.splice(0, rig.roots.length, join(rig.folder, 'Events'))
    expect(names(await search('', { filter: { kinds: ['pdf', 'picture'] } }, phone))).toEqual(['Bracket.pdf', 'Poster.png'])
  })
})

describe('the Windows VM', () => {
  const TOP = 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents'
  let calls: string[]
  beforeEach(() => {
    calls = []
    setVmState(() => ({ state: 'asleep', cannot: null }))
    rig.db.prepare(`INSERT INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(
      JSON.stringify({ at: 1_700_000_000_000, status: { onedrive: { installed: true, running: true, account: 'a@dummy.edu' }, mounts: [{ path: TOP, type: 'team', web: null }], office: { installed: true, version: null, apps: [], account: null, licensed: null } }, tops: { [TOP]: ['Events', 'General'] } })
    )
    setVmCall(async (verb) => {
      calls.push(verb)
      if (verb === 'files.search') return { hits: [{ name: 'VM budget.xlsx', path: `${TOP}\\General\\Plans\\VM budget.xlsx`, dir: false, size: 10, modified: 7_000, local: false, link: false, root: TOP }], more: false }
      throw new Error(`unexpected ${verb}`)
    })
  })
  afterEach(() => setVmCall(null))

  it('is not woken by a search from his window: its places are named as left out', async () => {
    if (process.platform === 'win32') return
    const got = await search('budget')
    expect(calls).toEqual([])
    expect(got.more).toBe(true)
    expect(got.asleep).toEqual(['Events', 'General'])
    expect(names(got)).toHaveLength(4)
  })

  it('is searched while awake, and by a thread its workspace lets use it, saying where each hit lives', async () => {
    if (process.platform === 'win32') return
    expect(names(await search('budget', {}, thread('t1')))).not.toContain('VM budget.xlsx')
    rig.settings.set(WS, { windowsVm: true })
    const got = await search('budget', {}, thread('t1'))
    expect(calls).toEqual(['files.search'])
    expect(got.entries.find((e) => e.name === 'VM budget.xlsx')).toMatchObject({ shared: true, local: false, key: 'lib:esportsstaffgeneral:Plans/VM budget.xlsx', where: { name: 'General', trail: ['Plans'] } })
    setVmState(() => ({ state: 'awake', cannot: null }))
    const awake = await search('budget')
    expect(awake.asleep).toBeUndefined()
    expect(names(awake)).toContain('VM budget.xlsx')
  })
})

describe('Home', () => {
  it('lists what he starred and opened, and nothing waiting yet', async () => {
    await call('work.files.star', { ref: at(join(rig.folder, 'Budget.xlsx')), name: 'Budget.xlsx', on: true })
    await call('work.files.seen', { ref: at(join(rig.folder, 'notes.txt')), name: 'notes.txt' })
    const got = await call<FilesHome>('work.files.home', {})
    expect(got.waiting).toEqual([])
    expect(got.starred.map((e) => e.name)).toEqual(['Budget.xlsx'])
    expect(got.recent.map((e) => e.name)).toEqual(['notes.txt'])
  })

  it('is no thread’s and no other host’s', async () => {
    await expect(call('work.files.home', {}, thread('t1'))).rejects.toThrow('A thread opens a file beside itself')
    await expect(call('work.files.home', {}, peer)).rejects.toThrow("Another host reaches only this host's libraries.")
  })
})

describe('saved searches', () => {
  it('are saved, listed and dropped as the Docs view’s saved views', async () => {
    const saved = await call<SavedFileSearch>('work.files.saveSearch', { name: 'PDFs', query: '', filter: { kinds: ['pdf'], after: 5 } })
    expect(saved).toMatchObject({ name: 'PDFs', query: '', filter: { kinds: ['pdf'], after: 5 } })
    expect(listViews(rig.db, WS)).toMatchObject([{ id: saved.id, name: 'PDFs', spec: { query: '', filter: { kinds: ['pdf'], after: 5 } } }])
    expect((await call<{ searches: SavedFileSearch[] }>('work.files.searches', {})).searches.map((s) => [s.id, s.name])).toEqual([[saved.id, 'PDFs']])
    await call('work.files.dropSearch', { id: saved.id })
    expect((await call<{ searches: SavedFileSearch[] }>('work.files.searches', {})).searches).toEqual([])
  })

  it('show a view Docs saved, and keep its own settings when saved again from Files', async () => {
    const view = saveView(rig.db, WS, { name: 'Decks this week', spec: { ...DEFAULT_SPEC, query: 'kickoff', filter: { kinds: ['slides'], within: 'week', where: ['lifeos'] }, group: 'kind', sort: 'name', layout: 'table' } })
    const [listed] = (await call<{ searches: SavedFileSearch[] }>('work.files.searches', {})).searches
    expect(listed).toMatchObject({ id: view.id, name: 'Decks this week', query: 'kickoff', filter: { kinds: ['deck'], places: ['lifeos'] } })
    await call('work.files.saveSearch', { id: view.id, name: 'Decks', query: 'kickoff', filter: listed!.filter })
    expect(listViews(rig.db, WS)).toEqual([{ ...view, name: 'Decks' }])
    await expect(call('work.files.saveSearch', { id: 'gone', name: 'x', query: '' })).rejects.toThrow('That saved search is gone.')
  })

  it('find, for a Docs view saved before Files, the same rows the view found: each field it maps, row by row', () => {
    const now = 1_800_000_000_000
    const DAY = 86_400_000
    // One row each, as the Docs view listed it and as Files lists it.
    const rows: { docs: FindEntry; files: FileEntry; place: string }[] = [
      { place: 'lifeos', docs: { key: 'lifeos:docs:d1', title: 'Run of show', kind: 'document', where: 'lifeos', source: { at: 'lifeos', table: 'docs', id: 'd1' }, projectId: 'p1', editedAt: now - DAY, createdAt: 0, shared: true, guest: false, lastBy: 'owner', comments: 0, waiting: 2, held: 0 }, files: { key: 'lifeos:docs:d1', ref: { at: 'lifeos', table: 'docs', id: 'd1' }, folder: null, name: 'Run of show', kind: 'document', changed: now - DAY, shared: true, state: { is: 'suggestions', count: 2 }, project: { id: 'p1', name: 'Spring LAN' }, by: 'You' } },
      { place: 'lifeos', docs: { key: 'lifeos:sheets:s1', title: 'Budget', kind: 'sheet', where: 'lifeos', source: { at: 'lifeos', table: 'sheets', id: 's1' }, editedAt: now - 40 * DAY, createdAt: 0, shared: false, guest: false, lastBy: 'agent', comments: 0, waiting: 0, held: 0 }, files: { key: 'lifeos:sheets:s1', ref: { at: 'lifeos', table: 'sheets', id: 's1' }, folder: null, name: 'Budget', kind: 'sheet', changed: now - 40 * DAY, by: 'An agent' } },
      { place: 'folder', docs: { key: 'file:/w/Bracket.pdf', title: 'Bracket.pdf', kind: 'pdf', where: 'folder', source: { at: 'file', host: 'env_box', path: '/w/Bracket.pdf' }, editedAt: now - 3 * DAY, createdAt: 0, shared: false, guest: false, comments: 0, waiting: 0, held: 0 }, files: { key: 'file:env_box:/w/Bracket.pdf', ref: { at: 'file', host: 'env_box', path: '/w/Bracket.pdf' }, folder: null, name: 'Bracket.pdf', kind: 'pdf', changed: now - 3 * DAY } }
    ]
    const filters: FindFilter[] = [{}, { kinds: ['document', 'pdf'] }, { kinds: ['sheet'] }, { within: 'week' }, { within: 'quarter' }, { shared: true }, { projects: ['p1'] }, { review: true }, { where: ['lifeos'] }, { where: ['folder'] }, { by: ['owner'] }, { by: ['agent'] }, { after: now - 5 * DAY, before: now }, { kinds: ['document'], within: 'week', where: ['lifeos'], review: true }]
    for (const filter of filters) {
      const search = searchOfView({ id: 'v', name: 'A view', spec: { ...DEFAULT_SPEC, filter } })
      const docs = rows.filter((r) => passes(r.docs, filter, now)).map((r) => r.docs.title)
      const files = rows.filter((r) => passesFilter(r.files, r.place, search.filter ?? {}, null, now)).map((r) => r.files.name)
      expect(files, JSON.stringify(filter)).toEqual(docs)
    }
  })

  it('are no thread’s and no other host’s', async () => {
    await expect(call('work.files.searches', {}, thread('t1'))).rejects.toThrow('A thread opens a file beside itself')
    await expect(call('work.files.saveSearch', { name: 'x', query: '' }, peer)).rejects.toThrow("Another host reaches only this host's libraries.")
  })
})
