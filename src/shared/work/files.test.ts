import { describe, expect, it } from 'vitest'
import { CANVAS_KINDS, ContextChipSchema } from './canvas'
import {
  audienceOf,
  canDo,
  chipsOf,
  FILE_CHIPS_MOST,
  fileChipOf,
  NO_FOLDER_CHIPS,
  TOO_MANY_FILES,
  compareEntries,
  compareNames,
  COPY_ACROSS_MAX,
  dateGroupOf,
  ENTRY_KINDS,
  extOf,
  extsOfCanvas,
  extsOfKind,
  FILE_VERBS,
  freeName,
  groupEntries,
  isHome,
  kindOfEntry,
  nameProblem,
  placeKey,
  questionFor,
  refKey,
  refusal,
  seatOf,
  SEATS_FULL,
  threadCanvasOf,
  sortEntries,
  splitName,
  type FileEntry,
  type FilePlace,
  type FileVerb
} from './files'

/** The Files place's grammar (files.ts): the kind table, keys, names, order, and the verbs table with each refusal's sentence. */

const ALL: FileVerb[] = [...FILE_VERBS]
const place = (over: Partial<FilePlace> & Pick<FilePlace, 'id' | 'kind'>): FilePlace => ({ name: over.id, host: 'The box', env: 'env_box', shared: false, can: ALL, state: { state: 'ok' }, root: { at: 'place', id: over.id }, ...over })
const FOLDER = place({ id: 'folder', kind: 'folder', name: 'Purdue Esports' })
const LIFEOS = place({ id: 'lifeos', kind: 'lifeos', name: 'LifeOS', host: '', can: ['make', 'rename', 'move'] })
const TEAMS = place({ id: 'mac~1', kind: 'teams', name: 'Esports Staff', host: 'MacBook', env: 'env_mac', shared: true, can: ['make', 'upload', 'rename', 'move', 'copy'], group: 'Esports Staff' })
const ONEDRIVE = place({ id: 'mac~2', kind: 'onedrive', name: 'My OneDrive', host: 'MacBook', env: 'env_mac', shared: true, can: ['make', 'upload', 'rename', 'move', 'copy'] })
const DRIVE = place({ id: 'drive:a@b.c', kind: 'drive', name: 'a@b.c', host: '', can: ['make', 'rename', 'move', 'trash', 'restore'] })
const VM = place({ id: 'box~vm', kind: 'teams', name: 'RecWell', host: 'Windows VM', shared: true, can: [], vm: true })
const MAIL = place({ id: 'mail', kind: 'mail', name: 'From mail', can: [] })
const TRASH = place({ id: 'trash', kind: 'trash', name: 'Trash', can: ['restore', 'purge'] })
const FILE: Pick<FileEntry, 'name' | 'kind' | 'size' | 'state' | 'shared'> = { name: 'Spring budget.xlsx', kind: 'sheet', size: 1200 }

