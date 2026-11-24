import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FileAct } from '@shared/contract-work-files'
import type { ClientRequest } from '@shared/contract'
import type { FileDone, FilesListing, FilesOpened, FilesPlaces, FilesTabs } from '@shared/contract-work-files'
import { filesPaneOf, type WorkToolResult } from '@shared/work'
import type { FileEntry } from '@shared/work/files'
import type { ActKindDef, Caller, ToolCtx, WorkCtx } from '../modules'
import { ActKinds } from '../outbox/kinds'
import { Outbox } from '../outbox/outbox'
import { ensureOutboxTables, HeldStore } from '../outbox/store'
import { GOOGLE_MIME } from '../google/client'
import { othersCan } from '../google/drive'
import { FakeGoogle, FAKE_ROOT, FAKE_TOKEN_URL } from '../google/fake'
import { googleOf, resetGoogle, setGoogleDeps } from '../google/google'
import { google, setOpenBrowser } from '../google/index'
import type { DriveDone } from './driveVerbs'
import { filesHandle } from './handle'
import { DRIVE_ACCOUNTS_FRESH_MS, driveAccounts, forgetDriveAccounts, forgetDriveLists } from './places/drive'
import { ASK_FIRST, NEEDS_APPROVE, NEEDS_PRESS, NOT_DRIVE, PEER_LIBRARIES, setThreadsMayWrite } from './policy'
import { approver, makeRig, peer, phone, thread, window, WS, type Rig } from './testkit'
import { fileActKind, filesTools } from './tools'

/**
 * A Google Drive as a Files place (docs/agents/work-files.md "Google Drive"), against the fake Google: the place
 * per account the workspace has, what `drive.file` lets it list (paged), each verb's Drive call through the one
 * door, a thread's change held or run with its Undo, Drive's own bin as Trash, and a Google file in a Files tab.
 */

const ME = 'landon@example.com'
const OTHER = 'ref@example.com'
const PLACE_ID = `drive:${ME}`
const TOP = { at: 'drive' as const, account: ME, folderId: 'root' }
const folder = (folderId: string) => ({ at: 'drive' as const, account: ME, folderId })
const doc = (fileId: string, mime: string = GOOGLE_MIME.doc) => ({ at: 'google' as const, account: ME, fileId, mime })

let rig: Rig
let fake: FakeGoogle
let accountRows: unknown[]
let connected: boolean
let outbox: Outbox
let results: { sessionId: string; kind: string; summary: string; undo?: { args: unknown } }[]

function call<T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> {
  return filesHandle({ id: '1', method, params: { workspaceId: WS, ...params } } as unknown as ClientRequest, rig.ctx, by).then((a) => (a as { result: T }).result)
}
const list = (at: unknown, o: Record<string, unknown> = {}, by: Caller = window) => call<FilesListing>('work.files.list', { at, ...o }, by)
const names = (l: { entries: FileEntry[] }) => l.entries.map((e) => e.name)
let n = 0
const op = () => `op-drive-${++n}-xxxx`

function workCtx(): WorkCtx {
  return Object.assign(rig.ctx, {
    held: { create: (act: { kind: 'file.act'; sessionId: string | null; payload: unknown }) => outbox.wire(outbox.hold(act).row), onDecided: () => () => {} },
    results: { add: (r: (typeof results)[number]) => void results.push(r) },
    links: { completeFor: async () => {} },
    threads: { resume: async () => {}, start: async () => '', ownerSaid: () => false },
    peer: () => ({ call: async () => Promise.reject(new Error('no other host')) })
  })
}
function toolCtx(sessionId = 't1'): ToolCtx {
  const ctx = workCtx()
  return Object.assign(Object.create(null), ctx, { scope: ctx.scopeOf(sessionId)!, sessionId, signal: new AbortController().signal }) as ToolCtx
}
async function tool(name: string, args: Record<string, unknown>): Promise<WorkToolResult & { text: string }> {
  const t = filesTools.find((x) => x.name === name)!
  const got = await t.run(t.input.parse(args), toolCtx())
  return { ...got, text: got.content.map((c) => ('text' in c ? c.text : '')).join('\n') }
}

