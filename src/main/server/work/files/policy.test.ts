import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FILE_VERBS, type FileVerb } from '@shared/work/files'
import { FenceError } from '../../remote/fence'
import {
  admitCaller,
  admitWrite,
  ASK_FIRST,
  changeDigest,
  locate,
  NEEDS_APPROVE,
  NOT_HERE,
  NOT_REACHED,
  NOT_VM,
  PEER_LIBRARIES,
  PEER_NO_ORIGIN,
  PEER_WRONG_ACT,
  setThreadsMayWrite,
  sharedOf,
  THREAD_ELSEWHERE,
  THREADS_NOT_YET,
  workspaceHere,
  type DoorPlace
} from './policy'
import { approver, at, HOST, makeRig, peer, phone, thread, window, WS, type Rig } from './testkit'
import { setVmState } from '../office/vm/office'

/** The one door (policy.ts): where a ref lies for each caller, what is shared, and each cell of the callers' table. */

let rig: Rig
beforeEach(() => {
  rig = makeRig()
})
afterEach(() => {
  setThreadsMayWrite(false)
  rig.close()
})

const ALL: FileVerb[] = [...FILE_VERBS]
const OWN: DoorPlace = { id: 'folder', kind: 'folder', name: 'Dummy Esports', host: 'The box', env: HOST, shared: false, can: ALL, state: { state: 'ok' } }
const TEAM: DoorPlace = { id: 'box~1', kind: 'teams', name: 'Esports Staff', host: 'The box', env: HOST, shared: true, can: ['make', 'upload', 'rename', 'move', 'copy', 'trash'], state: { state: 'ok' }, group: 'Esports Staff' }
const FILE = { name: 'Budget.xlsx', kind: 'sheet' as const, size: 1200 }

describe('the workspace', () => {
  it('is a Work workspace of this host, and nothing else', () => {
    expect(workspaceHere(rig.db, WS)).toEqual({ id: WS, name: 'Dummy Esports', path: rig.folder, sector: 'purdue' })
    expect(workspaceHere(rig.db, 'code1')).toBeNull()
    expect(workspaceHere(rig.db, 'nope')).toBeNull()
  })
})

