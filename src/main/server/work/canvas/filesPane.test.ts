import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasPush } from '@shared/contract-work-canvas'
import { filesPaneOf, filesPaneWorkspace, mailPaneOf, paneWorkspace, type CanvasSource } from '@shared/work'
import { SEATS_FULL } from '@shared/work/files'
import type { PushTo } from '../modules'
import { CANVAS_OPEN_MAX, canvasItemDir, CanvasStore, ensureCanvasTables, fencedItem } from './store'

/** The Files place's pane as an owner of canvas items (docs/agents/work-files.md "A tab"): a file open in a tab with no thread. */

let dir: string
let db: DatabaseSync
let store: CanvasStore
let pushes: { p: CanvasPush; to?: PushTo }[]
let removed: string[][]
const PANE = filesPaneOf('w1')
const file = (path: string): CanvasSource => ({ at: 'file', host: 'env_test', path })
const threads = new Map([['t1', { id: 't1', workspaceId: 'w1', scope: 'work' as const, parentId: null }]])

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-files-pane-'))
  db = new DatabaseSync(':memory:')
  ensureCanvasTables(db)
  pushes = []
  removed = []
  store = new CanvasStore({
    db,
    dataDir: dir,
    session: (id) => threads.get(id) ?? null,
    workWorkspace: (id) => id === 'w1',
    push: (p, to) => void pushes.push({ p, to }),
    remoteReaches: (path) => path.startsWith(join(dir, 'shared')),
    itemsRemoved: (ids) => void removed.push(ids),
    log: () => {}
  })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the owner', () => {
  it('is named for its workspace, apart from the Mail pane and from a thread', () => {
    expect(filesPaneWorkspace(PANE)).toBe('w1')
    expect(filesPaneWorkspace(mailPaneOf('w1'))).toBeNull()
    expect(filesPaneWorkspace('filespane_')).toBeNull()
    expect(filesPaneWorkspace('t1')).toBeNull()
    expect(paneWorkspace(PANE)).toBe('w1')
    expect(paneWorkspace(mailPaneOf('w9'))).toBe('w9')
    expect(paneWorkspace('t1')).toBeNull()
  })

  it('owns items for a Work workspace of this host, with no thread made', () => {
    const item = store.open(PANE, { kind: 'sheet', source: file('/w/Budget.xlsx'), title: 'Budget.xlsx' })
    expect(item).toMatchObject({ sessionId: PANE, workspaceId: 'w1', kind: 'sheet', state: 'open', position: 0 })
    expect(store.list(PANE).map((i) => i.id)).toEqual([item.id])
    // The same file again is the same item: a tab is never there twice.
    expect(store.open(PANE, { kind: 'sheet', source: file('/w/Budget.xlsx'), title: 'Budget.xlsx' }).id).toBe(item.id)
  })

  it('owns nothing for a workspace this host does not have', () => {
    expect(() => store.open(filesPaneOf('nope'), { kind: 'pdf', source: file('/a.pdf'), title: 'A' })).toThrow('not a Work workspace: nope')
    expect(() => store.reorder(filesPaneOf('nope'), [])).toThrow('unknown thread')
  })

  it('reorders its items as a thread does', () => {
    const a = store.open(PANE, { kind: 'pdf', source: file('/a.pdf'), title: 'A' })
    const b = store.open(PANE, { kind: 'pdf', source: file('/b.pdf'), title: 'B' })
    expect(store.reorder(PANE, [b.id, a.id]).map((i) => i.id)).toEqual([b.id, a.id])
  })

  it(`refuses the ${CANVAS_OPEN_MAX + 1}th open in the Files place's own sentence, and a thread's in its own`, () => {
    for (let i = 0; i < CANVAS_OPEN_MAX; i++) store.open(PANE, { kind: 'pdf', source: file(`/f${i}.pdf`), title: `F${i}` })
    expect(() => store.open(PANE, { kind: 'pdf', source: file('/one-more.pdf'), title: 'One more' })).toThrow(SEATS_FULL)
    expect(SEATS_FULL).toBe('32 files are open. Close one to open another.')
    // Nothing was closed for him.
    expect(store.list(PANE)).toHaveLength(CANVAS_OPEN_MAX)
    for (let i = 0; i < CANVAS_OPEN_MAX; i++) store.open('t1', { kind: 'pdf', source: file(`/f${i}.pdf`), title: `F${i}` })
    expect(() => store.open('t1', { kind: 'pdf', source: file('/one-more.pdf'), title: 'One more' })).toThrow('This thread already has 32 items open')
  })
})