beforeEach(() => {
  rig = makeRig()
  fake = new FakeGoogle().account(ME).account(OTHER)
  fake.addFolder(ME, 'fEvents', 'Events')
  fake.addFolder(ME, 'fStaff', 'Staff', { shared: true })
  fake.addItem(ME, 'dBrief', 'Brief', GOOGLE_MIME.doc, { parents: ['fEvents'], by: 'Dana Reyes' })
  fake.addItem(ME, 'sBudget', 'Budget', GOOGLE_MIME.sheet)
  fake.addItem(ME, 'dPlan', 'Plan', GOOGLE_MIME.doc, { parents: ['fStaff'] })
  fake.addItem(ME, 'dOpen', 'Open letter', GOOGLE_MIME.doc, { shared: true })
  // Picked from a folder of his TempCode cannot see: it is listed at the place's top.
  fake.addItem(ME, 'pScan', 'Scan.pdf', 'application/pdf', { parents: ['fUnseen'], size: 2048 })
  fake.addItem(ME, 'dHidden', 'Not picked', GOOGLE_MIME.doc, { picked: false })
  fake.addItem(OTHER, 'dRef', 'Game sheet', GOOGLE_MIME.doc)
  setGoogleDeps({ fetch: fake.fetch, tokenUrl: FAKE_TOKEN_URL, blocksOf: async () => [] })
  accountRows = [
    { account: ME, sector: 'purdue', files: true },
    { account: OTHER, sector: 'ref', files: true },
    { account: 'nofiles@example.com', sector: 'purdue', files: false }
  ]
  connected = true
  // A LifeOS that holds his Google accounts and nothing else.
  Object.assign(rig.ctx, { lifeos: { connected: () => connected, jwt: async () => fake.jwt, owner: () => ({ query: async (fn: string) => (fn === 'calendarOps:accounts' ? accountRows : []) }) } })
  setThreadsMayWrite(true)
  google.ensure(rig.db)
  ensureOutboxTables(rig.db)
  rig.db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT)')
  results = []
  const ctx = workCtx()
  outbox = new Outbox({
    ctx,
    store: new HeldStore(rig.db),
    kinds: new ActKinds(() => [{ id: 'files', ensure() {}, acts: [fileActKind as ActKindDef] }]),
    scopeKeyOf: (id) => ctx.scopeOf(id)?.workspaceId ?? null,
    routineOf: () => null,
    rootOf: (id) => id,
    routineRunOf: () => null,
    whisper: () => {}
  })
})
afterEach(() => {
  setThreadsMayWrite(false)
  forgetDriveAccounts(rig.db)
  forgetDriveLists()
  resetGoogle()
  rig.close()
})

describe('the place', () => {
  it('is one place per Google account of the workspace, his own, with what New offers there', async () => {
    const got = await call<FilesPlaces>('work.files.places', {})
    const drives = got.places.filter((p) => p.kind === 'drive')
    // The ref sector's account is another workspace's, and an account that never allowed Drive files is none.
    expect(drives).toEqual([{ id: PLACE_ID, kind: 'drive', name: ME, host: '', env: rig.ctx.host, shared: false, can: ['make', 'rename', 'move', 'trash', 'restore'], state: { state: 'ok' }, root: TOP, web: expect.any(String), makes: ['document', 'sheet', 'deck', 'folder'] }])
  })

  it('is absent, not a fault, when the workspace has no Google account or LifeOS is away', async () => {
    accountRows = [{ account: OTHER, sector: 'ref', files: true }]
    expect((await call<FilesPlaces>('work.files.places', {})).places.some((p) => p.kind === 'drive')).toBe(false)
    forgetDriveAccounts(rig.db)
    connected = false
    accountRows = [{ account: ME, sector: 'purdue', files: true }]
    const got = await call<FilesPlaces>('work.files.places', {})
    expect(got.places.some((p) => p.kind === 'drive')).toBe(false)
    expect(got.places.some((p) => p.kind === 'folder')).toBe(true)
  })

  it("reads LifeOS's accounts once a minute at most, and a new one shows after that", async () => {
    let asked = 0
    const rows = [{ account: ME, sector: 'purdue', files: true }]
    Object.assign(rig.ctx, { lifeos: { connected: () => true, owner: () => ({ query: async (fn: string) => (fn === 'calendarOps:accounts' ? (asked++, rows) : []) }) } })
    expect(await driveAccounts(rig.ctx, 'purdue')).toEqual([ME])
    expect(await driveAccounts(rig.ctx, 'purdue')).toEqual([ME])
    expect(asked).toBe(1)
    rows.push({ account: 'second@example.com', sector: 'purdue', files: true })
    const later = Date.now() + DRIVE_ACCOUNTS_FRESH_MS + 1
    // A stale list answers at once while the read goes on behind it.
    expect(await driveAccounts(rig.ctx, 'purdue', { now: later })).toEqual([ME])
    expect(await driveAccounts(rig.ctx, 'purdue', { wait: 1000 })).toEqual([ME, 'second@example.com'])
    expect(asked).toBe(2)
  })

  it('is listed to his window, the workspace\'s threads and a key bound to the workspace; never to another host', async () => {
    const ids = async (by: Caller) => (await call<FilesPlaces>('work.files.places', {}, by)).places.filter((p) => p.kind === 'drive').map((p) => p.id)
    expect(await ids(thread())).toEqual([PLACE_ID])
    expect(await ids(phone)).toEqual([PLACE_ID])
    expect(await ids(peer)).toEqual([])
    await expect(list(TOP, {}, peer)).rejects.toThrow(PEER_LIBRARIES)
    await call('work.files.star', { ref: doc('dBrief'), name: 'Brief', on: true })
    expect(names(await list({ at: 'place', id: 'starred' }, {}, phone))).toEqual(['Brief'])
    // A key that may not name the workspace's folder hears of no Drive of it, nor of a star on one of its files.
    rig.roots.splice(0, rig.roots.length, rig.outside)
    expect(await ids(phone)).toEqual([])
    await expect(list(TOP, {}, phone)).rejects.toThrow()
    expect(names(await list({ at: 'place', id: 'starred' }, {}, phone))).toEqual([])
  })
})