describe('where a ref lies, by caller', () => {
  const where = (by: Parameters<typeof locate>[1], path: string, ws = WS) => locate(rig.ctx, by, ws, at(path), 'work.files.list')

  it("finds a file in the workspace's folder for his window, by its real path", () => {
    expect(where(window, join(rig.folder, 'Events', 'Poster.png'))).toMatchObject({ in: 'folder', path: join(rig.folder, 'Events', 'Poster.png'), root: rig.folder })
    expect(where(window, rig.folder)).toMatchObject({ in: 'folder', path: rig.folder })
    // A Microsoft file by its path is the same file.
    expect(locate(rig.ctx, window, WS, { at: 'microsoft', host: HOST, app: 'excel', name: 'Budget.xlsx', ref: { kind: 'path', path: join(rig.folder, 'Budget.xlsx') } }, 'm')).toMatchObject({ in: 'folder' })
  })

  it('finds a file in a library of this host', () => {
    const found = where(window, join(rig.team, 'General', 'Plan.docx'))
    expect(found).toMatchObject({ in: 'library', path: join(rig.team, 'General', 'Plan.docx') })
    expect(found.in === 'library' && found.library.team).toBe('Esports Staff')
    expect(where(window, join(rig.mine, 'Mine.docx'))).toMatchObject({ in: 'library' })
  })

  it('refuses what lies in neither: a link out, a step up, another workspace\'s folder, a path that is gone', () => {
    expect(() => where(window, join(rig.folder, 'way out', 'secret.txt'))).toThrow(NOT_REACHED)
    expect(() => where(window, join(rig.team, 'General', 'way out', 'secret.txt'))).toThrow(NOT_REACHED)
    expect(() => where(window, join(rig.folder, '..', '..', 'outside', 'secret.txt'))).toThrow(NOT_REACHED)
    expect(() => where(window, join(rig.otherFolder, 'Payroll.xlsx'))).toThrow(NOT_REACHED)
    expect(() => where(window, join(rig.folder, 'gone.txt'))).toThrow('gone.txt is not there any more.')
    // The other workspace's own window call reaches it.
    expect(where(window, join(rig.otherFolder, 'Payroll.xlsx'), 'w2')).toMatchObject({ in: 'folder' })
  })

  it('refuses a file of another host: that host is asked', () => {
    expect(() => locate(rig.ctx, window, WS, at(join(rig.folder, 'Budget.xlsx'), 'env_mac'), 'm')).toThrow(NOT_HERE)
  })

  it('holds a thread to its own workspace, and gives a Work Chat no place at all', () => {
    expect(where(thread('t1'), join(rig.folder, 'Budget.xlsx'))).toMatchObject({ in: 'folder' })
    expect(() => where(thread('t2'), join(rig.folder, 'Budget.xlsx'))).toThrow(THREAD_ELSEWHERE)
    expect(() => where(thread('t1'), join(rig.otherFolder, 'Payroll.xlsx'), 'w2')).toThrow(THREAD_ELSEWHERE)
    expect(() => where(thread('chat'), join(rig.team, 'General', 'Plan.docx'))).toThrow(THREAD_ELSEWHERE)
    expect(() => where(thread('unknown'), join(rig.folder, 'Budget.xlsx'))).toThrow(THREAD_ELSEWHERE)
    expect(() => admitCaller(rig.ctx, thread('t2'), WS)).toThrow(THREAD_ELSEWHERE)
    expect(() => admitCaller(rig.ctx, phone, WS)).not.toThrow()
  })

  it('gives another host of his the libraries alone', () => {
    expect(where(peer, join(rig.team, 'General', 'Plan.docx'))).toMatchObject({ in: 'library' })
    expect(() => where(peer, join(rig.folder, 'Budget.xlsx'))).toThrow(PEER_LIBRARIES)
    expect(() => locate(rig.ctx, peer, WS, { at: 'place', id: 'trash' }, 'm')).toThrow(PEER_LIBRARIES)
  })

  it('gives a remote key only what the listener\'s fence lets it name: the folder, never a library outside its roots', () => {
    expect(where(phone, join(rig.folder, 'Budget.xlsx'))).toMatchObject({ in: 'folder' })
    expect(() => where(phone, join(rig.team, 'General', 'Plan.docx'))).toThrow(FenceError)
    // A workspace whose folder the key cannot name is out of its reach too.
    expect(() => where(phone, join(rig.otherFolder, 'Payroll.xlsx'), 'w2')).toThrow(FenceError)
    rig.roots.push(rig.team)
    expect(where(phone, join(rig.team, 'General', 'Plan.docx'))).toMatchObject({ in: 'library' })
  })

  it("names a place's top and a lens for the workspace's own callers", () => {
    expect(locate(rig.ctx, window, WS, { at: 'place', id: 'trash' }, 'm')).toEqual({ in: 'place', id: 'trash' })
    expect(locate(rig.ctx, thread('t1'), WS, { at: 'place', id: 'folder' }, 'm')).toEqual({ in: 'place', id: 'folder' })
  })

  it('reads a file in the Windows VM as a library only where the workspace turns the VM on for a thread', () => {
    if (process.platform === 'win32') return
    setVmState(() => ({ state: 'awake', cannot: null }))
    rig.db.prepare(`INSERT INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(
      JSON.stringify({ at: 1, status: { onedrive: { installed: true, running: true, account: 'a@dummy.edu' }, mounts: [{ path: 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents', type: 'team', web: null }], office: { installed: true, version: null, apps: [], account: null, licensed: null } }, tops: {} })
    )
    const inVm = 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents\\General\\Plan.docx'
    expect(where(window, inVm)).toMatchObject({ in: 'library', path: inVm })
    expect(where(phone, inVm)).toMatchObject({ in: 'library' })
    expect(() => where(window, 'C:\\Users\\tcuser\\Desktop\\secret.txt')).toThrow(NOT_REACHED)
    expect(() => where(window, 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents\\..\\..\\Desktop\\x')).toThrow(NOT_REACHED)
    expect(() => where(thread('t1'), inVm)).toThrow(NOT_VM)
    rig.settings.set(WS, { windowsVm: true })
    expect(where(thread('t1'), inVm)).toMatchObject({ in: 'library' })
  })
})

describe('what is shared', () => {
  const file = (path: string, host = HOST) => sharedOf(rig.ctx, at(path, host))
  it('is a file in a library, in any cloud folder, on another host, in the VM, in Google, or at a Microsoft address', () => {
    expect(file(join(rig.team, 'General', 'Plan.docx'))).toBe(true)
    expect(file(join(rig.mine, 'Mine.docx'))).toBe(true)
    // A cloud folder that is no listed library: the host cannot tell who sees it.
    expect(file(join(rig.cloud, 'Dropbox', 'x.txt'))).toBe(true)
    expect(file(join(rig.folder, 'Budget.xlsx'), 'env_mac')).toBe(true)
    expect(sharedOf(rig.ctx, { at: 'google', account: 'a@b.c', fileId: 'F', mime: 'x' })).toBe(true)
    expect(sharedOf(rig.ctx, { at: 'microsoft', host: HOST, app: 'word', name: 'a', ref: { kind: 'url', url: 'https://x/y' } })).toBe(true)
    if (process.platform !== 'win32') expect(file('C:\\Users\\tcuser\\OneDrive\\a.docx')).toBe(true)
  })

  it('is a file on a disk others reach or in a folder named for OneDrive, as Office says, by its spelling alone', () => {
    for (const path of ['/Volumes/Team/Plan.tcdoc', '/Volumes/Team/Budget.xlsx', '//server/share/Plan.tcdoc', '/mnt/team/Deck.pptx', '/media/share/Budget.xlsx', '/net/files/Plan.tcdoc', join(rig.outside, 'OneDrive - Dummy U', 'Plan.tcdoc'), join(rig.outside, 'OneDrive', 'Budget.xlsx')]) {
      expect(file(path), path).toBe(true)
    }
  })

  it('judges a path not made yet by its nearest real folder: a new file through a link to a library is the library\'s', () => {
    symlinkSync(rig.team, join(rig.folder, 'Team link'))
    expect(file(join(rig.folder, 'Team link', 'General', 'New deck.pptx'))).toBe(true)
    expect(file(join(rig.folder, 'Team link', 'New folder', 'New.tcdoc'))).toBe(true)
    expect(file(join(rig.mine, 'Not yet', 'New.tcdoc'))).toBe(true)
    expect(file(join(rig.folder, 'Not yet', 'New.tcdoc'))).toBe(false)
  })

  it("looks at the app's own data last: a data folder kept in a synced place is that place's", () => {
    const dataDir = join(rig.mine, 'TempCode data')
    mkdirSync(join(dataDir, 'work-files', 'imports', 'abc'), { recursive: true })
    const ctx = { ...rig.ctx, dataDir }
    expect(sharedOf(ctx, at(join(dataDir, 'work-files', 'imports', 'abc', 'Plan.tcdoc')))).toBe(true)
    expect(sharedOf(ctx, at(join(rig.folder, 'Budget.xlsx')))).toBe(false)
  })

  it("is not a file of his own: the workspace's folder, what the app keeps, an item made in a thread", () => {
    expect(file(join(rig.folder, 'Budget.xlsx'))).toBe(false)
    expect(file(join(rig.dataDir, 'attachments', 'teams-files', 'filespane_w1', 'abc', 'Plan.docx'))).toBe(false)
    expect(file(join(rig.dataDir, 'work-files', 'imports', 'abc', 'Plan.tcdoc'))).toBe(false)
    expect(sharedOf(rig.ctx, { at: 'thread' })).toBe(false)
    expect(sharedOf(rig.ctx, { at: 'lifeos', table: 'docs', id: 'd1' })).toBe(false)
    expect(sharedOf(rig.ctx, { at: 'microsoft', host: HOST, app: 'excel', name: 'Budget.xlsx', ref: { kind: 'path', path: join(rig.folder, 'Budget.xlsx') } })).toBe(false)
  })
})

describe('the door: each cell of the callers\' table', () => {
  it("lets his window change his own place at once, and a place others can open after its question", () => {
    for (const verb of ALL) expect(admitWrite(window, { verb, from: OWN, entry: FILE }), verb).toBe('run')
    expect(admitWrite(window, { verb: 'rename', from: TEAM, entry: FILE })).toBe('run')
    expect(() => admitWrite(window, { verb: 'copy', from: OWN, to: TEAM, entry: FILE })).toThrow(ASK_FIRST)
    expect(admitWrite(window, { verb: 'copy', from: OWN, to: TEAM, entry: FILE, asked: true })).toBe('run')
    expect(() => admitWrite(window, { verb: 'trash', from: TEAM, entry: FILE })).toThrow(ASK_FIRST)
    expect(admitWrite(window, { verb: 'trash', from: TEAM, entry: FILE, asked: true })).toBe('run')
  })

  it('lets a remote key change his own place with operate, and a shared one only with approve', () => {
    expect(admitWrite(phone, { verb: 'rename', from: OWN, entry: FILE })).toBe('run')
    expect(admitWrite(phone, { verb: 'trash', from: OWN, entry: FILE })).toBe('run')
    expect(() => admitWrite(phone, { verb: 'rename', from: TEAM, entry: FILE })).toThrow(NEEDS_APPROVE)
    expect(() => admitWrite(phone, { verb: 'copy', from: OWN, to: TEAM, entry: FILE, asked: true })).toThrow(NEEDS_APPROVE)
    expect(() => admitWrite(phone, { verb: 'trash', from: OWN, entry: { ...FILE, shared: true }, asked: true })).toThrow(NEEDS_APPROVE)
    expect(admitWrite(approver, { verb: 'rename', from: TEAM, entry: FILE })).toBe('run')
    // An approve key is asked the same question a window is.
    expect(() => admitWrite(approver, { verb: 'copy', from: OWN, to: TEAM, entry: FILE })).toThrow(ASK_FIRST)
    expect(admitWrite(approver, { verb: 'copy', from: OWN, to: TEAM, entry: FILE, asked: true })).toBe('run')
  })

  it('refuses every change from a thread until its tools land; then his own place runs and a shared one is always held', () => {
    for (const from of [OWN, TEAM]) expect(() => admitWrite(thread(), { verb: 'rename', from, entry: FILE })).toThrow(THREADS_NOT_YET)
    setThreadsMayWrite(true)
    expect(admitWrite(thread(), { verb: 'rename', from: OWN, entry: FILE })).toBe('run')
    expect(admitWrite(thread(), { verb: 'trash', from: OWN, entry: FILE })).toBe('run')
    expect(admitWrite(thread(), { verb: 'rename', from: TEAM, entry: FILE })).toBe('hold')
    expect(admitWrite(thread(), { verb: 'copy', from: OWN, to: TEAM, entry: FILE })).toBe('hold')
    expect(admitWrite(thread(), { verb: 'trash', from: OWN, entry: { ...FILE, shared: true } })).toBe('hold')
    // "He asked for it" opens nothing: the window's flag is not read from a thread.
    expect(admitWrite(thread(), { verb: 'copy', from: OWN, to: TEAM, entry: FILE, asked: true })).toBe('hold')
  })

  it("never runs a thread's own idea in a place others can open, whatever verb it is and whatever the request claims", () => {
    setThreadsMayWrite(true)
    const shared: DoorPlace = { ...TEAM, can: ALL }
    const digest = changeDigest({ verb: 'edit', refs: [at('/lib/General/Spring budget.xlsx')] })
    const claims = [{}, { asked: true }, { origin: { from: 'window' as const } }, { asked: true, origin: { from: 'act' as const, id: 'h1', digest }, digest }]
    for (const verb of ALL) {
      for (const claim of claims) {
        // In the shared place, into it, and on a file that is shared where it lies in his own place.
        const tries = [
          { verb, from: shared, entry: FILE, ...claim },
          { verb, from: OWN, to: shared, entry: FILE, ...claim },
          { verb, from: OWN, entry: { ...FILE, shared: true }, ...claim }
        ]
        for (const change of tries) {
          let verdict: string
          try {
            verdict = admitWrite(thread(), change)
          } catch {
            verdict = 'refused'
          }
          expect(verdict, `${verb} ${JSON.stringify(claim)}`).not.toBe('run')
        }
      }
    }
    // His own place is his thread's to change once its tools land: the rule above is about what others can open.
    expect(admitWrite(thread(), { verb: 'edit', from: OWN, entry: FILE })).toBe('run')
  })

  it('takes a change from another host of his only with where it began', () => {
    expect(() => admitWrite(peer, { verb: 'rename', from: TEAM, entry: FILE })).toThrow(PEER_NO_ORIGIN)
    expect(() => admitWrite(peer, { verb: 'rename', from: OWN, entry: FILE })).toThrow(PEER_NO_ORIGIN)
    expect(admitWrite(peer, { verb: 'rename', from: TEAM, entry: FILE, origin: { from: 'window' } })).toBe('run')
    // A window's press relayed is still asked its question.
    expect(() => admitWrite(peer, { verb: 'copy', from: OWN, to: TEAM, entry: FILE, origin: { from: 'window' } })).toThrow(ASK_FIRST)
    expect(admitWrite(peer, { verb: 'copy', from: OWN, to: TEAM, entry: FILE, origin: { from: 'window' }, asked: true })).toBe('run')
  })

  it("runs a held act's change only when the act was for exactly this change", () => {
    const refs = [at('/lib/General/Spring budget.xlsx')]
    const digest = changeDigest({ verb: 'move', refs, to: at('/lib/Events') })
    expect(admitWrite(peer, { verb: 'move', from: TEAM, entry: FILE, origin: { from: 'act', id: 'h1', digest }, digest })).toBe('run')
    const other = changeDigest({ verb: 'move', refs, to: at('/lib/General/Budgets') })
    expect(() => admitWrite(peer, { verb: 'move', from: TEAM, entry: FILE, origin: { from: 'act', id: 'h1', digest: other }, digest })).toThrow(PEER_WRONG_ACT)
    expect(() => admitWrite(peer, { verb: 'move', from: TEAM, entry: FILE, origin: { from: 'act', id: 'h1', digest } })).toThrow(PEER_WRONG_ACT)
    expect(changeDigest({ verb: 'rename', refs, name: 'a' })).not.toBe(changeDigest({ verb: 'rename', refs, name: 'b' }))
    expect(changeDigest({ verb: 'trash', refs })).not.toBe(changeDigest({ verb: 'copy', refs }))
  })

  it("says the grammar's own refusal before any caller's row, for every caller", () => {
    const gone = { ...TEAM, state: { state: 'unreachable' as const } }
    for (const by of [window, phone, approver, peer, thread()]) expect(() => admitWrite(by, { verb: 'rename', from: gone, entry: FILE, origin: { from: 'window' } })).toThrow('The box is out of reach.')
    expect(() => admitWrite(window, { verb: 'copy', from: TEAM, to: OWN, entry: FILE, asked: true })).toThrow('Teams files stay in Teams.')
    expect(() => admitWrite(window, { verb: 'trash', from: { ...TEAM, can: ['rename'] }, entry: FILE, asked: true })).toThrow('Delete it in Teams.')
  })
})
