import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MentionHit, MentionReach } from '@shared/work'
import type { SearchReach } from '@shared/work/search'
import { canvasMentions } from '../canvas/mentions'
import { CanvasStore, ensureCanvasTables, setCanvasStore } from '../canvas/store'
import type { MentionSource, WorkCtx, WorkModule } from '../modules'
import { bridged, mentionBridge } from './mentions'
import { runSearch } from './run'
import { COSMIC, everywhere, jobs, makeRig, onlyPurdue, PURDUE, thread, window } from './testkit'

/** A pillar with `mentions` and no `search` is found through them: asked once a job, each hit stamped with its job and opened as its chip. */

const ask = (reach: SearchReach, limit = 4) => ({ text: 'reply', reach, limit, by: window, signal: new AbortController().signal })
const held = (id: string, label: string): MentionHit => ({ chip: { kind: 'held', label, ref: { at: 'work', pillar: 'outbox', id } }, detail: 'Send' })

/** A mention source that answers by the workspace it is asked for, and records every reach it saw. */
function fakeMention(byPlace: Record<string, MentionHit[]>, over: Partial<MentionSource> = {}): MentionSource & { seen: MentionReach[] } {
  const seen: MentionReach[] = []
  return {
    kind: 'held',
    seen,
    async search(_text, reach) {
      seen.push(reach)
      return byPlace[String(reach.workspaceId)] ?? []
    },
    ...over
  }
}

describe('the mention bridge', () => {
  it('asks a mention source once a job in reach and stamps each hit with that job', async () => {
    const mention = fakeMention({ [PURDUE]: [held('h1', 'Reply to Dana')], [COSMIC]: [held('h2', 'Reply to Sam')], null: [held('h3', 'Reply from a chat')] })
    const hits = await bridged(mention).search(ask(everywhere), {} as WorkCtx)
    expect(hits.map((h) => [h.title, h.workspaceId])).toEqual([
      ['Reply to Dana', PURDUE],
      ['Reply to Sam', COSMIC],
      ['Reply from a chat', null]
    ])
    expect(mention.seen.map((r) => [r.workspaceId, r.sectors])).toEqual([
      [PURDUE, ['purdue']],
      [COSMIC, ['cosmic']],
      ['ws-bare', []],
      [null, []]
    ])
    expect(mention.seen.every((r) => r.work && r.sessionId === null)).toBe(true)
  })
  it('opens a hit as its chip, keyed by the thing the chip names', async () => {
    const [hit] = await bridged(fakeMention({ [PURDUE]: [held('h1', 'Reply to Dana')] })).search(ask(onlyPurdue), {} as WorkCtx)
    expect(hit).toMatchObject({ key: 'work:outbox:h1', kind: 'held', detail: 'Send', open: { to: 'chip', chip: { kind: 'held', label: 'Reply to Dana' } }, chip: { kind: 'held' } })
  })
  it('takes a turn a job, so one job never fills the group before another is seen', async () => {
    const many = (prefix: string) => Array.from({ length: 5 }, (_, i) => held(`${prefix}${i}`, `${prefix}${i}`))
    const hits = await bridged(fakeMention({ [PURDUE]: many('p'), [COSMIC]: many('c') })).search(ask(everywhere, 4), {} as WorkCtx)
    expect(hits.map((h) => h.title)).toEqual(['p0', 'c0', 'p1', 'c1', 'p2'])
  })
  it("hands a thread's own id only to its own job, and to Work Chats for a Work Chat", async () => {
    const inJob = fakeMention({})
    await bridged(inJob).search(ask({ workspaces: [jobs[0]], chats: false, sessionId: 't1' }), {} as WorkCtx)
    expect(inJob.seen.map((r) => [r.workspaceId, r.sessionId])).toEqual([[PURDUE, 't1']])
    const inChat = fakeMention({})
    await bridged(inChat).search(ask({ workspaces: jobs, chats: true, sessionId: 'c1' }), {} as WorkCtx)
    expect(inChat.seen.map((r) => [r.workspaceId, r.sessionId])).toEqual([
      [PURDUE, null],
      [COSMIC, null],
      ['ws-bare', null],
      [null, 'c1']
    ])
  })
  it('bridges only the kinds no search source covers, one source a kind, a LifeOS kind over the network', () => {
    const modules: WorkModule[] = [
      { id: 'lifeos', ensure() {}, mentions: [fakeMention({}, { kind: 'task', lifeos: true }), fakeMention({}, { kind: 'mail', lifeos: true })] },
      { id: 'outbox', ensure() {}, mentions: [fakeMention({}), fakeMention({})] }
    ]
    const bridge = mentionBridge(modules, new Set(['mail']))
    expect(bridge.map((b) => [b.pillar, b.source.kind, b.source.tier, b.source.lifeos ?? false])).toEqual([
      ['lifeos', 'task', 'network', true],
      ['outbox', 'held', 'instant', false]
    ])
  })
})

describe("the canvas's own item source, through the bridge", () => {
  it("finds a thread's own pane's items for the thread, and none for his window", async () => {
    const rig = makeRig()
    ensureCanvasTables(rig.db)
    const sessions: Record<string, { id: string; workspaceId: string | null; scope: 'work'; parentId: null }> = { t1: { id: 't1', workspaceId: PURDUE, scope: 'work', parentId: null } }
    const store = new CanvasStore({ db: rig.db, dataDir: mkdtempSync(join(tmpdir(), 'tc-search-')), session: (id: string) => sessions[id] ?? null, push: () => {}, log: () => {} } as never)
    setCanvasStore(rig.db, store)
    store.open('t1', { kind: 'sheet', source: { at: 'file', host: 'h', path: '/w/budget.xlsx' }, title: 'Budget' })
    const ctx = { ...rig.ctx, canvas: { paneOf: (id: string) => id } } as unknown as WorkCtx
    const modules: WorkModule[] = [{ id: 'canvas', ensure() {}, mentions: canvasMentions }]
    const forThread = await runSearch(ctx, { modules, own: [], reach: { workspaces: [jobs[0]], chats: false, sessionId: 't1' }, text: 'budget', by: thread('t1') })
    expect(forThread.groups.map((g) => [g.source, g.label])).toEqual([['canvas.item', 'Items']])
    expect(forThread.groups[0].hits[0]).toMatchObject({ title: 'Budget', detail: 'Sheet', workspaceId: PURDUE, open: { to: 'chip' } })
    const forWindow = await runSearch(ctx, { modules, own: [], reach: everywhere, text: 'budget', by: window })
    expect(forWindow.groups).toEqual([])
  })
})