describe('who else can open a Drive item', () => {
  it("is Drive's own word, a shared drive, another owner, and anything whose facts do not say", () => {
    expect(othersCan({ shared: false, ownedByMe: true })).toBe(false)
    expect(othersCan({ shared: true, ownedByMe: true })).toBe(true)
    expect(othersCan({ shared: false, ownedByMe: true, driveId: 'team' })).toBe(true)
    expect(othersCan({ shared: false, ownedByMe: false })).toBe(true)
    expect(othersCan({})).toBe(true)
  })
})

describe('listing what drive.file lets it see', () => {
  it('lists the top: folders first, what it made and what he picked, each with its own sharing', async () => {
    const top = await list({ at: 'place', id: PLACE_ID })
    expect(names(top)).toEqual(['Events', 'Staff', 'Budget', 'Open letter', 'Scan.pdf'])
    expect(top.trail).toEqual([{ name: ME, at: TOP }])
    expect(top.place).toBe(PLACE_ID)
    const by = new Map(top.entries.map((e) => [e.name, e]))
    expect(by.get('Events')).toMatchObject({ key: 'google:fEvents', kind: 'folder', ref: null, folder: folder('fEvents'), shared: false })
    expect(by.get('Staff')).toMatchObject({ kind: 'folder', shared: true })
    expect(by.get('Budget')).toMatchObject({ key: 'google:sBudget', kind: 'sheet', ref: doc('sBudget', GOOGLE_MIME.sheet), shared: false })
    expect(by.get('Open letter')).toMatchObject({ kind: 'document', shared: true })
    // What is no Google type opens only in Google Drive: it is never listed as a kind an editor here shows.
    expect(by.get('Scan.pdf')).toMatchObject({ kind: 'other', size: 2048 })
    // Never a file it may not see, and the same answer for the place's id and its top folder.
    expect(names(await list(TOP))).toEqual(names(top))
  })

  it('lists a folder with its trail; what lies in a shared folder is shared too', async () => {
    const events = await list(folder('fEvents'))
    expect(events.entries).toEqual([expect.objectContaining({ name: 'Brief', by: 'Dana Reyes', shared: false, changed: expect.any(Number) })])
    expect(events.trail).toEqual([
      { name: ME, at: TOP },
      { name: 'Events', at: folder('fEvents') }
    ])
    expect((await list(folder('fStaff'))).entries).toEqual([expect.objectContaining({ name: 'Plan', shared: true })])
    expect(names(await list(TOP, { foldersOnly: true }))).toEqual(['Events', 'Staff'])
  })

  it('reads Drive page after page and answers its own pages of 500', async () => {
    fake.addFolder(ME, 'fBig', 'Big')
    for (let i = 0; i < 620; i++) fake.addItem(ME, `big${i}`, `Sheet ${i}`, GOOGLE_MIME.sheet, { parents: ['fBig'] })
    fake.pageMost = 250
    const before = fake.calls.filter((c) => c === 'GET /drive/v3/files').length
    const first = await list(folder('fBig'))
    expect(fake.calls.filter((c) => c === 'GET /drive/v3/files').length - before).toBe(3)
    expect(first.entries).toHaveLength(500)
    expect(first.entries[0]!.name).toBe('Sheet 0')
    expect(first.next).toBeTruthy()
    const second = await list(folder('fBig'), { cursor: first.next })
    expect(second.entries).toHaveLength(120)
    expect(second.next).toBeUndefined()
    expect(second.entries.at(-1)!.name).toBe('Sheet 619')
    // By time, newest first: the host's own sort.
    const byTime = await list(folder('fEvents'), { sort: { by: 'changed', dir: 'desc' } })
    expect(names(byTime)).toEqual(['Brief'])
  })

  it('answers the facts of a file again, null for what it may not see', async () => {
    const got = await call<{ entries: (FileEntry | null)[] }>('work.files.stat', { refs: [doc('dBrief'), doc('dPlan'), doc('dHidden'), { at: 'google', account: OTHER, fileId: 'dRef', mime: GOOGLE_MIME.doc }] })
    expect(got.entries[0]).toMatchObject({ name: 'Brief', by: 'Dana Reyes', shared: false })
    expect(got.entries[1]).toMatchObject({ name: 'Plan', shared: true })
    expect(got.entries.slice(2)).toEqual([null, null])
  })

  it("refuses an account of another workspace, whoever asks", async () => {
    await expect(list({ at: 'drive', account: OTHER, folderId: 'root' })).rejects.toThrow(NOT_DRIVE)
    await expect(call('work.files.rename', { ref: { at: 'google', account: OTHER, fileId: 'dRef', mime: GOOGLE_MIME.doc }, name: 'Mine now', op: op() })).rejects.toThrow(NOT_DRIVE)
    await expect(call('work.files.star', { ref: { at: 'google', account: OTHER, fileId: 'dRef', mime: GOOGLE_MIME.doc }, name: 'x', on: true })).rejects.toThrow(NOT_DRIVE)
    expect(fake.files.get('dRef')!.name).toBe('Game sheet')
  })
})