describe('the one kind table', () => {
  it('reads the name first, and the type only for a name with no extension', () => {
    expect(kindOfEntry('Q3 Budget.XLSX', 'application/octet-stream')).toEqual({ kind: 'sheet', canvas: 'sheet' })
    expect(kindOfEntry('export.csv', 'application/vnd.ms-excel')).toEqual({ kind: 'sheet', canvas: 'sheet' })
    expect(kindOfEntry('main.ts', 'video/mp2t')).toEqual({ kind: 'text', canvas: 'file' })
    expect(kindOfEntry('scan', 'application/pdf')).toEqual({ kind: 'pdf', canvas: 'pdf' })
    expect(kindOfEntry('IMG_0042', 'image/heic')).toEqual({ kind: 'picture', canvas: 'media' })
    expect(kindOfEntry('clip', 'video/quicktime')).toEqual({ kind: 'video', canvas: 'media' })
    expect(kindOfEntry('call.m4a')).toEqual({ kind: 'audio', canvas: 'meeting' })
    expect(kindOfEntry('archive.zip', 'application/zip')).toEqual({ kind: 'archive', canvas: 'file' })
    expect(kindOfEntry('notes', 'text/plain')).toEqual({ kind: 'text', canvas: 'file' })
    expect(kindOfEntry('Makefile')).toEqual({ kind: 'other', canvas: null })
    expect(kindOfEntry('thing.xyz')).toEqual({ kind: 'other', canvas: null })
    expect(kindOfEntry('', 'application/vnd.google-apps.spreadsheet')).toEqual({ kind: 'sheet', canvas: 'sheet' })
    expect(kindOfEntry('', 'application/vnd.google-apps.folder')).toEqual({ kind: 'folder', canvas: null })
  })

  it('gives text and archives to the file kind, and seats in a tab what has no viewer of its own', () => {
    for (const name of ['README.md', 'notes.txt', 'plan.markdown', 'main.ts', 'data.json']) expect(kindOfEntry(name)).toEqual({ kind: 'text', canvas: 'file' })
    // Every file opens in a Files tab: its kind's viewer, else the file kind.
    expect(['Budget.xlsx', 'scan.pdf', 'README.md', 'bundle.zip', 'old.xls', 'logo.svg', 'Makefile', 'thing.xyz'].map((n) => seatOf(n))).toEqual(['sheet', 'pdf', 'file', 'file', 'file', 'file', 'file', 'file'])
    // Beside a thread only what it always opened: text he writes as a document, and nothing else the file kind shows.
    expect(['README.md', 'notes.txt', 'plan.markdown', 'main.ts', 'bundle.zip', 'Makefile', 'Budget.xlsx', 'old.xls'].map((n) => threadCanvasOf(n))).toEqual(['document', 'document', 'document', null, null, null, 'sheet', null])
    expect(threadCanvasOf('notes', 'text/plain')).toBeNull()
    for (const name of ['old.xls', 'macro.xlsb', 'form.docm']) expect(kindOfEntry(name).canvas).toBeNull()
    expect(kindOfEntry('old.xls').kind).toBe('sheet')
    for (const ext of ['ppt', 'pps', 'ppsx', 'odp', 'key']) expect(kindOfEntry(`Talk.${ext.toUpperCase()}`)).toEqual({ kind: 'deck', canvas: 'slides' })
  })

  it('reads a hidden file as a name with no extension', () => {
    expect(extOf('.gitignore')).toBe('')
    expect(extOf('C:\\Users\\tcuser\\OneDrive\\Budget.final.XLSX')).toBe('xlsx')
    expect(extOf('/a.b/c')).toBe('')
  })

  it('answers only kinds that exist, and lists a kind\'s extensions', () => {
    for (const kind of ENTRY_KINDS) for (const ext of extsOfKind(kind)) expect(kindOfEntry(`f.${ext}`).kind).toBe(kind)
    for (const canvas of CANVAS_KINDS) for (const ext of extsOfCanvas(canvas)) expect(kindOfEntry(`f.${ext}`).canvas).toBe(canvas)
    expect(extsOfKind('pdf')).toEqual(['pdf'])
    expect(extsOfCanvas('slides')).toEqual(['pptx', 'ppt', 'pps', 'ppsx', 'odp', 'key'])
  })
})