describe('closing a tab', () => {
  it('deletes the item, its folder and what every pillar kept for it; a thread\'s close keeps its row', () => {
    const made = store.open(PANE, { kind: 'form', source: { at: 'thread' }, title: 'Sign-up' })
    const folder = canvasItemDir(dir, PANE, made.id)
    writeFileSync(join(folder, 'form.json'), '{}')
    const kept = store.open(PANE, { kind: 'pdf', source: file('/a.pdf'), title: 'A' })
    pushes.length = 0
    store.close(made.id)
    expect(store.get(made.id)).toBeNull()
    expect(existsSync(folder)).toBe(false)
    expect(removed).toEqual([[made.id]])
    expect(db.prepare('SELECT count(*) AS n FROM work_canvas_items').get()).toEqual({ n: 1 })
    // One push of the pane's list, without the item (said twice over: this host's own, and the cut one for remote keys).
    expect(pushes.filter(({ to }) => to?.only !== 'remote').map(({ p }) => p.push === 'work.canvas' && p.items.map((i) => i.id))).toEqual([[kept.id]])

    const of = store.open('t1', { kind: 'pdf', source: file('/a.pdf'), title: 'A' })
    store.close(of.id)
    expect(store.get(of.id)).toMatchObject({ state: 'closed' })
    expect(removed).toHaveLength(1)
  })

  it('closing a tab that is already gone is nothing, and one pillar\'s fault never keeps the row', () => {
    const item = store.open(PANE, { kind: 'pdf', source: file('/a.pdf'), title: 'A' })
    store.remove([item.id, 'no-such-item'])
    store.remove([item.id])
    expect(removed).toEqual([[item.id]])
    const failing = new CanvasStore({ db, dataDir: dir, session: () => null, workWorkspace: () => true, push: () => {}, itemsRemoved: () => { throw new Error('a pillar broke') }, log: () => {} })
    const next = failing.open(PANE, { kind: 'pdf', source: file('/b.pdf'), title: 'B' })
    failing.close(next.id)
    expect(failing.get(next.id)).toBeNull()
  })
})