describe('his window\'s verbs, each one Drive call', () => {
  it('makes a Doc, a Sheet, a deck and a folder where he looks, under a free name; never a text file', async () => {
    const made = await call<FileDone>('work.files.make', { at: { at: 'place', id: PLACE_ID }, kind: 'document', op: op() })
    expect(made.entries).toEqual([expect.objectContaining({ name: 'Untitled document', kind: 'document', ref: expect.objectContaining({ at: 'google', mime: GOOGLE_MIME.doc }) })])
    const again = await call<FileDone>('work.files.make', { at: TOP, kind: 'document', op: op() })
    expect(again.entries[0]!.name).toBe('Untitled document 2')
    const deck = await call<FileDone>('work.files.make', { at: folder('fEvents'), kind: 'deck', name: 'Pitch', op: op() })
    const dir = await call<FileDone>('work.files.make', { at: folder('fEvents'), kind: 'folder', op: op() })
    const sheet = await call<FileDone>('work.files.make', { at: folder('fEvents'), kind: 'sheet', op: op() })
    const id = (d: FileDone) => ((d.entries[0]!.ref ?? d.entries[0]!.folder) as { fileId?: string; folderId?: string }).fileId ?? (d.entries[0]!.folder as { folderId: string }).folderId
    expect(fake.files.get(id(made))).toMatchObject({ mimeType: GOOGLE_MIME.doc, parents: [FAKE_ROOT] })
    expect(fake.files.get(id(deck))).toMatchObject({ name: 'Pitch', mimeType: GOOGLE_MIME.slides, parents: ['fEvents'] })
    expect(fake.files.get(id(dir))).toMatchObject({ name: 'Untitled folder', mimeType: 'application/vnd.google-apps.folder' })
    expect(fake.files.get(id(sheet))).toMatchObject({ name: 'Untitled sheet', mimeType: GOOGLE_MIME.sheet })
    await expect(call('work.files.make', { at: TOP, kind: 'text', op: op() })).rejects.toThrow('A text file cannot be made')
    // The same operation id again does nothing twice.
    const twice = await call<FileDone>('work.files.make', { at: { at: 'place', id: PLACE_ID }, kind: 'document', op: made.op })
    expect(twice).toEqual(made)
    expect(names(await list(TOP)).filter((x) => x.startsWith('Untitled document'))).toEqual(['Untitled document', 'Untitled document 2'])
  })

  it('renames and moves within the Drive; a copy and an upload are not offered', async () => {
    const renamed = await call<DriveDone>('work.files.rename', { ref: doc('dBrief'), name: 'Brief v2', op: op() })
    expect(renamed.entries[0]).toMatchObject({ name: 'Brief v2', key: 'google:dBrief' })
    expect(renamed.before).toEqual([{ key: 'google:dBrief', name: 'Brief', parents: ['fEvents'] }])
    expect(fake.files.get('dBrief')!.name).toBe('Brief v2')
    // His own hand moves into a shared folder at once.
    const moved = await call<FileDone>('work.files.move', { refs: [doc('dBrief')], to: folder('fStaff'), op: op() })
    expect(moved.entries[0]).toMatchObject({ name: 'Brief v2', shared: true })
    expect(fake.files.get('dBrief')!.parents).toEqual(['fStaff'])
    expect(names(await list(folder('fStaff')))).toEqual(['Brief v2', 'Plan'])
    expect(names(await list(folder('fEvents')))).toEqual([])
    await expect(call('work.files.rename', { ref: TOP, name: 'x', op: op() })).rejects.toThrow('A place itself cannot be renamed or moved.')
    await expect(call('work.files.copy', { refs: [doc('sBudget')], to: folder('fEvents'), op: op() })).rejects.toThrow(`Nothing can be copied in ${ME} from here.`)
    await expect(call('work.files.upload', { at: TOP, name: 'a.txt', size: 1, sha256: 'a'.repeat(64), op: op() })).rejects.toThrow(`Nothing can be uploaded in ${ME} from here.`)
    // A move between a Drive and the workspace's folder is refused in the grammar's sentence.
    await expect(call('work.files.move', { refs: [doc('sBudget')], to: { at: 'place', id: 'folder' }, op: op() })).rejects.toThrow('A Google file lives in Google Drive.')
  })

  it('asks a remote key for approve before a change others will see', async () => {
    await expect(call('work.files.rename', { ref: doc('dOpen'), name: 'Letter', op: op() }, phone)).rejects.toThrow(NEEDS_APPROVE)
    await expect(call('work.files.rename', { ref: doc('dPlan'), name: 'Plan 2', op: op() }, phone)).rejects.toThrow(NEEDS_APPROVE)
    expect(fake.files.get('dOpen')!.name).toBe('Open letter')
    await call('work.files.rename', { ref: doc('dOpen'), name: 'Letter', op: op() }, approver)
    expect(fake.files.get('dOpen')!.name).toBe('Letter')
    await call('work.files.rename', { ref: doc('sBudget'), name: 'Budget 2027', op: op() }, phone)
    expect(fake.files.get('sBudget')!.name).toBe('Budget 2027')
  })
})

