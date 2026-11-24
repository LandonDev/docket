import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import type { FileAct } from '@shared/contract-work-files'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { WorkToolResult } from '@shared/work'
import type { ActKindDef, Caller, ToolCtx, WorkCtx } from '../modules'
import { earnedOf } from '../outbox/earned'
import { ActKinds } from '../outbox/kinds'
import { NOT_EDITABLE, Outbox } from '../outbox/outbox'
import { ensureOutboxTables, HeldStore } from '../outbox/store'
import { filesHandle } from './handle'
import { NEEDS_APPROVE, PEER_WRONG_ACT, setThreadsMayWrite } from './policy'
import { forgetLibraries } from './places/libraries'
import { setRoots } from '../office/files/library'
import { makeRig, peer, WS, type Rig } from './testkit'
import { setSystemBin } from './trash'
import { fileActKind, fileActWords, filesPreamble, filesTools, NO_PLACE_IN_CHAT } from './tools'

/**
 * The agents' side of Files (docs/agents/work-files.md "Agents"): the `files_*` tools by place and caller, the
 * held `file.act` on the real hold (its sentence, its bindings, a press, a press gone stale, a press that runs on
 * another host), the made-by mark and its lens, and what the kind never gets: an edit, a grant, an earned offer.
 */

/** Places named as a thread may: by name (a library's id holds a hash of where it lies). */
const TEAM_GENERAL = 'General'
const TEAM_EVENTS = 'Events'

let rig: Rig
let outbox: Outbox
let whispers: string[]
let results: { sessionId: string; kind: string; summary: string; undo?: { args: unknown } }[]

/** The rig's context with the hold, Results and the host link of a real host. `far` answers a peer call as that host would. */
function workCtx(o: { host?: string; far?: (verb: string, params: unknown) => Promise<unknown> } = {}): WorkCtx {
  const base = { ...rig.ctx, host: o.host ?? rig.ctx.host } as WorkCtx & Record<string, unknown>
  const ctx = Object.assign(base, {
    held: { create: (act: { kind: 'file.act'; sessionId: string | null; payload: unknown }) => outbox.wire(outbox.hold(act).row), onDecided: () => () => {} },
    results: { add: (r: (typeof results)[number]) => void results.push(r) },
    links: { completeFor: async () => {} },
    threads: { resume: async () => {}, start: async () => '', ownerSaid: () => false },
    peer(this: { scope?: unknown }, host: string) {
      if (!this?.scope) throw new Error('ctx.peer is called on a tool\'s own ctx')
      return { call: async (_module: string, verb: string, params: unknown) => (o.far ? o.far(verb, params) : Promise.reject(new Error(`${host} is out of reach`))) }
    }
  })
  return ctx
}

function toolCtx(ctx: WorkCtx, sessionId = 't1', over: Partial<ToolCtx['scope']> = {}): ToolCtx {
  const scope = { ...ctx.scopeOf(sessionId)!, ...over }
  return Object.assign(Object.create(null), ctx, { scope, sessionId, signal: new AbortController().signal }) as ToolCtx
}

async function call(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<WorkToolResult & { text: string }> {
  const tool = filesTools.find((t) => t.name === name)!
  const got = await tool.run(tool.input.parse(args), ctx)
  return { ...got, text: got.content.map((c) => ('text' in c ? c.text : '')).join('\n') }
}

/** The answer of the far host: its own module's handle, as `servePeerWork` runs it for a peer. */
const farBox = (verb: string, params: unknown): Promise<unknown> =>
  filesHandle({ id: 'peer', method: `work.files.${verb}`, params } as unknown as ClientRequest, rig.ctx, peer, undefined).then((a) => (a.handled ? a.result : Promise.reject(new Error('not handled'))))

const press = (item: { ref: OutboxItem['ref'] }): Promise<OutboxItem> => outbox.send(item.ref)

beforeEach(() => {
  rig = makeRig()
  setThreadsMayWrite(true)
  ensureOutboxTables(rig.db)
  rig.db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT)')
  rig.db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run('t1', 'Venue thread')
  whispers = []
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
    whisper: (_id, text) => void whispers.push(text)
  })
})
afterEach(() => {
  setThreadsMayWrite(false)
  rig.close()
})