describe('refKey', () => {
  it('keys a library file by its place and inner path, so two computers answer one key', () => {
    const key = placeKey('Purdue Esports', 'General')
    const mac = refKey({ at: 'file', host: 'env_mac', path: '/Users/l/Library/CloudStorage/OneDrive-SharedLibraries-P/Purdue Esports - Documents/General/Budgets/2026.xlsx' }, { key, path: '/Users/l/Library/CloudStorage/OneDrive-SharedLibraries-P/Purdue Esports - Documents/General' })
    const vm = refKey({ at: 'microsoft', host: 'env_box', app: 'excel', name: '2026.xlsx', ref: { kind: 'path', path: 'C:\\Users\\tcuser\\Purdue\\Purdue Esports - Documents\\General\\Budgets\\2026.xlsx' } }, { key, path: 'C:\\Users\\tcuser\\Purdue\\Purdue Esports - Documents\\General' })
    expect(mac).toBe('lib:purdueesportsgeneral:Budgets/2026.xlsx')
    expect(vm).toBe(mac)
  })

  it('reads the two OneDrive layouts as one place', () => {
    expect(placeKey('RecWell-TeamRecWell')).toBe(placeKey('RecWell', 'Team RecWell'))
    expect(placeKey('Purdue Esports', 'Documents')).toBe(placeKey('Purdue Esports'))
    expect(placeKey('Purdue Esports', 'Shared Documents')).toBe('purdueesports')
  })

  it('keys every other source by what names it', () => {
    expect(refKey({ at: 'file', host: 'env_box', path: '/w/a.pdf' })).toBe('file:env_box:/w/a.pdf')
    expect(refKey({ at: 'lifeos', table: 'docs', id: 'd1' })).toBe('lifeos:docs:d1')
    expect(refKey({ at: 'google', account: 'a@b.c', fileId: 'F1', mime: 'x' })).toBe('google:F1')
    expect(refKey({ at: 'drive', account: 'a@b.c', folderId: 'F2' })).toBe('google:F2')
    // Drive's `root` is every account's word for its top: the top is keyed by its account.
    expect(refKey({ at: 'drive', account: 'A@b.c', folderId: 'root' })).toBe('google:root:a@b.c')
    expect(refKey({ at: 'drive', account: 'x@y.z', folderId: 'root' })).not.toBe(refKey({ at: 'drive', account: 'a@b.c', folderId: 'root' }))
    expect(refKey({ at: 'mail', threadId: 't', messageId: 'm', partId: 'p', name: 'a.pdf' })).toBe('mail:m:p')
    expect(refKey({ at: 'microsoft', host: 'h', app: 'word', name: 'a', ref: { kind: 'url', url: 'https://x/y' } })).toBe('web:https://x/y')
    expect(refKey({ at: 'project', id: 'p1' })).toBe('project:p1')
    expect(refKey({ at: 'place', id: 'trash' })).toBe('place:trash')
    expect(refKey({ at: 'thread' })).toBe('thread')
  })
})

describe('names', () => {
  it('takes one path component and nothing a computer of his refuses', () => {
    for (const ok of ['Budget 2026.xlsx', 'Résumé (final).docx', '.env', 'a']) expect(nameProblem(ok), ok).toBeNull()
    for (const bad of ['', '   ', '.', '..', 'a/b', 'a\\b', 'a:b', 'what?', 'x*', '"q"', '<a>', 'a|b', 'line\nbreak', 'nul\u0000', 'trailing.', 'trailing ', ' leading', 'CON', 'con.txt', 'LPT1', 'aux.tar.gz', 'x'.repeat(201)])
      expect(nameProblem(bad), JSON.stringify(bad)).not.toBeNull()
    expect(nameProblem('a/b')).toBe('A name cannot hold /')
  })

  it('splits a name at its last dot, never at a leading one', () => {
    expect(splitName('Budget.final.xlsx')).toEqual({ stem: 'Budget.final', ext: '.xlsx' })
    expect(splitName('Events')).toEqual({ stem: 'Events', ext: '' })
    expect(splitName('.env')).toEqual({ stem: '.env', ext: '' })
  })

  it('finds a free name: the name, then 2, 3 before the extension', () => {
    const taken = new Set(['Untitled document.docx', 'Untitled document 2.docx'])
    expect(freeName('Untitled sheet.xlsx', (n) => taken.has(n))).toBe('Untitled sheet.xlsx')
    expect(freeName('Untitled document.docx', (n) => taken.has(n))).toBe('Untitled document 3.docx')
    expect(freeName('Events', (n) => n === 'Events')).toBe('Events 2')
  })

  it('names a file put back beside one of its name "(restored)"', () => {
    const taken = new Set(['Plan.docx'])
    expect(freeName('Plan.docx', (n) => taken.has(n), ' (restored)')).toBe('Plan (restored).docx')
    taken.add('Plan (restored).docx')
    expect(freeName('Plan.docx', (n) => taken.has(n), ' (restored)')).toBe('Plan (restored) 2.docx')
    expect(freeName('Free.docx', (n) => taken.has(n), ' (restored)')).toBe('Free.docx')
  })
})