describe("Drive's own bin as Trash", () => {
  it('deletes to the bin, lists the row in Trash with where it was, and puts it back', async () => {
    const done = await call<FileDone>('work.files.trash', { refs: [doc('dBrief')], op: op() })
    expect(done.trashed).toHaveLength(1)
    expect(fake.files.get('dBrief')!.trashed).toBe(true)
    expect(names(await list(folder('fEvents')))).toEqual([])
    const bin = await list({ at: 'place', id: 'trash' })
    expect(bin.entries).toEqual([expect.objectContaining({ key: `trash:${done.trashed![0]}`, name: 'Brief', kind: 'document', where: { place: PLACE_ID, name: ME, trail: ['Events'] } })])
    const back = await call<FileDone>('work.files.restore', { ids: done.trashed, op: op() })
    expect(back.entries).toEqual([expect.objectContaining({ name: 'Brief', key: 'google:dBrief', where: { place: PLACE_ID, name: ME, trail: ['Events'] } })])
    expect(fake.files.get('dBrief')!.trashed).toBe(false)
    expect(names(await list(folder('fEvents')))).toEqual(['Brief'])
    expect((await list({ at: 'place', id: 'trash' })).entries).toEqual([])
  })

  it('puts a shared file back only on his press: a key that may not approve puts back his own file alone', async () => {
    const own = await call<FileDone>('work.files.trash', { refs: [doc('dBrief')], op: op() })
    const shared = await call<FileDone>('work.files.trash', { refs: [doc('dOpen')], op: op(), asked: true })
    await expect(call('work.files.restore', { ids: [...own.trashed!, ...shared.trashed!], op: op() }, phone)).rejects.toThrow(NEEDS_PRESS)
    expect([fake.files.get('dBrief')!.trashed, fake.files.get('dOpen')!.trashed]).toEqual([true, true])
    expect((await call<FileDone>('work.files.restore', { ids: own.trashed, op: op() }, phone)).entries.map((e) => e.name)).toEqual(['Brief'])
    expect((await call<FileDone>('work.files.restore', { ids: shared.trashed, op: op() }, approver)).entries.map((e) => e.name)).toEqual(['Open letter'])
  })

  it('puts back no shared file that rides with a LifeOS id, from a key that may not approve', async () => {
    const shared = await call<FileDone>('work.files.trash', { refs: [doc('dOpen')], op: op(), asked: true })
    await expect(call('work.files.restore', { ids: ['lifeos:docs:dAny', ...shared.trashed!], op: op() }, phone)).rejects.toThrow(NEEDS_PRESS)
    expect(fake.files.get('dOpen')!.trashed).toBe(true)
  })

  it('asks first before a shared file goes, and Empty Trash leaves the bin to Drive', async () => {
    await expect(call('work.files.trash', { refs: [doc('dOpen')], op: op() })).rejects.toThrow(ASK_FIRST)
    const done = await call<FileDone>('work.files.trash', { refs: [doc('dOpen')], op: op(), asked: true })
    expect(fake.files.get('dOpen')!.trashed).toBe(true)
    expect(await call('work.files.purge', { ids: done.trashed })).toEqual({ purged: 1 })
    // Nothing deletes a Drive file for good: it waits in Drive's own bin.
    expect(fake.files.get('dOpen')).toMatchObject({ trashed: true })
    expect(fake.calls.some((c) => c.startsWith('DELETE'))).toBe(false)
  })
})