describe('the places and reads', () => {
  it('lists the places by id with who else can open each, and never a host path', async () => {
    const got = await call('files_places', {}, toolCtx(workCtx()))
    const places = (got.structuredContent as { places: { place: string; name: string; who: string }[] }).places
    expect(places.map((p) => p.place)).toEqual(['folder', expect.stringMatching(/^env_box~\w+\/Events$/), expect.stringMatching(/^env_box~\w+\/General$/), expect.stringMatching(/^env_box~/)])
    expect(places[1]).toMatchObject({ name: 'Esports Staff, Events', who: 'Everyone in Esports Staff can open it.' })
    expect(places[0]).toMatchObject({ name: 'Dummy Esports', who: 'Only the owner and his threads.' })
    expect(got.text).not.toContain(rig.base)
  })

  it('lists a folder and finds a file by name, in words inside the place', async () => {
    const ctx = toolCtx(workCtx())
    const listed = await call('files_list', { place: 'Dummy Esports', path: 'Events' }, ctx)
    expect((listed.structuredContent as { entries: { file: string }[] }).entries.map((e) => e.file)).toEqual(['Events/Spring LAN', 'Events/Poster.png'])
    const found = await call('files_search', { query: 'budget' }, ctx)
    expect((found.structuredContent as { found: { place: string; file: string }[] }).found).toEqual(
      expect.arrayContaining([expect.objectContaining({ place: 'folder', file: 'Budget.xlsx' }), expect.objectContaining({ place: expect.stringMatching(/General$/), file: 'Spring budget.xlsx' })])
    )
    expect(found.text).not.toContain(rig.base)
  })

  it('opens a file beside the thread, by place and path or by its name alone', async () => {
    const ctx = toolCtx(workCtx())
    const byPath = await call('files_open', { place: 'folder', path: 'Events/Spring LAN/Bracket.pdf' }, ctx)
    expect(byPath.isError).toBeFalsy()
    const byName = await call('files_open', { name: 'Poster.png' }, ctx)
    expect(byName.isError).toBeFalsy()
    expect(rig.canvas.list('t1').map((i) => [i.kind, i.title])).toEqual([
      ['pdf', 'Bracket.pdf'],
      ['media', 'Poster.png']
    ])
  })

  it('reaches no place from a Work Chat, and nothing of another workspace', async () => {
    const chat = await call('files_places', {}, toolCtx(workCtx(), 'chat'))
    expect(chat).toMatchObject({ isError: true, text: NO_PLACE_IN_CHAT })
    for (const name of ['files_list', 'files_move', 'files_make']) {
      const got = await call(name, name === 'files_move' ? { place: 'folder', paths: ['notes.txt'], name: 'x.txt' } : name === 'files_make' ? { place: 'folder', kind: 'text' } : { place: 'folder' }, toolCtx(workCtx(), 'chat'))
      expect(got).toMatchObject({ isError: true, text: NO_PLACE_IN_CHAT })
    }
    // A thread of another workspace names its own folder only: this workspace's file is no path of its place.
    const other = await call('files_move', { place: 'folder', paths: ['../Dummy Esports/notes.txt'], name: 'x.txt' }, toolCtx(workCtx(), 't2'))
    expect(other.isError).toBe(true)
    const outside = await call('files_list', { place: 'folder', path: 'way out' }, toolCtx(workCtx()))
    expect(outside.isError).toBe(true)
    expect(existsSync(join(rig.folder, 'notes.txt'))).toBe(true)
  })
})

