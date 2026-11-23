import { utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { FilesListing, FilesPlaces } from '@shared/contract-work-files'
import type { FileEntry } from '@shared/work/files'
import type { Caller } from '../modules'
import { setRoots } from '../office/files/library'
import { closeFilesState, filesState } from './handle'
import { files } from './index'
import { dropName, forgetPlaceNames, putNames, renameName } from './names'
import { forgetLibraries } from './places/libraries'
import { at, HOST, makeRig, peer, phone, thread, window, WS, type Rig } from './testkit'

/** The names table and Go to (`work.files.names`, names.ts), through the module as the wire sends it. */

let rig: Rig
beforeEach(() => {
  rig = makeRig()
})
afterEach(() => {
  closeFilesState(rig.db)
  rig.close()
})

async function call<T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> {
  const req = ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } })
  const out = await files.handle!(req, rig.ctx, by)
  if (!out.handled) throw new Error(`${method} was not handled`)
  return out.result as T
}
/** The table is written after an answer is sent: a turn of the event loop later. */
const settle = (): Promise<void> => new Promise((done) => setImmediate(() => setImmediate(done)))
const goTo = async (text: string, by: Caller = window): Promise<string[]> => (await call<{ entries: FileEntry[] }>('work.files.names', { text }, by)).entries.map((e) => e.name)
const rows = (): { name: string; place: string }[] => rig.db.prepare(`SELECT name, place FROM work_files_names WHERE workspace_id = ? ORDER BY name COLLATE NOCASE`).all(WS) as { name: string; place: string }[]
const general = (): string => join(rig.team, 'General')

describe('the names table', () => {
  it('is fed by every page a list answers, after the answer, each row under its place', async () => {
    expect(rows()).toEqual([])
    await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } })
    // Nothing is written before the answer is on its way.
    expect(rows()).toEqual([])
    await settle()
    expect(rows()).toEqual([
      { name: 'Budget.xlsx', place: 'folder' },
      { name: 'Events', place: 'folder' },
      { name: 'notes.txt', place: 'folder' },
      { name: 'Run of show.tcdoc', place: 'folder' }
    ])
    const places = await call<FilesPlaces>('work.files.places', {})
    const generalId = places.places.find((p) => p.name === 'General')!.id
    await call<FilesListing>('work.files.list', { at: at(general()) })
    await settle()
    expect(rows().filter((r) => r.place === generalId).map((r) => r.name)).toEqual(['Budgets', 'Cloud only.pdf', 'Plan.docx', 'Spring budget.xlsx'])
  })

  it('keeps no lens: Recent and Starred list marks, not a place', async () => {
    await call('work.files.seen', { ref: at(join(rig.folder, 'notes.txt')), name: 'notes.txt' })
    await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'recent' } })
    await settle()
    expect(rows()).toEqual([])
  })

  it('takes a new key and name on a rename, and drops a row and every row under a folder', async () => {
    await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } })
    await call<FilesListing>('work.files.list', { at: at(join(rig.folder, 'Events')) })
    await settle()
    const key = (path: string): string => `file:${HOST}:${path}`
    const renamed = { key: key(join(rig.folder, 'Plan.txt')), ref: at(join(rig.folder, 'Plan.txt')), folder: null, name: 'Plan.txt', kind: 'text' } as FileEntry
    renameName(rig.db, WS, key(join(rig.folder, 'notes.txt')), renamed)
    expect(rows().map((r) => r.name)).toEqual(['Budget.xlsx', 'Events', 'Plan.txt', 'Poster.png', 'Run of show.tcdoc', 'Spring LAN'])
    expect(rows().find((r) => r.name === 'Plan.txt')!.place).toBe('folder')
    dropName(rig.db, WS, key(join(rig.folder, 'Events')))
    expect(rows().map((r) => r.name)).toEqual(['Budget.xlsx', 'Plan.txt', 'Run of show.tcdoc'])
    forgetPlaceNames(rig.db, WS, 'folder')
    expect(rows()).toEqual([])
  })
})