describe("a thread's change", () => {
  it('to his own Drive file runs at once with its Result and an Undo', async () => {
    const places = (await tool('files_places', {})).structuredContent as { places: { place: string; who: string }[] }
    expect(places.places.find((p) => p.place === PLACE_ID)!.who).toBe('Each file by its own sharing in Google Drive: a change to one others can open waits for the owner.')
    const listed = await tool('files_list', { place: PLACE_ID, path: 'Events' })
    expect((listed.structuredContent as { entries: { file: string }[] }).entries.map((e) => e.file)).toEqual(['Events/Brief'])
    const renamed = await tool('files_move', { place: ME, paths: ['Events/Brief'], name: 'Brief draft' })
    expect(renamed.isError).toBeFalsy()
    expect(fake.files.get('dBrief')!.name).toBe('Brief draft')
    expect(results).toEqual([expect.objectContaining({ kind: 'file.rename', summary: `Renamed Events/Brief draft in ${ME}` })])
    const opOf = (r: WorkToolResult) => (r.structuredContent as { undo: { op: string } }).undo.op
    expect((await tool('files_undo', { op: opOf(renamed) })).text).toBe('Renamed back: Brief.')
    expect(fake.files.get('dBrief')!.name).toBe('Brief')
    const made = await tool('files_make', { place: PLACE_ID, path: 'Events', kind: 'document', name: 'Notes' })
    expect(made.isError).toBeFalsy()
    const madeId = [...fake.files.values()].find((f) => f.name === 'Notes')!.id
    expect((await tool('files_undo', { op: opOf(made) })).text).toBe('Put in Trash: Notes.')
    expect(fake.files.get(madeId)!.trashed).toBe(true)
    const moved = await tool('files_move', { place: PLACE_ID, paths: ['Budget'], to: { place: PLACE_ID, path: 'Events' } })
    expect(fake.files.get('sBudget')!.parents).toEqual(['fEvents'])
    expect((await tool('files_undo', { op: opOf(moved) })).text).toBe('Moved back: Budget.')
    expect(fake.files.get('sBudget')!.parents).toEqual([FAKE_ROOT])
    const trashed = await tool('files_trash', { place: PLACE_ID, paths: ['Events/Brief'] })
    expect(fake.files.get('dBrief')!.trashed).toBe(true)
    expect((await tool('files_undo', { op: opOf(trashed) })).text).toBe('Put back: Brief.')
    expect(fake.files.get('dBrief')!.trashed).toBe(false)
  })

  it('to a file others can open, or into a folder they can, is held for his press, a delete there too, which his press sends to Drive\'s bin alone', async () => {
    const held = await tool('files_move', { place: PLACE_ID, paths: ['Open letter'], name: 'Letter' })
    expect(held.text).toMatch(/^Held as item 1: a change to a file others can open\. /)
    expect(fake.files.get('dOpen')!.name).toBe('Open letter')
    const into = await tool('files_move', { place: PLACE_ID, paths: ['Budget'], to: { place: PLACE_ID, path: 'Staff' } })
    expect(into.text).toMatch(/^Held as item 2: /)
    const inside = await tool('files_make', { place: PLACE_ID, path: 'Staff', kind: 'sheet', name: 'Roster' })
    expect(inside.text).toMatch(/^Held as item 3: /)
    expect(fake.files.get('sBudget')!.parents).toEqual([FAKE_ROOT])
    expect(results).toEqual([])
    const deleted = await tool('files_trash', { place: PLACE_ID, paths: ['Staff/Plan'] })
    expect(deleted.text).toMatch(/^Held as item 4: /)
    // The thread's own result names nothing; the item says what it is, to his press.
    expect(outbox.store.list({}).map((r) => r.summary)).toEqual([
      expect.stringMatching(/^Rename Open letter to Letter in landon@example\.com\./),
      expect.stringMatching(/^Move Budget to landon@example\.com, Staff\./),
      expect.stringMatching(/^Make Roster in landon@example\.com, Staff\./),
      expect.stringMatching(/^Delete Plan from landon@example\.com, Staff\./)
    ])
    expect(fake.files.get('dPlan')!.trashed).toBe(false)
    // His press runs each as his window's change.
    const rows = outbox.store.list({})
    expect(await outbox.send({ at: 'host', id: rows[0]!.id })).toMatchObject({ state: 'sent', result: { summary: 'Renamed: Letter.' } })
    expect(fake.files.get('dOpen')!.name).toBe('Letter')
    expect(await outbox.send({ at: 'host', id: rows[1]!.id })).toMatchObject({ state: 'sent' })
    expect(fake.files.get('sBudget')!.parents).toEqual(['fStaff'])
    expect(await outbox.send({ at: 'host', id: rows[2]!.id })).toMatchObject({ state: 'sent' })
    expect([...fake.files.values()].find((f) => f.name === 'Roster')).toMatchObject({ mimeType: GOOGLE_MIME.sheet, parents: ['fStaff'] })
    // The delete: to Drive's own bin, and nothing else there goes.
    const before = [...fake.files.values()].filter((f) => f.trashed).map((f) => f.id)
    expect(await outbox.send({ at: 'host', id: rows[3]!.id })).toMatchObject({ state: 'sent', result: { summary: 'Deleted: Plan.' } })
    expect(fake.files.get('dPlan')).toMatchObject({ trashed: true, parents: ['fStaff'] })
    expect([...fake.files.values()].filter((f) => f.trashed).map((f) => f.id).sort()).toEqual([...before, 'dPlan'].sort())
    expect(await outbox.send({ at: 'host', id: rows[3]!.id })).toMatchObject({ state: 'sent' })
  })

  it("makes a held New under the name its card showed or not at all: one taken there since is stale, never 'Agenda 2'", async () => {
    const held = await tool('files_make', { place: PLACE_ID, path: 'Staff', kind: 'document', name: 'Agenda' })
    expect(held.text).toMatch(/^Held as item 1: /)
    // A co-author makes "agenda" in Staff before his press.
    fake.addItem(ME, 'dTheirs', 'agenda', GOOGLE_MIME.doc, { parents: ['fStaff'] })
    const [row] = outbox.store.list({})
    expect(await outbox.send({ at: 'host', id: row!.id })).toMatchObject({ state: 'stale', error: expect.stringContaining('Something named Agenda is there now') })
    expect([...fake.files.values()].filter((f) => /^agenda/i.test(f.name)).map((f) => f.name)).toEqual(['agenda'])
  })

  it('goes stale when the folder it goes to was moved under another folder, its id, name and sharing alike', async () => {
    fake.addFolder(ME, 'fOther', 'Other team', { shared: true })
    const into = await tool('files_move', { place: PLACE_ID, paths: ['Budget'], to: { place: PLACE_ID, path: 'Staff' } })
    expect(into.text).toMatch(/^Held as item 1: /)
    const [row] = outbox.store.list({})
    expect((row!.payload as FileAct).into?.parents).toEqual(expect.any(Array))
    // Someone moves Staff into another team's folder: Drive keeps its id, its name and its sharing.
    fake.files.get('fStaff')!.parents = ['fOther']
    expect(await outbox.send({ at: 'host', id: row!.id })).toMatchObject({ state: 'stale', error: expect.stringContaining('is gone or moved') })
    expect(fake.files.get('sBudget')!.parents).toEqual([FAKE_ROOT])
  })

  it('to a file in a folder this client cannot see is held: unknown sharing counts as shared, My Drive\'s top as his', async () => {
    // Scan.pdf lies in a folder of his TempCode cannot read the facts of: others may open it.
    const held = await tool('files_move', { place: PLACE_ID, paths: ['Scan.pdf'], name: 'Scan 2.pdf' })
    expect(held.text).toMatch(/^Held as item 1: /)
    expect(fake.files.get('pScan')!.name).toBe('Scan.pdf')
    // Budget lies at My Drive's top, which drive.file cannot read either: that is his own, and the change runs.
    const ran = await tool('files_move', { place: PLACE_ID, paths: ['Budget'], name: 'Budget 2' })
    expect(ran.isError).toBeFalsy()
    expect(fake.files.get('sBudget')!.name).toBe('Budget 2')
  })

  it('held, goes stale when the file changed in Drive before his press', async () => {
    await tool('files_move', { place: PLACE_ID, paths: ['Open letter'], name: 'Letter' })
    fake.files.get('dOpen')!.modified += 5_000
    const [row] = outbox.store.list({})
    expect(await outbox.send({ at: 'host', id: row!.id })).toMatchObject({ state: 'stale' })
    expect(fake.files.get('dOpen')!.name).toBe('Open letter')
  })

  it('held, goes stale when who can open the file or its folder changed in Drive before his press, its key and version the same', async () => {
    await tool('files_move', { place: PLACE_ID, paths: ['Budget'], to: { place: PLACE_ID, path: 'Staff' } })
    await tool('files_move', { place: PLACE_ID, paths: ['Open letter'], name: 'Letter' })
    const [into, renamed] = outbox.store.list({})
    // Budget is shared with someone now; Open letter is shared with no one.
    fake.files.get('sBudget')!.shared = true
    fake.files.get('dOpen')!.shared = false
    forgetDriveLists()
    expect(await outbox.send({ at: 'host', id: into!.id })).toMatchObject({ state: 'stale', error: 'Who can open Budget changed since this was held, so nothing was done. Ask the thread again if it is still wanted.' })
    expect(await outbox.send({ at: 'host', id: renamed!.id })).toMatchObject({ state: 'stale', error: expect.stringMatching(/^Who can open Open letter changed since/) })
    expect(fake.files.get('sBudget')!.parents).toEqual([FAKE_ROOT])
    expect(fake.files.get('dOpen')!.name).toBe('Open letter')
    // The folder it was to go in: Staff is shared with no one now.
    await tool('files_move', { place: PLACE_ID, paths: ['Events/Brief'], to: { place: PLACE_ID, path: 'Staff' } })
    const brief = outbox.store.list({}).find((r) => r.summary.startsWith('Move Brief'))!
    fake.files.get('fStaff')!.shared = false
    forgetDriveLists()
    expect(await outbox.send({ at: 'host', id: brief.id })).toMatchObject({ state: 'stale', error: expect.stringMatching(/^Who can open Staff changed since/) })
    expect(fake.files.get('dBrief')!.parents).toEqual(['fEvents'])
  })

  it('never comes through the wire, and a thread of another workspace reaches no Drive of this one', async () => {
    await expect(call('work.files.rename', { ref: doc('sBudget'), name: 'x', op: op() }, thread())).rejects.toThrow('A thread changes files with the files_* tools.')
    await expect(list(TOP, {}, thread('t2'))).rejects.toThrow("A thread reaches only its own workspace's files.")
  })
})