describe('order', () => {
  const e = (name: string, over: Partial<FileEntry> = {}) => ({ name, kind: 'document' as const, changed: 0, size: 0, ...over })
  it('orders names as a finder does: case-blind, numbers by value, and never calls two different names equal', () => {
    expect(['Budget 10', 'budget 2', 'Agenda', 'Budget 1'].sort(compareNames)).toEqual(['Agenda', 'Budget 1', 'budget 2', 'Budget 10'])
    expect(compareNames('a', 'A')).not.toBe(0)
    expect(compareNames('a', 'a')).toBe(0)
  })

  it('puts folders first whichever way the sort runs, then sorts, then breaks a tie by name', () => {
    const rows = [e('b.docx', { changed: 5, size: 10 }), e('Zeta', { kind: 'folder' }), e('a.docx', { changed: 9, size: 10 }), e('Alpha', { kind: 'folder' })]
    expect(sortEntries(rows).map((r) => r.name)).toEqual(['Alpha', 'Zeta', 'a.docx', 'b.docx'])
    expect(sortEntries(rows, { by: 'name', dir: 'desc' }).map((r) => r.name)).toEqual(['Zeta', 'Alpha', 'b.docx', 'a.docx'])
    expect(sortEntries(rows, { by: 'changed', dir: 'desc' }).map((r) => r.name)).toEqual(['Alpha', 'Zeta', 'a.docx', 'b.docx'])
    expect(sortEntries(rows, { by: 'size', dir: 'desc' }).map((r) => r.name)).toEqual(['Alpha', 'Zeta', 'a.docx', 'b.docx'])
    expect(sortEntries([e('b.pdf', { kind: 'pdf' }), e('a.xlsx', { kind: 'sheet' }), e('c.docx')], { by: 'kind', dir: 'asc' }).map((r) => r.name)).toEqual(['c.docx', 'b.pdf', 'a.xlsx'])
  })

  it('is a total order: two rows compare equal only when they are the same name', () => {
    expect(compareEntries(e('a', { changed: 1 }), e('b', { changed: 1 }), { by: 'changed', dir: 'desc' })).toBeLessThan(0)
    expect(compareEntries(e('a'), e('a'))).toBe(0)
  })

  it('groups by kind in the kinds\' order, by date newest first, by project with none last', () => {
    const now = new Date(2026, 10, 23, 15, 0).getTime()
    const day = 24 * 60 * 60 * 1000
    const rows = [e('old.pdf', { kind: 'pdf', changed: now - 90 * day }), e('today.docx', { changed: now - 60_000, project: { id: 'p', name: 'Spring LAN' } }), e('week.xlsx', { kind: 'sheet', changed: now - 3 * day }), e('none.txt', { kind: 'text' })]
    expect(groupEntries(rows, 'none')).toEqual([{ label: '', entries: rows }])
    expect(groupEntries(rows, 'kind').map((g) => [g.label, g.entries.map((r) => r.name)])).toEqual([['Document', ['today.docx']], ['Sheet', ['week.xlsx']], ['PDF', ['old.pdf']], ['Text', ['none.txt']]])
    expect(groupEntries(rows, 'date', now).map((g) => g.label)).toEqual(['Today', 'Previous 7 days', 'Earlier'])
    expect(groupEntries(rows, 'project').map((g) => g.label)).toEqual(['Spring LAN', 'No project'])
    expect(dateGroupOf(now - day, now)).toBe('Yesterday')
    expect(dateGroupOf(now - 20 * day, now)).toBe('Previous 30 days')
    expect(dateGroupOf(undefined, now)).toBe('Earlier')
  })
})