describe('in his own place a change runs at once, with Undo', () => {
  it('makes a file marked as the thread\'s, listed under Made by threads until he opens it', async () => {
    const got = await call('files_make', { place: 'folder', kind: 'text', name: 'Run sheet' }, toolCtx(workCtx()))
    expect(got.text).toMatch(/^Made Run sheet\.md in Dummy Esports\.\nUndo: files_undo with \{"op": "tool:/)
    expect(existsSync(join(rig.folder, 'Run sheet.md'))).toBe(true)
    const list = (at: unknown) => filesHandle({ id: 'x', method: 'work.files.list', params: { workspaceId: WS, at } } as never, rig.ctx, { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }, undefined).then((a) => (a as { result: { entries: { name: string; madeBy?: string; fresh?: boolean; key: string; ref: unknown }[] } }).result.entries)
    const row = (await list({ at: 'file', host: rig.ctx.host, path: rig.folder })).find((e) => e.name === 'Run sheet.md')!
    expect(row).toMatchObject({ madeBy: 'Venue thread', fresh: true })
    const made = await list({ at: 'place', id: 'made' })
    expect(made).toEqual([expect.objectContaining({ name: 'Run sheet.md', madeBy: 'Venue thread', fresh: true })])
    // His window lists the lens beside Trash; a thread is not given it.
    const places = (by: Caller) => filesHandle({ id: 'x', method: 'work.files.places', params: { workspaceId: WS } } as never, rig.ctx, by, undefined).then((a) => (a as { result: { places: { id: string; name: string }[] } }).result.places.map((p) => p.id))
    expect(await places({ kind: 'local', caps: ['read'] })).toEqual(expect.arrayContaining(['made', 'trash']))
    expect(await places({ kind: 'model', caps: [], sessionId: 't1' })).not.toContain('made')
    // He opens it: no longer new.
    await filesHandle({ id: 'x', method: 'work.files.seen', params: { workspaceId: WS, ref: row.ref, name: row.name } } as never, rig.ctx, { kind: 'local', caps: ['read', 'operate'] }, undefined)
    expect((await list({ at: 'place', id: 'made' }))[0]).toMatchObject({ fresh: false })
    expect(results).toEqual([expect.objectContaining({ sessionId: 't1', kind: 'file.make', summary: 'Made Run sheet.md in Dummy Esports', undo: expect.objectContaining({ verb: 'files_undo' }) })])
  })

  it('moves, renames, copies and trashes, and each Undo puts it back', async () => {
    const ctx = toolCtx(workCtx())
    const opOf = (r: WorkToolResult) => (r.structuredContent as { undo: { op: string } }).undo.op
    const moved = await call('files_move', { place: 'folder', paths: ['notes.txt'], to: { place: 'folder', path: 'Events' } }, ctx)
    expect(moved.text).toMatch(/^Moved Events\/notes\.txt in Dummy Esports, Events\./)
    expect(existsSync(join(rig.folder, 'Events', 'notes.txt'))).toBe(true)
    expect((await call('files_undo', { op: opOf(moved) }, ctx)).text).toBe('Moved back: notes.txt.')
    expect(existsSync(join(rig.folder, 'notes.txt'))).toBe(true)

    const renamed = await call('files_move', { place: 'folder', paths: ['notes.txt'], name: 'kickoff.txt' }, ctx)
    expect(existsSync(join(rig.folder, 'kickoff.txt'))).toBe(true)
    await call('files_undo', { op: opOf(renamed) }, ctx)
    expect(existsSync(join(rig.folder, 'notes.txt'))).toBe(true)

    const copied = await call('files_copy', { place: 'folder', paths: ['notes.txt'], to: { place: 'folder', path: '' } }, ctx)
    expect(existsSync(join(rig.folder, 'notes 2.txt'))).toBe(true)
    await call('files_undo', { op: opOf(copied) }, ctx)
    expect(existsSync(join(rig.folder, 'notes 2.txt'))).toBe(false)

    const trashed = await call('files_trash', { place: 'folder', paths: ['notes.txt'] }, ctx)
    expect(trashed.text).toMatch(/^Put in Trash notes\.txt in Dummy Esports\./)
    expect(existsSync(join(rig.folder, 'notes.txt'))).toBe(false)
    expect((await call('files_undo', { op: opOf(trashed) }, ctx)).text).toBe('Put back: notes.txt.')
    expect(readFileSync(join(rig.folder, 'notes.txt'), 'utf8')).toBe('kickoff at 5')
  })

  it('refuses the Undo as stale when the file is no longer the one the change left', async () => {
    const ctx = toolCtx(workCtx())
    const moved = await call('files_move', { place: 'folder', paths: ['notes.txt'], to: { place: 'folder', path: 'Events' } }, ctx)
    writeFileSync(join(rig.folder, 'Events', 'notes.txt'), 'kickoff moved to 6, and more words')
    const back = await call('files_undo', { op: (moved.structuredContent as { undo: { op: string } }).undo.op }, ctx)
    expect(back).toMatchObject({ isError: true, text: 'notes.txt changed since, so it was left as it is.' })
    expect(existsSync(join(rig.folder, 'Events', 'notes.txt'))).toBe(true)
    // Nobody else's change is undone by its id: only a tool's own.
    expect(await call('files_undo', { op: 'window-op-123' }, ctx)).toMatchObject({ isError: true })
  })

  it("undoes only the calling thread's own change: another thread of the workspace is told it is not one it can undo", async () => {
    rig.scopes.set('t3', { workspaceId: WS })
    const moved = await call('files_move', { place: 'folder', paths: ['notes.txt'], to: { place: 'folder', path: 'Events' } }, toolCtx(workCtx()))
    const op = (moved.structuredContent as { undo: { op: string } }).undo.op
    const other = await call('files_undo', { op }, toolCtx(workCtx(), 't3'))
    expect(other).toMatchObject({ isError: true, text: 'That change is not one this thread can undo: it is unknown here, or older than a week.' })
    expect(existsSync(join(rig.folder, 'Events', 'notes.txt'))).toBe(true)
    expect((await call('files_undo', { op }, toolCtx(workCtx()))).text).toBe('Moved back: notes.txt.')
  })
})

describe('in a place others can open a change is held as a file.act', () => {
  it('holds a move into a channel with one sentence that carries every fact, bound to the file and the folder', async () => {
    const ctx = toolCtx(workCtx())
    const got = await call('files_move', { place: 'folder', paths: ['Budget.xlsx'], to: { place: TEAM_EVENTS, path: '' } }, ctx)
    expect(got.text).toMatch(/^Held as item 1\. It waits for the owner's press: Move Budget\.xlsx to Esports Staff, Events\. Everyone in Esports Staff can open it\./)
    expect(existsSync(join(rig.folder, 'Budget.xlsx'))).toBe(true)
    expect(existsSync(join(rig.team, 'Events', 'Budget.xlsx'))).toBe(false)
    const [item] = outbox.store.list({})
    expect(item).toMatchObject({ kind: 'file.act', state: 'held', workspaceId: WS, sessionId: 't1', verb: 'Move', summary: 'Move Budget.xlsx to Esports Staff, Events. Everyone in Esports Staff can open it.' })
    const p = item!.payload as FileAct
    expect(p).toMatchObject({ workspaceId: WS, host: rig.ctx.host, verb: 'move', things: [{ name: 'Budget.xlsx', version: expect.stringMatching(/^1200:\d+:$/) }], into: { place: expect.stringMatching(/Events$/), key: expect.any(String) }, audience: 'Everyone in Esports Staff can open it.' })
    expect(p.request.to).toEqual({ at: 'file', host: rig.ctx.host, path: join(rig.team, 'Events') })
    // No results row: nothing was done.
    expect(results).toEqual([])
  })

  it('holds every verb in a shared place whatever the thread says, and refuses a delete there', async () => {
    const ctx = toolCtx(workCtx())
    const held = [
      await call('files_make', { place: TEAM_GENERAL, kind: 'text', name: 'Agenda' }, ctx),
      await call('files_move', { place: TEAM_GENERAL, paths: ['Plan.docx'], name: 'Plan v2.docx' }, ctx),
      await call('files_move', { place: TEAM_GENERAL, paths: ['Plan.docx'], to: { place: TEAM_GENERAL, path: 'Budgets' } }, ctx),
      await call('files_copy', { place: TEAM_GENERAL, paths: ['Plan.docx'], to: { place: TEAM_GENERAL, path: 'Budgets' } }, ctx),
      await call('files_copy', { place: 'folder', paths: ['notes.txt'], to: { place: 'My OneDrive', path: '' } }, ctx)
    ]
    for (const got of held) expect(got.text).toMatch(/^Held as item \d+\. It waits for the owner's press: /)
    expect(outbox.store.list({}).map((r) => r.summary)).toEqual([
      'Make Agenda.txt in Esports Staff, General. Everyone in Esports Staff can open it.',
      'Rename Plan.docx to Plan v2.docx in Esports Staff, General. Everyone in Esports Staff can open it.',
      'Move Plan.docx to Esports Staff, General, Budgets. Everyone in Esports Staff can open it.',
      'Copy Plan.docx to Esports Staff, General, Budgets. Everyone in Esports Staff can open it.',
      'Copy notes.txt to My OneDrive. Whoever you shared My OneDrive with can open it.'
    ])
    expect(existsSync(join(rig.team, 'General', 'Agenda.txt'))).toBe(false)
    expect(existsSync(join(rig.team, 'General', 'Plan.docx'))).toBe(true)
    // A delete there is held too: nothing goes until his press.
    const deleted = await call('files_trash', { place: TEAM_GENERAL, paths: ['Plan.docx'] }, ctx)
    expect(deleted.text).toMatch(/^Held as item \d+\. It waits for the owner's press: /)
    expect(outbox.store.list({}).at(-1)!.summary).toBe('Delete Plan.docx from Esports Staff, General. Everyone in Esports Staff can open it.')
    expect(existsSync(join(rig.team, 'General', 'Plan.docx'))).toBe(true)
    const out = await call('files_move', { place: TEAM_GENERAL, paths: ['Plan.docx'], to: { place: 'folder', path: '' } }, ctx)
    expect(out).toMatchObject({ isError: true, text: 'Teams files stay in Teams.' })
  })

  it('holds every change in a workspace kept in OneDrive, and in a library reached inside its folder, and runs it on his press', async () => {
    // His workspace's own folder lies in his OneDrive: whoever he shared it with sees what changes there.
    const synced = join(rig.mine, 'Esports Ops')
    mkdirSync(join(synced, 'Archive'), { recursive: true })
    writeFileSync(join(synced, 'Plan.docx'), 'word')
    rig.db.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(synced, WS)
    const ctx = toolCtx(workCtx())
    const held = [
      await call('files_make', { place: 'folder', kind: 'text', name: 'Agenda' }, ctx),
      await call('files_move', { place: 'folder', paths: ['Plan.docx'], to: { place: 'folder', path: 'Archive' } }, ctx),
      await call('files_copy', { place: 'folder', paths: ['Plan.docx'], to: { place: 'folder', path: 'Archive' } }, ctx),
      await call('files_move', { place: 'folder', paths: ['Plan.docx'], name: 'Plan v2.docx' }, ctx)
    ]
    for (const got of held) expect(got.text).toMatch(/^Held as item \d+\. It waits for the owner's press: /)
    expect(readdirSync(synced).sort()).toEqual(['Archive', 'Plan.docx'])
    expect(existsSync(join(synced, 'Archive', 'Plan.docx'))).toBe(false)
    expect(existsSync(join(synced, 'Plan v2.docx'))).toBe(false)
    expect(results).toEqual([])
    // His press runs the move as his window's change: no question, no second hold.
    const move = outbox.store.list({})[1]!
    expect(await press({ ref: { at: 'host', id: move.id } })).toMatchObject({ state: 'sent', result: { summary: 'Moved: Plan.docx.' } })
    expect(existsSync(join(synced, 'Archive', 'Plan.docx'))).toBe(true)
    // His own window changes it at once, and a key changes it only with approve, as in a library.
    const verb = (by: Caller, name: string) => filesHandle({ id: 'x', method: 'work.files.make', params: { workspaceId: WS, op: `op-${name}`, at: { at: 'place', id: 'folder' }, kind: 'text', name } } as never, rig.ctx, by, undefined)
    rig.roots.splice(0, rig.roots.length, synced)
    await expect(verb({ kind: 'remote', caps: ['read', 'operate'] }, 'Phone note')).rejects.toThrow(NEEDS_APPROVE)
    await verb({ kind: 'remote', caps: ['read', 'operate', 'approve'] }, 'Approved note')
    await verb({ kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }, 'Window note')
    expect(readdirSync(synced).filter((n) => n.endsWith(' note.md')).sort()).toEqual(['Approved note.md', 'Window note.md'])

    // A library he added that lies inside a private workspace's folder is the library's, reached either way.
    rig.db.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(rig.folder, WS)
    mkdirSync(join(rig.folder, 'Team share'))
    setRoots(rig.db, [{ folder: join(rig.folder, 'Team share') }])
    forgetLibraries(rig.db)
    const inside = await call('files_make', { place: 'folder', path: 'Team share', kind: 'text', name: 'Inside' }, ctx)
    expect(inside.text).toMatch(/^Held as item \d+\./)
    expect(readdirSync(join(rig.folder, 'Team share'))).toEqual([])
    // The rest of his own folder still runs at once.
    expect((await call('files_make', { place: 'folder', kind: 'text', name: 'Mine' }, ctx)).text).toMatch(/^Made Mine\.md in Dummy Esports\./)
  })

  it('runs the held act on his press as his window\'s change, once', async () => {
    const ctx = toolCtx(workCtx())
    await call('files_move', { place: 'folder', paths: ['Budget.xlsx'], to: { place: TEAM_EVENTS, path: '' } }, ctx)
    const [row] = outbox.store.list({})
    const sent = await press({ ref: { at: 'host', id: row!.id } })
    expect(sent).toMatchObject({ state: 'sent', result: { summary: 'Moved: Budget.xlsx.' } })
    expect(existsSync(join(rig.team, 'Events', 'Budget.xlsx'))).toBe(true)
    expect(existsSync(join(rig.folder, 'Budget.xlsx'))).toBe(false)
    expect(whispers).toEqual(['The owner sent held item 1 (Move Budget.xlsx to Esports Staff, Events. Everyone in Esports Staff can open it.).'])
    // A second press runs nothing.
    expect(await press({ ref: { at: 'host', id: row!.id } })).toMatchObject({ state: 'sent' })
  })

  it("sends a thread's held delete to the computer's own bin on his press, once", async () => {
    const binned: string[] = []
    setSystemBin({
      async put(path) {
        binned.push(path)
        rmSync(path, { recursive: true })
        return null
      }
    })
    try {
      await call('files_trash', { place: TEAM_GENERAL, paths: ['Plan.docx'] }, toolCtx(workCtx()))
      const [row] = outbox.store.list({})
      expect(existsSync(join(rig.team, 'General', 'Plan.docx'))).toBe(true)
      expect(await press({ ref: { at: 'host', id: row!.id } })).toMatchObject({ state: 'sent', result: { summary: 'Deleted: Plan.docx.' } })
      expect(binned).toEqual([join(rig.team, 'General', 'Plan.docx')])
      expect(await press({ ref: { at: 'host', id: row!.id } })).toMatchObject({ state: 'sent' })
      expect(binned).toHaveLength(1)
    } finally {
      setSystemBin(null)
    }
  })

  it('marks a file a held make made, once he pressed', async () => {
    await call('files_make', { place: TEAM_GENERAL, kind: 'text', name: 'Agenda' }, toolCtx(workCtx()))
    const [row] = outbox.store.list({})
    expect(await press({ ref: { at: 'host', id: row!.id } })).toMatchObject({ state: 'sent' })
    expect(existsSync(join(rig.team, 'General', 'Agenda.txt'))).toBe(true)
    const made = await filesHandle({ id: 'x', method: 'work.files.list', params: { workspaceId: WS, at: { at: 'place', id: 'made' } } } as never, rig.ctx, { kind: 'local', caps: ['read'] }, undefined)
    expect((made as { result: { entries: unknown[] } }).result.entries).toEqual([expect.objectContaining({ name: 'Agenda.txt', madeBy: 'Venue thread' })])
  })

  it('does nothing on a press gone stale: the file changed, the file moved, the folder gone, the thread moved', async () => {
    const ctx = toolCtx(workCtx())
    const holdMove = async (): Promise<string> => {
      await call('files_move', { place: 'folder', paths: ['Budget.xlsx'], to: { place: TEAM_GENERAL, path: 'Budgets' } }, ctx)
      return outbox.store.list({}).at(-1)!.id
    }
    // the file changed
    let id = await holdMove()
    writeFileSync(join(rig.folder, 'Budget.xlsx'), 'a different workbook')
    expect(await press({ ref: { at: 'host', id } })).toMatchObject({ state: 'stale', error: 'Budget.xlsx changed since this was held, so nothing was done. Ask the thread again if it is still wanted.' })
    // the file moved
    id = await holdMove()
    renameSync(join(rig.folder, 'Budget.xlsx'), join(rig.folder, 'Events', 'Budget.xlsx'))
    expect(await press({ ref: { at: 'host', id } })).toMatchObject({ state: 'stale', error: 'Budget.xlsx is no longer where it was, so nothing was done.' })
    renameSync(join(rig.folder, 'Events', 'Budget.xlsx'), join(rig.folder, 'Budget.xlsx'))
    // the folder it was to go in is gone
    id = await holdMove()
    rmSync(join(rig.team, 'General', 'Budgets'), { recursive: true })
    expect(await press({ ref: { at: 'host', id } })).toMatchObject({ state: 'stale', error: 'The folder Budgets is gone or moved, so nothing was done.' })
    mkdirSync(join(rig.team, 'General', 'Budgets'))
    // the thread was carried to another workspace (a history import, a move)
    id = await holdMove()
    rig.scopes.set('t1', { workspaceId: 'w2' })
    expect(await press({ ref: { at: 'host', id } })).toMatchObject({ state: 'stale', error: 'The thread that asked for this is no longer in that workspace, so nothing was done.' })
    expect(existsSync(join(rig.folder, 'Budget.xlsx'))).toBe(true)
    expect(existsSync(join(rig.team, 'General', 'Budgets', 'Budget.xlsx'))).toBe(false)
  })

  it('takes no edit, no grant and no earned offer, and Away presses nothing', async () => {
    const away = toolCtx(workCtx(), 't1', { away: true })
    await call('files_move', { place: TEAM_GENERAL, paths: ['Plan.docx'], name: 'Plan v2.docx' }, away)
    const [row] = outbox.store.list({})
    expect(row).toMatchObject({ state: 'held' })
    expect(existsSync(join(rig.team, 'General', 'Plan.docx'))).toBe(true)
    const ref = { at: 'host' as const, id: row!.id }
    await expect(outbox.edit(ref, { ...(row!.payload as object), request: { refs: [], name: 'Other.docx' } })).rejects.toThrow(NOT_EDITABLE)
    await expect(outbox.grant(ref, {})).rejects.toThrow('file.act is always held; no grant can be made for it')
    expect(earnedOf('file.act', row!.payload)).toBeNull()
    expect(fileActKind.matcher).toBeUndefined()
  })

  it('runs a held act on the file\'s own host with the origin that host needs, and that host refuses any other change under it', async () => {
    // The thread runs on a Mac whose workspace may use the box; the library is the box's.
    rig.settings.set(WS, { mayUseDesktop: [rig.ctx.host] })
    const mac = workCtx({ host: 'env_mac', far: farBox })
    const ctx = toolCtx(mac)
    const got = await call('files_move', { place: TEAM_GENERAL, host: rig.ctx.host, paths: ['Spring budget.xlsx'], to: { place: TEAM_GENERAL, path: 'Budgets' } }, ctx)
    expect(got.text).toMatch(/^Held as item 1\. It waits for the owner's press: Move Spring budget\.xlsx to Esports Staff, General, Budgets\./)
    const [row] = outbox.store.list({})
    const p = row!.payload as FileAct
    expect(p.host).toBe(rig.ctx.host)
    // The box refuses the same change under the act's id with another digest, and with no origin at all.
    await expect(farBox('move', { workspaceId: WS, refs: p.request.refs, to: p.request.to, op: 'act:forged-1', origin: { from: 'act', id: row!.id, digest: 'f'.repeat(64) } })).rejects.toThrow(PEER_WRONG_ACT)
    await expect(farBox('move', { workspaceId: WS, refs: p.request.refs, to: p.request.to, op: 'act:forged-2' })).rejects.toThrow('must say where it began')
    expect(existsSync(join(rig.team, 'General', 'Spring budget.xlsx'))).toBe(true)
    // His press on the Mac carries it out on the box.
    const macOutbox = new Outbox({ ctx: mac, store: outbox.store, kinds: new ActKinds(() => [{ id: 'files', ensure() {}, acts: [fileActKind as ActKindDef] }]), scopeKeyOf: () => WS, routineOf: () => null, rootOf: (id) => id, routineRunOf: () => null, whisper: () => {} })
    expect(await macOutbox.send({ at: 'host', id: row!.id })).toMatchObject({ state: 'sent' })
    expect(existsSync(join(rig.team, 'General', 'Budgets', 'Spring budget.xlsx'))).toBe(true)
    expect(existsSync(join(rig.team, 'General', 'Spring budget.xlsx'))).toBe(false)
  })
})

describe('the words', () => {
  it('says each verb in one sentence, a phone drawing only the summary included', () => {
    const base = { things: [{ key: 'k', name: 'Spring budget.xlsx', version: '1:1:' }], from: { place: 'p', name: 'Esports Staff, General', trail: [] }, audience: 'Everyone in Esports Staff can open it.' }
    expect(fileActWords({ ...base, verb: 'move', request: { refs: [] as never }, into: { place: 'e', name: 'Esports Staff, Events', trail: [], key: 'e' } })).toEqual({ summary: 'Move Spring budget.xlsx to Esports Staff, Events. Everyone in Esports Staff can open it.', verb: 'Move' })
    expect(fileActWords({ ...base, verb: 'copy', things: [...base.things, { key: 'a', name: 'A.docx', version: '' }, { key: 'b', name: 'B.docx', version: '' }], request: { refs: [] as never }, into: { place: 'e', name: 'Esports Staff, Events', trail: ['2026'], key: 'e' } }).summary).toBe('Copy Spring budget.xlsx, A.docx and 1 more to Esports Staff, Events, 2026. Everyone in Esports Staff can open it.')
  })

  it('tells a workspace thread how files in shared places are changed, and a Work Chat nothing', () => {
    expect(filesPreamble({ workspaceId: WS })).toMatch(/files_\* tools.*held for the owner's press/)
    expect(filesPreamble({ workspaceId: null })).toBeNull()
  })
})