describe('a Google file in a Files tab', () => {
  it('opens on the Files pane with no thread, never twice, through work.google.open or work.files.open', async () => {
    const asked = (await google.handle!({ id: '1', method: 'work.google.open', params: { sessionId: filesPaneOf(WS), account: ME, fileId: 'dBrief' } } as unknown as ClientRequest, rig.ctx, window)) as { result: { itemId: string; tabId: string } }
    const item = rig.canvas.get(asked.result.itemId)!
    expect(item).toMatchObject({ sessionId: filesPaneOf(WS), kind: 'document', title: 'Brief', source: doc('dBrief') })
    const tabs = await call<FilesTabs>('work.files.tabs', {})
    expect(tabs.tabs.filter((t) => t.kind === 'file')).toEqual([expect.objectContaining({ id: asked.result.tabId, key: 'google:dBrief', name: 'Brief', itemId: item.id })])
    const again = await call<FilesOpened>('work.files.open', { ref: doc('dBrief') })
    expect(again.tabId).toBe(asked.result.tabId)
    expect(again.item!.id).toBe(item.id)
    const sheet = await call<FilesOpened>('work.files.open', { ref: doc('sBudget', GOOGLE_MIME.sheet) })
    expect(sheet.item).toMatchObject({ kind: 'sheet', sessionId: filesPaneOf(WS) })
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs.filter((t) => t.kind === 'file')).toHaveLength(2)
    // A picked PDF, which no editor here reads, opens as its facts (the `file` kind), with no row the pillar polls.
    const scan = await call<FilesOpened>('work.files.open', { ref: doc('pScan', 'application/pdf') })
    expect(scan.item).toMatchObject({ kind: 'file', title: 'Scan.pdf', sessionId: filesPaneOf(WS), source: doc('pScan', 'application/pdf') })
    expect(googleOf(workCtx()).files.get(ME, 'pScan')).toBeFalsy()
    expect((await call<{ entries: (FileEntry | null)[] }>('work.files.stat', { refs: [doc('pScan', 'application/pdf')] })).entries[0]).toMatchObject({ name: 'Scan.pdf', size: 2048 })
    // A picked workbook too: listed as no sheet, and opened as its facts.
    fake.addItem(ME, 'xRoster', 'Roster.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    forgetDriveLists()
    expect((await list(TOP)).entries.find((e) => e.name === 'Roster.xlsx')).toMatchObject({ kind: 'other' })
    expect((await call<FilesOpened>('work.files.open', { ref: doc('xRoster', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') })).item).toMatchObject({ kind: 'file', title: 'Roster.xlsx' })
    // A thread's files_open still says where such a file opens.
    expect((await tool('files_open', { place: PLACE_ID, path: 'Scan.pdf' })).text).toContain('Scan.pdf opens in Google Drive')
    // A tab on a file that goes to the bin closes with it.
    await call('work.files.trash', { refs: [doc('dBrief')], op: op() })
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs.filter((t) => t.kind === 'file').map((t) => t.key)).toEqual(['google:sBudget', 'google:pScan', 'google:xRoster'])
  })

  it('Add from Drive: what he picks is listed in the place at once', async () => {
    process.env.TEMP_CODE_GOOGLE_CLIENT_ID = '123-abc.apps.googleusercontent.com'
    try {
      expect(names(await list(TOP))).not.toContain('Not picked')
      setOpenBrowser(async (url) => void fake.pick(url, ME, ['dHidden']))
      const picked = (await google.handle!({ id: '1', method: 'work.google.pick', params: { account: ME } } as unknown as ClientRequest, rig.ctx, window)) as { result: { files: { fileId: string }[] } }
      expect(picked.result.files.map((f) => f.fileId)).toEqual(['dHidden'])
      expect(names(await list(TOP))).toContain('Not picked')
    } finally {
      delete process.env.TEMP_CODE_GOOGLE_CLIENT_ID
    }
  })
})