describe('the verbs table', () => {
  it('does every verb at once in the workspace\'s own folder', () => {
    for (const verb of ALL) expect(refusal(FOLDER, verb, FILE), verb).toBeNull()
    expect(questionFor(FOLDER, 'trash', FILE)).toBeNull()
    expect(questionFor(FOLDER, 'copy', FILE, FOLDER)).toBeNull()
  })

  it('renames and moves within a shared place at once: it is his own hand', () => {
    for (const verb of ['rename', 'move', 'make', 'upload'] as const) expect(refusal(TEAMS, verb, FILE), verb).toBeNull()
    expect(refusal(TEAMS, 'move', FILE, TEAMS)).toBeNull()
    expect(questionFor(TEAMS, 'rename', FILE)).toBeNull()
    expect(questionFor(TEAMS, 'move', FILE, TEAMS)).toBeNull()
  })

  it('asks once before a copy or a move lands where others can open it', () => {
    expect(refusal(FOLDER, 'copy', FILE, TEAMS)).toBeNull()
    expect(questionFor(FOLDER, 'copy', FILE, TEAMS)).toBe('Copy to Esports Staff? Everyone in that team can open it.')
    expect(questionFor(FOLDER, 'move', FILE, TEAMS)).toBe('Move to Esports Staff? Everyone in that team can open it.')
    expect(questionFor(FOLDER, 'copy', FILE, ONEDRIVE)).toBe('Copy to My OneDrive? Whoever you shared that folder with can open it.')
    expect(audienceOf(DRIVE)).toBe('Whoever that folder is shared with can open it.')
  })

  it('refuses a copy or a move out of Teams and OneDrive in one sentence, with Open it here', () => {
    for (const verb of ['copy', 'move'] as const) {
      expect(refusal(TEAMS, verb, FILE, FOLDER)).toEqual({ text: 'Teams files stay in Teams.', press: 'open-here' })
      expect(refusal(ONEDRIVE, verb, FILE, FOLDER)).toEqual({ text: 'OneDrive files stay in OneDrive.', press: 'open-here' })
      expect(refusal(TEAMS, verb, FILE, ONEDRIVE)).toEqual({ text: 'Teams files stay in Teams.', press: 'open-here' })
    }
  })

  it('refuses a delete where others see it until the provider\'s bin is proven, then asks first', () => {
    expect(refusal(TEAMS, 'trash', FILE)).toEqual({ text: 'Delete it in Teams.', press: 'open-web' })
    expect(refusal(ONEDRIVE, 'trash', FILE)).toEqual({ text: 'Delete it in OneDrive.', press: 'open-web' })
    const proven = { ...TEAMS, can: [...TEAMS.can, 'trash' as const] }
    expect(refusal(proven, 'trash', FILE)).toBeNull()
    expect(questionFor(proven, 'trash', FILE)).toBe('Delete for everyone?')
    // A Drive file others can open is a shared file in a place that is otherwise his own.
    expect(questionFor(DRIVE, 'trash', { ...FILE, shared: true })).toBe('Delete for everyone?')
    expect(questionFor(DRIVE, 'trash', FILE)).toBeNull()
  })

  it('moves across his own places as a copy, and only where the source can go to Trash', () => {
    const other = place({ id: 'mac~folder', kind: 'folder', name: 'Old workspace', env: 'env_mac', host: 'MacBook' })
    expect(refusal(FOLDER, 'move', FILE, other)).toBeNull()
    expect(refusal({ ...FOLDER, can: ['make', 'copy'] }, 'move', FILE, other)).toEqual({ text: 'Nothing can be moved in Purdue Esports from here.' })
    expect(refusal(FOLDER, 'copy', FILE, { ...other, can: [] })).toEqual({ text: 'Nothing can be copied in Old workspace from here.' })
  })

  it('keeps a LifeOS document in LifeOS, and lets nothing else in', () => {
    expect(refusal(LIFEOS, 'move', FILE, FOLDER)).toEqual({ text: 'A LifeOS document lives in LifeOS. Export a copy instead.', press: 'export' })
    expect(refusal(LIFEOS, 'copy', FILE, FOLDER)).toEqual({ text: 'A LifeOS document lives in LifeOS. Export a copy instead.', press: 'export' })
    expect(refusal(FOLDER, 'copy', FILE, LIFEOS)).toEqual({ text: 'Only a LifeOS document lives in LifeOS. Make one there instead.' })
    expect(refusal(LIFEOS, 'move', FILE, LIFEOS)).toBeNull()
    expect(refusal(LIFEOS, 'rename', FILE)).toBeNull()
  })

  it('refuses a LifeOS delete until LifeOS can put a document back', () => {
    expect(refusal(LIFEOS, 'trash', FILE)).toEqual({ text: 'LifeOS cannot put a document back yet. Delete it in LifeOS.' })
    expect(refusal({ ...LIFEOS, can: [...LIFEOS.can, 'trash', 'restore'] }, 'trash', FILE)).toBeNull()
  })

  it('keeps a Google file in Google Drive', () => {
    expect(refusal(DRIVE, 'copy', FILE, FOLDER)).toEqual({ text: 'A Google file lives in Google Drive. Export a copy instead.', press: 'export' })
    expect(refusal(FOLDER, 'move', FILE, DRIVE)).toEqual({ text: 'A Google file lives in Google Drive. Export a copy instead.', press: 'export' })
    expect(refusal(DRIVE, 'trash', FILE)).toBeNull()
    expect(refusal(DRIVE, 'rename', FILE)).toBeNull()
  })

  it('refuses a file over 48 MB from another computer, and copies one of any size on the same computer', () => {
    const big = { ...FILE, size: COPY_ACROSS_MAX + 1 }
    const mac = place({ id: 'mac~f', kind: 'folder', name: 'Scratch', host: 'MacBook', env: 'env_mac' })
    expect(refusal(mac, 'copy', big, FOLDER)).toEqual({ text: 'This file is over 48 MB, too big to copy from MacBook.' })
    expect(refusal(mac, 'copy', { ...FILE, size: COPY_ACROSS_MAX }, FOLDER)).toBeNull()
    expect(refusal(FOLDER, 'copy', big, place({ id: 'other', kind: 'folder', name: 'Other' }))).toBeNull()
  })

  it('takes no change in a place whose computer is out of reach, at either end', () => {
    const gone = { ...TEAMS, state: { state: 'unreachable' as const } }
    for (const verb of ALL) expect(refusal(gone, verb, FILE), verb).toEqual({ text: 'MacBook is out of reach.', press: 'retry' })
    expect(refusal(FOLDER, 'copy', FILE, gone)).toEqual({ text: 'MacBook is out of reach.', press: 'retry' })
    expect(refusal({ ...LIFEOS, state: { state: 'unreachable' } }, 'rename', FILE)).toEqual({ text: 'LifeOS is out of reach.', press: 'retry' })
  })

  it('never renames, moves or deletes a file a thread is writing in', () => {
    const busy = { ...FILE, state: { is: 'writing' as const } }
    for (const verb of ['rename', 'move', 'trash'] as const) expect(refusal(FOLDER, verb, busy), verb).toEqual({ text: 'A thread is writing in this file. Try when it is done.' })
    expect(refusal(FOLDER, 'copy', busy, FOLDER)).toBeNull()
  })

  it('reads a mail\'s file only: Keep copies it to the workspace\'s folder, and every other verb says so', () => {
    expect(refusal(MAIL, 'copy', FILE, FOLDER)).toBeNull()
    for (const verb of ['rename', 'move', 'trash', 'make', 'upload'] as const) expect(refusal(MAIL, verb, FILE), verb).toEqual({ text: "A mail's file is read only. Keep it first.", press: 'keep' })
    expect(refusal(MAIL, 'copy', FILE, TEAMS)).toEqual({ text: "A mail's file is read only. Keep it first.", press: 'keep' })
  })

  it('changes nothing through a lens: a file is changed where it lives', () => {
    expect(refusal(TRASH, 'rename', FILE)).toEqual({ text: 'Trash only shows files. Change one where it lives.' })
    expect(refusal(FOLDER, 'move', FILE, TRASH)).toEqual({ text: 'Trash only shows files. Pick a folder to put it in.' })
    expect(isHome('trash')).toBe(false)
    expect(isHome('teams')).toBe(true)
  })

  it('says a place in the Windows VM cannot be changed from here yet while its helper changes nothing', () => {
    expect(refusal(VM, 'rename', FILE)).toEqual({ text: 'Files in the Windows VM cannot be changed from here yet. Open it there.', press: 'open-here' })
    expect(refusal(FOLDER, 'copy', FILE, VM)).toEqual({ text: 'Files in the Windows VM cannot be changed from here yet. Open it there.', press: 'open-here' })
  })

  it('lets a VM place do what its helper has, and says plainly what it does not', () => {
    const vm = { ...VM, can: ['make', 'rename', 'move', 'edit'] as FilePlace['can'] }
    expect(refusal(vm, 'rename', FILE)).toBeNull()
    expect(refusal(vm, 'move', FILE, vm)).toBeNull()
    expect(refusal(vm, 'edit', FILE)).toBeNull()
    expect(refusal(vm, 'copy', FILE, vm)).toEqual({ text: 'Nothing can be copied in RecWell from here.' })
    // A delete there waits for its bin, as in any place others can open; a move out of it is a team's file leaving.
    expect(refusal(vm, 'trash', FILE)).toEqual({ text: 'Delete it in Teams.', press: 'open-web' })
    expect(refusal({ ...vm, can: [...vm.can, 'trash'] }, 'trash', FILE)).toBeNull()
    expect(refusal(vm, 'move', FILE, FOLDER)).toEqual({ text: 'Teams files stay in Teams.', press: 'open-here' })
    expect(questionFor({ ...vm, can: [...vm.can, 'trash'] }, 'trash', FILE)).toBe('Delete for everyone?')
  })

  it('agrees with itself: canDo is a refusal that is null', () => {
    expect(canDo(FOLDER, 'trash', FILE)).toBe(true)
    expect(canDo(TEAMS, 'trash', FILE)).toBe(false)
  })

  it('says the 33rd open in one sentence', () => {
    expect(SEATS_FULL).toBe('32 files are open. Close one to open another.')
  })
})