describe('a change inside a caller\'s transaction', () => {
  // Files a remote key may name too, so each announcement is one push.
  const near = (name: string): CanvasSource => file(join(dir, 'shared', name))

  it('holds every push until the caller has returned, then says each owner once, naming the item opened', () => {
    const out = store.inside(() => {
      const a = store.open(PANE, { kind: 'pdf', source: near('a.pdf'), title: 'A' })
      const b = store.open(PANE, { kind: 'pdf', source: near('b.pdf'), title: 'B' })
      store.close(a.id)
      expect(pushes).toEqual([])
      return b
    })
    expect(pushes).toHaveLength(1)
    expect(pushes[0].p).toMatchObject({ push: 'work.canvas', sessionId: PANE, opened: out.id })
    expect((pushes[0].p as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([out.id])
  })

  it('says nothing when the caller throws: what it rolled back was never announced', () => {
    db.exec('SAVEPOINT tab')
    expect(() =>
      store.inside(() => {
        store.open(PANE, { kind: 'pdf', source: near('a.pdf'), title: 'A' })
        throw new Error('the tab row could not be written')
      })
    ).toThrow('the tab row could not be written')
    db.exec('ROLLBACK TO tab')
    db.exec('RELEASE tab')
    expect(pushes).toEqual([])
    expect(store.list(PANE)).toEqual([])
    // And the store announces again afterwards.
    store.open(PANE, { kind: 'pdf', source: near('b.pdf'), title: 'B' })
    expect(pushes).toHaveLength(1)
  })
})

describe("a workspace's threads' items", () => {
  it('leaves every pane owner out in the query, before its limit, and lists them only when asked', () => {
    const mine = store.open('t1', { kind: 'pdf', source: file('/thread.pdf'), title: 'Thread' })
    for (let i = 0; i < 5; i++) store.open(PANE, { kind: 'pdf', source: file(`/tab${i}.pdf`), title: `Tab ${i}` })
    store.open(mailPaneOf('w1'), { kind: 'pdf', source: { at: 'mail', threadId: 't', messageId: 'm', partId: 'p', name: 'a.pdf' }, title: 'a.pdf' })
    // Six newer pane rows do not push the thread's one item out of a list of two.
    expect(store.forWorkspace('w1', { most: 2 }).map((i) => i.id)).toEqual([mine.id])
    expect(store.forWorkspace('w1', { open: true }).map((i) => i.sessionId)).toEqual(['t1'])
    expect(store.forWorkspace('w1', { panes: true })).toHaveLength(7)
  })

  it('reads an owner whose id only looks like a pane prefix as a thread', () => {
    // `_` is any one character in a LIKE unless escaped: "filespaneXw1" must not be taken for a pane.
    threads.set('filespaneXw1', { id: 'filespaneXw1', workspaceId: 'w1', scope: 'work', parentId: null })
    const item = store.open('filespaneXw1', { kind: 'pdf', source: file('/a.pdf'), title: 'A' })
    expect(store.forWorkspace('w1').map((i) => i.id)).toEqual([item.id])
    threads.delete('filespaneXw1')
  })
})

describe('a deleted workspace', () => {
  it("drops its panes' rows and folders and tells every pillar of their items", () => {
    const tab = store.open(PANE, { kind: 'form', source: { at: 'thread' }, title: 'Form' })
    const att = store.open(mailPaneOf('w1'), { kind: 'pdf', source: { at: 'mail', threadId: 't', messageId: 'm', partId: 'p', name: 'a.pdf' }, title: 'a.pdf' })
    mkdirSync(join(dir, 'canvas', mailPaneOf('w1'), att.id), { recursive: true })
    const other = store.open('t1', { kind: 'pdf', source: file('/a.pdf'), title: 'A' })
    store.removePanes([mailPaneOf('w1'), filesPaneOf('w1')])
    expect(removed).toEqual([[att.id, tab.id]])
    expect(existsSync(join(dir, 'canvas', PANE))).toBe(false)
    expect(existsSync(join(dir, 'canvas', mailPaneOf('w1')))).toBe(false)
    expect(store.forWorkspace('w1', { panes: true }).map((i) => i.id)).toEqual([other.id])
  })
})

describe('what a remote key sees of a tab', () => {
  it("cuts a file out of its reach to nothing: no path, no name, no title; a thread's item keeps its name", () => {
    const far = store.open(PANE, { kind: 'sheet', source: { at: 'microsoft', host: 'env_test', app: 'excel', name: 'Salaries.xlsx', ref: { kind: 'path', path: '/Users/l/CloudStorage/HR/Salaries.xlsx' } }, title: 'Salaries.xlsx' })
    const near = store.open(PANE, { kind: 'pdf', source: file(join(dir, 'shared', 'w9.pdf')), title: 'w9.pdf' })
    const reaches = (path: string): boolean => path.startsWith(join(dir, 'shared'))
    const cut = fencedItem(far, reaches)
    expect(cut).toMatchObject({ title: '', source: { at: 'microsoft', name: '', ref: { kind: 'path', path: '' } } })
    expect(JSON.stringify(cut)).not.toContain('Salaries')
    expect(fencedItem(near, reaches)).toBe(near)
    const mine = store.open('t1', { kind: 'pdf', source: file('/Users/l/Private/offer.pdf'), title: 'Offer' })
    expect(fencedItem(mine, reaches)).toMatchObject({ title: 'Offer', source: { path: 'offer.pdf' } })
    // The push to remote keys carries the cut list.
    const remote = pushes.filter(({ to }) => to?.only === 'remote').at(-2)!
    expect(JSON.stringify(remote.p)).not.toContain('Salaries')
  })
})