describe('Go to', () => {
  beforeEach(async () => {
    writeFileSync(join(rig.folder, 'Spring budget.txt'), 'x')
    writeFileSync(join(rig.folder, 'Rebudgeted.txt'), 'x')
    utimesSync(join(rig.folder, 'Spring budget.txt'), 2_000, 2_000)
    utimesSync(join(rig.folder, 'Budget.xlsx'), 1_000, 1_000)
    await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } })
    await settle()
  })

  it('lists recents first, then names that start with the words, then names with a word that starts so, then the rest', async () => {
    expect(await goTo('budget')).toEqual(['Budget.xlsx', 'Spring budget.txt', 'Rebudgeted.txt'])
    await call('work.files.seen', { ref: at(join(rig.folder, 'Rebudgeted.txt')), name: 'Rebudgeted.txt' })
    expect(await goTo('BUDGET')).toEqual(['Rebudgeted.txt', 'Budget.xlsx', 'Spring budget.txt'])
    // Every word, in any order.
    expect(await goTo('budget spring')).toEqual(['Spring budget.txt'])
    expect(await goTo('budget fall')).toEqual([])
  })

  it('answers the recents alone for no words, and an open tab first among them', async () => {
    await call('work.files.seen', { ref: at(join(rig.folder, 'Rebudgeted.txt')), name: 'Rebudgeted.txt' })
    expect(await goTo('')).toEqual(['Rebudgeted.txt'])
    await call('work.files.open', { ref: at(join(rig.folder, 'Budget.xlsx')) })
    expect(await goTo('budget')).toEqual(['Budget.xlsx', 'Rebudgeted.txt', 'Spring budget.txt'])
  })

  it('says where each row lives, and marks what he starred', async () => {
    await call<FilesListing>('work.files.list', { at: at(join(rig.folder, 'Events', 'Spring LAN')) })
    await settle()
    await call('work.files.star', { ref: at(join(rig.folder, 'Events', 'Spring LAN', 'Bracket.pdf')), name: 'Bracket.pdf', on: true })
    const got = (await call<{ entries: FileEntry[] }>('work.files.names', { text: 'bracket' })).entries
    expect(got).toMatchObject([{ name: 'Bracket.pdf', kind: 'pdf', starred: true, where: { place: 'folder', name: 'Dummy Esports', trail: ['Events', 'Spring LAN'] } }])
  })

  it('answers 20 rows at most, at once, from the table alone', async () => {
    putNames(
      rig.db,
      WS,
      Array.from({ length: 40 }, (_, i) => ({ entry: { key: `file:${HOST}:${join(rig.folder, `Budget.xlsx`)}#${i}`, ref: at(join(rig.folder, 'Budget.xlsx')), folder: null, name: `Budget ${i}.xlsx`, kind: 'sheet' } as FileEntry, place: 'folder' }))
    )
    expect(await goTo('budget')).toHaveLength(20)
  })

  it('drops, and forgets, a row whose file is gone', async () => {
    writeFileSync(join(rig.folder, 'Gone soon.txt'), 'x')
    filesState(rig.ctx).lister.forget()
    await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' }, sort: { by: 'name', dir: 'desc' } })
    await settle()
    expect(rows().map((r) => r.name)).toContain('Gone soon.txt')
    const { rmSync } = await import('node:fs')
    rmSync(join(rig.folder, 'Gone soon.txt'))
    expect(await goTo('gone')).toEqual([])
    expect(rows().map((r) => r.name)).not.toContain('Gone soon.txt')
  })
})

describe('a library that leaves', () => {
  const feed = async (): Promise<string> => {
    const places = await call<FilesPlaces>('work.files.places', {})
    await call<FilesListing>('work.files.list', { at: at(general()) })
    await settle()
    return places.places.find((p) => p.name === 'General')!.id
  }

  it('takes its names with it at the next places answer of his window', async () => {
    const id = await feed()
    expect(rows().filter((r) => r.place === id)).toHaveLength(4)
    setRoots(rig.db, [{ folder: rig.team, off: true }])
    forgetLibraries(rig.db)
    // A thread's or a key's answer lists fewer places: it never drops rows.
    await call<FilesPlaces>('work.files.places', {}, thread('t1'))
    await call<FilesPlaces>('work.files.places', {}, phone)
    await settle()
    expect(rows().filter((r) => r.place === id)).toHaveLength(4)
    await call<FilesPlaces>('work.files.places', {})
    await settle()
    expect(rows().filter((r) => r.place === id)).toHaveLength(0)
  })

  it('is dropped, and forgotten, by the next Go to that finds it so', async () => {
    const id = await feed()
    expect(await goTo('spring')).toEqual(['Spring budget.xlsx'])
    setRoots(rig.db, [{ folder: rig.team, off: true }])
    forgetLibraries(rig.db)
    expect(await goTo('spring')).toEqual([])
    expect(rows().filter((r) => r.place === id)).toHaveLength(0)
  })

  it('keeps its rows where only the caller may not see it', async () => {
    const id = await feed()
    rig.roots.splice(0, rig.roots.length, rig.folder)
    expect(await goTo('spring', phone)).toEqual([])
    expect(rows().filter((r) => r.place === id)).toHaveLength(4)
  })
})

describe('the fence', () => {
  beforeEach(async () => {
    await call<FilesPlaces>('work.files.places', {})
    for (const dir of [rig.folder, join(rig.folder, 'Events'), join(rig.team, 'General')]) await call<FilesListing>('work.files.list', { at: at(dir) })
    await call('work.files.seen', { ref: at(join(rig.folder, 'Budget.xlsx')), name: 'Budget.xlsx' })
    await settle()
  })

  it('gives a thread its own workspace’s names but not his recents, and another workspace’s thread nothing', async () => {
    expect(await goTo('', thread('t1'))).toEqual([])
    // Two names that start with the word: the newest first.
    expect(await goTo('budget', thread('t1'))).toEqual(['Budgets', 'Budget.xlsx', 'Spring budget.xlsx'])
    await expect(goTo('budget', thread('t2'))).rejects.toThrow("A thread reaches only its own workspace's files.")
    await expect(goTo('budget', thread('chat'))).rejects.toThrow("A thread reaches only its own workspace's files.")
  })

  it('gives another host of his none: the table is the workspace’s own', async () => {
    await expect(goTo('budget', peer)).rejects.toThrow("Another host reaches only this host's libraries.")
  })

  it('gives a remote key only rows it could name', async () => {
    expect(await goTo('budget', phone)).toEqual(['Budget.xlsx'])
    rig.roots.splice(0, rig.roots.length, join(rig.folder, 'Events'))
    expect(await goTo('budget', phone)).toEqual([])
    expect(await goTo('poster', phone)).toEqual(['Poster.png'])
    expect(await goTo('spring', phone)).toEqual(['Spring LAN'])
    rig.roots.push(rig.team)
    expect(await goTo('spring', phone)).toEqual(['Spring budget.xlsx', 'Spring LAN'])
  })

  it('answers no workspace that is not on this host', async () => {
    await expect(call('work.files.names', { workspaceId: 'far', text: 'x' })).rejects.toThrow('No such Work workspace on this host.')
  })
})