describe('a file in a message', () => {
  const team = place({ id: 'box~t/general', kind: 'teams', name: 'General', shared: true, root: { at: 'file', host: 'env_box', path: '/cloud/Esports Staff/General' } })
  const own = place({ id: 'folder', kind: 'folder', name: 'Purdue Esports', root: { at: 'file', host: 'env_box', path: '/w/Purdue Esports/' } })
  const row = (path: string, over: Partial<FileEntry> = {}): FileEntry => ({ key: `file:env_box:${path}`, ref: { at: 'file', host: 'env_box', path }, folder: null, name: path.split('/').pop()!, kind: 'sheet', ...over })

  it('is a file chip with its source and its path inside its page\'s place in words, and nothing from inside it', () => {
    const chip = fileChipOf(row('/cloud/Esports Staff/General/Budgets/2026.xlsx'), team)!
    expect(chip).toEqual({
      kind: 'file',
      label: '2026.xlsx',
      ref: { at: 'file', host: 'env_box', path: '/cloud/Esports Staff/General/Budgets/2026.xlsx' },
      where: { place: 'box~t/general', name: 'General', path: 'Budgets/2026.xlsx', shared: true }
    })
    expect(ContextChipSchema.parse(chip)).toEqual(chip)
    expect(fileChipOf(row('/w/Purdue Esports/Events/Poster.png'), own)!.where).toEqual({ place: 'folder', name: 'Purdue Esports', path: 'Events/Poster.png' })
  })

  it("takes a lens row's own place, and its name alone where the path is not under the place", () => {
    expect(fileChipOf(row('/x/notes.txt', { where: { place: 'folder', name: 'Purdue Esports', trail: ['Events'] } }), team)!.where).toEqual({ place: 'folder', name: 'Purdue Esports', path: 'Events/notes.txt', shared: true })
    expect(fileChipOf(row('/w/Purdue Esports2/a.xlsx'), own)!.where!.path).toBe('a.xlsx')
    expect(fileChipOf(row('/w/a.xlsx'))!.where).toBeUndefined()
  })

  it('is no chip for a folder or a thread\'s own item', () => {
    expect(fileChipOf({ key: 'f', ref: null, folder: { at: 'file', host: 'env_box', path: '/w/Events' }, name: 'Events', kind: 'folder' }, own)).toBeNull()
    expect(fileChipOf({ key: 't', ref: { at: 'thread' }, folder: null, name: 'Draft', kind: 'document' })).toBeNull()
  })

  it('takes eight rows at most, leaves folders among them out, and refuses a ninth or folders alone in one sentence', () => {
    const rows = Array.from({ length: FILE_CHIPS_MOST }, (_, i) => row(`/w/Purdue Esports/f${i}.xlsx`))
    const folder: FileEntry = { key: 'f', ref: null, folder: { at: 'file', host: 'env_box', path: '/w/Purdue Esports/Events' }, name: 'Events', kind: 'folder' }
    const got = chipsOf([...rows, folder], own)
    expect('chips' in got && got.chips.map((c) => c.label)).toEqual(rows.map((r) => r.name))
    expect(chipsOf([...rows, row('/w/Purdue Esports/ninth.xlsx')], own)).toEqual({ refused: TOO_MANY_FILES })
    expect(TOO_MANY_FILES).toBe('A message can hold 8 files at most.')
    expect(chipsOf([folder], own)).toEqual({ refused: NO_FOLDER_CHIPS })
  })
})
