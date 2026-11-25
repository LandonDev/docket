import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createCollabSigner, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE, type CollabSigner } from 'work-kit/collab-server'
import { guestCells, moveThrough, refusal } from '../../sheets/host/live'
import type { ServiceLink } from '../wire'
import type { RouteCtx } from './route'
import { hostOf } from './internalSheet'
import { sheetRoute } from './sheet'

/**
 * The live sheet route over a real socket: a LifeOS sheet kept by a fake
 * Convex in memory, tokens signed by a key the route trusts.
 */

const ops: { rev: number; by: string; at: number; mutations: string }[] = []
/** What agents propose, as LifeOS keeps it: rows beside the sheet, never ops. */
const suggested: { _id: string; changeSetId: string; by: string; sheet: string; row: number; col: number; base: string | null; proposed: string | null; state: string }[] = []
const convex = async (_kind: string, fn: string, args: Record<string, unknown>): Promise<unknown> => {
  switch (fn) {
    case 'sheets:get':
      return { _id: args.id, title: 'Budget', sector: 'cosmic', rev: ops.at(-1)?.rev ?? 0, snapshotRev: 0, shared: true, snapshotUrl: null }
    case 'sheets:ops':
      return ops.filter((o) => o.rev > (args.after as number))
    case 'sheets:appendOps': {
      const rev = ops.at(-1)?.rev ?? 0
      if (args.baseRev !== rev) throw Object.assign(new Error('stale'), { data: { code: 'stale-rev', rev } })
      for (const o of args.ops as { by: string; mutations: string }[]) ops.push({ rev: (ops.at(-1)?.rev ?? 0) + 1, by: o.by, at: 1, mutations: o.mutations })
      return { rev: ops.at(-1)!.rev }
    }
    case 'sheets:suggestions':
      return suggested.filter((c) => c.state === args.state)
    case 'sheets:suggest':
      for (const c of args.cells as { sheet: string; row: number; col: number; base: string | null; proposed: string | null }[]) suggested.push({ _id: `sg${suggested.length}`, changeSetId: args.changeSetId as string, by: args.by as string, ...c, state: 'pending' })
      return null
  }
  throw new Error(`unexpected ${fn}`)
}

const links = new Map<string, ServiceLink>()
let server: Server
let port: number
let signer: CollabSigner
let routeCtx: RouteCtx
beforeAll(async () => {
  const keys = await generateCollabKeys('k1')
  signer = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:test' })
  const wss = new WebSocketServer({ noServer: true })
  const ctx = {
    config: () => ({ owner: 'Landon Hale', lifeos: { here: true, host: null }, trusted: [{ by: 'host', iss: 'tempcode:test', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }] }),
    mark: 'mark-of-this-run',
    convex,
    links: () => links,
    // As the service answers it for a document's or a sheet's own link: the link stands.
    claimLive: (c: { link?: string }) => {
      const link = c.link ? links.get(c.link) : undefined
      return !c.link || (!!link && !link.revokedAt && !(link.expiresAt && link.expiresAt <= Date.now()))
    },
    wss,
    log: () => {}
  } as unknown as RouteCtx
  routeCtx = ctx
  server = createServer()
  server.on('upgrade', (req, socket, head) => {
    // As the guests route hands a link's socket on (routes/guests.ts): bound to the link its address names.
    const bound = /^\/g\/ws\/([A-Za-z0-9]+)\/(.+)$/.exec(req.url ?? '')
    if (bound) {
      req.url = `/w/sheet/${bound[2]}`
      ;(req as { guestLink?: string }).guestLink = bound[1]
    }
    sheetRoute.upgrade!(req, socket, head, ctx, /x/.exec('x')!)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

type Msg = Record<string, unknown> & { t: string }
/** `link`: through that link's own address, as a guest's page comes; without it the sheet's own route, as the owner's. */
async function client(sheet: string, token: string, link?: string, hello: Record<string, unknown> = {}): Promise<{ ws: WebSocket; next(): Promise<Msg>; closed: Promise<number>; queue: Msg[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${link ? `/g/ws/${link}/${sheet}` : `/w/sheet/${sheet}`}`)
  const queue: Msg[] = []
  const waiting: ((m: Msg) => void)[] = []
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Msg
    const w = waiting.shift()
    if (w) w(m)
    else queue.push(m)
  })
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
  await new Promise((resolve) => ws.on('open', resolve))
  ws.send(JSON.stringify({ t: 'hello', token, ...hello }))
  return { ws, closed, queue, next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiting.push(resolve))) }
}
const tokenFor = async (sheet: string, role: 'view' | 'edit', principal: string, link?: string): Promise<string> =>
  (await signer.sign({ sheet, role, principal, ...(link ? { link } : {}) } as never, 300)).token
const setCell = (row: number, col: number, v: unknown) => ({ id: 'sheet.mutation.set-range-values', params: { unitId: 's1', subUnitId: 'sheet1', cellValue: { [row]: { [col]: { v } } } } })
const insertRow = (row: number) => ({ id: 'sheet.mutation.insert-row', params: { unitId: 's1', subUnitId: 'sheet1', range: { startRow: row, endRow: row, startColumn: 0, endColumn: 25, rangeType: 1 } } })

describe('the live sheet route', () => {
  it('sends the workbook on hello, orders ops, and sends everyone the ops that land', async () => {
    const a = await client('s1', await tokenFor('s1', 'edit', 'owner'))
    const state = await a.next()
    expect(state).toMatchObject({ t: 'state', rev: 0 })
    expect(JSON.parse(state.snapshot as string).sheetOrder).toEqual(['sheet1'])
    const b = await client('s1', await tokenFor('s1', 'edit', 'guest:L1', 'L1'), 'L1')
    links.set('L1', { linkId: 'L1', item: { sheet: 's1' }, role: 'edit', expiresAt: Date.now() + 60_000, revokedAt: null })
    await b.next()
    a.ws.send(JSON.stringify({ t: 'ops', id: 1, baseRev: 0, mutations: [setCell(0, 0, 'hi')] }))
    expect(await a.next()).toMatchObject({ t: 'ops', rev: 1, by: 'owner' })
    expect(await a.next()).toEqual({ t: 'ack', id: 1, rev: 1 })
    expect(await b.next()).toMatchObject({ t: 'ops', rev: 1, by: 'owner' })

    // A guest's edit made before a row insert it missed moves down with it.
    a.ws.send(JSON.stringify({ t: 'ops', id: 2, baseRev: 1, mutations: [insertRow(0)] }))
    await a.next()
    await a.next()
    await b.next()
    b.ws.send(JSON.stringify({ t: 'ops', id: 3, baseRev: 1, mutations: [setCell(4, 1, 7)] }))
    const moved = await b.next()
    expect(moved).toMatchObject({ t: 'ops', rev: 3, by: 'guest:L1' })
    expect((moved.mutations as { params: { cellValue: unknown } }[])[0].params.cellValue).toEqual({ 5: { 1: { v: 7 } } })
    expect(await b.next()).toEqual({ t: 'ack', id: 3, rev: 3 })

    // A guest may not do what is not on the list; a revoked link closes within a second.
    b.ws.send(JSON.stringify({ t: 'ops', id: 4, baseRev: 3, mutations: [{ id: 'sheet.mutation.set-worksheet-name', params: { subUnitId: 'sheet1', name: 'x' } }] }))
    expect(await b.next()).toMatchObject({ t: 'refused', id: 4, reason: 'a guest cannot set worksheet name' })
    links.set('L1', { ...links.get('L1')!, revokedAt: Date.now() })
    expect(await b.closed).toBe(4403)
    a.ws.close()
  })

  it('an agent\'s suggestion reaches no guest: nothing on the socket, nothing in the workbook a guest loads, no op', async () => {
    links.set('L2', { linkId: 'L2', item: { sheet: 's1' }, role: 'edit', expiresAt: Date.now() + 60_000, revokedAt: null })
    const owner = await client('s1', await tokenFor('s1', 'edit', 'owner'))
    const guest = await client('s1', await tokenFor('s1', 'edit', 'guest:L2', 'L2'), 'L2')
    const rev = ((await owner.next()) as unknown as { rev: number }).rev
    await guest.next()
    const stored = ops.length
    const SECRET = 'Q4-forecast-7731'
    const got = await hostOf(routeCtx).cells({ lifeos: 's1' }, [{ at: 'C3', v: SECRET }], 'agent:env_box:t1', true, 'the new forecast')
    expect(got).toMatchObject({ count: 1 })
    expect(suggested.map((c) => c.proposed)).toEqual([JSON.stringify({ v: SECRET })])
    expect(ops).toHaveLength(stored)
    // The next thing the guest hears is the owner's own edit: the suggestion sent nothing first.
    owner.ws.send(JSON.stringify({ t: 'ops', id: 9, baseRev: rev, mutations: [setCell(8, 0, 'after')] }))
    const heard = await guest.next()
    expect(heard).toMatchObject({ t: 'ops', rev: rev + 1, by: 'owner' })
    expect(JSON.stringify(heard)).not.toContain(SECRET)
    // A guest who opens the page now loads the workbook without it.
    const late = await client('s1', await tokenFor('s1', 'view', 'guest:L2', 'L2'), 'L2')
    const state = await late.next()
    expect(state).toMatchObject({ t: 'state', rev: rev + 1 })
    expect(JSON.stringify(state)).not.toContain(SECRET)
    for (const c of [owner, guest, late]) c.ws.close()
  })

  it('refuses a token for another sheet and a socket that never says hello with one', async () => {
    const c = await client('s1', await tokenFor('s2', 'edit', 'owner'))
    expect(await c.closed).toBe(4403)
    const d = await client('s1', 'not-a-token')
    expect(await d.closed).toBe(4401)
  })

  it("a link's token opens the sheet through its own address alone: not the sheet's route reached directly, not another link's address", async () => {
    links.set('L3', { linkId: 'L3', item: { sheet: 's1' }, role: 'edit', expiresAt: Date.now() + 60_000, revokedAt: null })
    links.set('L4', { linkId: 'L4', item: { sheet: 's1' }, role: 'edit', expiresAt: Date.now() + 60_000, revokedAt: null })
    const token = await tokenFor('s1', 'edit', 'guest:L3', 'L3')
    expect(await (await client('s1', token)).closed).toBe(4403)
    expect(await (await client('s1', token, 'L4')).closed).toBe(4403)
    const own = await client('s1', token, 'L3')
    expect(await own.next()).toMatchObject({ t: 'state' })
    own.ws.close()
  })

  it('a view link writes nothing; a guest inserts at most 1,000 rows at once, and keeps to values and formats', () => {
    // A tab added names no sheet yet: a guest is told it may not add one, never that the mutation names no sheet.
    expect(refusal([{ id: 'sheet.mutation.insert-sheet', params: { unitId: 's1', index: 1, sheet: { id: 'new', name: 'Sheet2' } } }], 'edit', true)).toBe('a guest cannot insert sheet')
    expect(refusal([{ id: 'sheet.mutation.insert-sheet', params: { unitId: 's1' } }], 'edit', false)).toBe('a mutation names its sheet')
    expect(refusal([setCell(0, 0, 1)], 'view', true)).toBe('this link can view, not edit')
    expect(refusal([setCell(0, 0, 1), insertRow(1)], 'edit', true)).toBeNull()
    const huge = { id: 'sheet.mutation.insert-row', params: { unitId: 's1', subUnitId: 'sheet1', range: { startRow: 0, endRow: 1_999_999, startColumn: 0, endColumn: 25 } } }
    expect(refusal([huge], 'edit', true)).toMatch(/at most 1000 rows/)
    const rich = { id: 'sheet.mutation.set-range-values', params: { unitId: 's1', subUnitId: 'sheet1', cellValue: { 0: { 0: { v: 1, p: { body: {} }, custom: { x: 1 } } } } } }
    expect(guestCells([rich])[0].params).toMatchObject({ cellValue: { 0: { 0: { v: 1 } } } })
    expect((guestCells([rich])[0].params as { cellValue: Record<string, Record<string, object>> }).cellValue[0][0]).toEqual({ v: 1 })
  })

  it('a stale row insert is shifted through the one it missed; a sheet op through a row change cannot be moved', () => {
    expect(moveThrough([insertRow(2)], [insertRow(0)])).toEqual([insertRow(3)])
    expect(moveThrough([setCell(3, 0, 1)], [setCell(0, 0, 2)])).toEqual([setCell(3, 0, 1)])
    expect(moveThrough([setCell(3, 0, 1)], [insertRow(0)])).toEqual([setCell(4, 0, 1)])
    expect(moveThrough([{ id: 'sheet.mutation.set-worksheet-name', params: { unitId: 's1', subUnitId: 'sheet1', name: 'Plan' } }], [insertRow(0)])).toBeNull()
  })

  describe('a client that keeps its own unanswered edits (work-kit/sheet/collab)', () => {
    const CID = 'client-0001'
    const rowOf = (m: Msg) => Object.keys((m.mutations as { params: { cellValue: Record<string, unknown> } }[])[0]!.params.cellValue)[0]

    it("is told this run's mark, gets its own op back marked with its batch id, and others get it plain", async () => {
      const a = await client('s1', await tokenFor('s1', 'edit', 'owner'), undefined, { cid: CID })
      const state = await a.next()
      expect(state).toMatchObject({ t: 'state', mark: 'mark-of-this-run' })
      expect(typeof state.snapshot).toBe('string')
      const b = await client('s1', await tokenFor('s1', 'edit', 'owner'), undefined, { cid: 'client-0002' })
      await b.next()
      a.ws.send(JSON.stringify({ t: 'ops', id: 11, baseRev: state.rev, mutations: [setCell(20, 0, 'mine')] }))
      const echo = await a.next()
      expect(echo).toMatchObject({ t: 'ops', own: 11 })
      expect(await a.next()).toMatchObject({ t: 'ack', id: 11, rev: echo.rev })
      const heard = await b.next()
      expect(heard).toMatchObject({ t: 'ops', rev: echo.rev })
      expect('own' in heard).toBe(false)
      for (const c of [a, b]) c.ws.close()
    })

    it('a batch sent again after a dropped line is acknowledged again and applied once', async () => {
      const a = await client('s1', await tokenFor('s1', 'edit', 'owner'), undefined, { cid: CID })
      const state = await a.next()
      const stored = ops.length
      a.ws.send(JSON.stringify({ t: 'ops', id: 21, baseRev: state.rev, mutations: [setCell(21, 0, 'once')] }))
      await a.next()
      const ack = await a.next()
      a.ws.terminate()
      // The same client on a new socket: it says where it stands, and is told which of what it missed was its own.
      const back = await client('s1', await tokenFor('s1', 'edit', 'owner'), undefined, { cid: CID, since: state.rev, snapshot: false })
      const caught = await back.next()
      expect(caught).toMatchObject({ t: 'state', rev: ack.rev, last: { id: 21, rev: ack.rev }, ops: [{ rev: ack.rev, own: 21 }] })
      expect('snapshot' in caught).toBe(false)
      back.ws.send(JSON.stringify({ t: 'ops', id: 21, baseRev: state.rev, mutations: [setCell(21, 0, 'once')] }))
      expect(await back.next()).toEqual({ t: 'ack', id: 21, rev: ack.rev })
      expect(ops.length).toBe(stored + 1)
      // Another client's same id is its own batch, not this one's.
      const other = await client('s1', await tokenFor('s1', 'edit', 'owner'), undefined, { cid: 'client-0003' })
      await other.next()
      other.ws.send(JSON.stringify({ t: 'ops', id: 21, baseRev: ack.rev, mutations: [setCell(22, 0, 'theirs')] }))
      expect(await other.next()).toMatchObject({ t: 'ops', own: 21, rev: (ack.rev as number) + 1 })
      for (const c of [back, other]) c.ws.close()
    })

    it('asks again on the same socket for the sheet as it stands, and a page that names no client id is answered as before', async () => {
      const a = await client('s1', await tokenFor('s1', 'edit', 'owner'), undefined, { cid: CID })
      const first = await a.next()
      a.ws.send(JSON.stringify({ t: 'hello', token: 'not read again', cid: CID, since: first.rev, snapshot: true }))
      const again = await a.next()
      expect(again).toMatchObject({ t: 'state', rev: first.rev, ops: [] })
      expect(typeof again.snapshot).toBe('string')
      // Ahead of the sheet, or too far behind to be sent the ops: the whole workbook and no ops.
      a.ws.send(JSON.stringify({ t: 'hello', token: 'x', cid: CID, since: 99_999, snapshot: false }))
      const whole = await a.next()
      expect('ops' in whole).toBe(false)
      expect(typeof whole.snapshot).toBe('string')
      const old = await client('s1', await tokenFor('s1', 'edit', 'owner'))
      const state = await old.next()
      expect(typeof state.snapshot).toBe('string')
      expect('ops' in state || 'last' in state).toBe(false)
      for (const c of [a, old]) c.ws.close()
    })

    it('a batch whose every cell went with a row someone removed is acknowledged with no op of its own, and remembered', async () => {
      const a = await client('s1', await tokenFor('s1', 'edit', 'owner'), undefined, { cid: CID })
      const state = await a.next()
      const b = await client('s1', await tokenFor('s1', 'edit', 'owner'), undefined, { cid: 'client-0004' })
      await b.next()
      b.ws.send(JSON.stringify({ t: 'ops', id: 1, baseRev: state.rev, mutations: [{ id: 'sheet.mutation.remove-rows', params: { unitId: 's1', subUnitId: 'sheet1', range: { startRow: 50, endRow: 50, startColumn: 0, endColumn: 25 } } }] }))
      const removed = await a.next()
      expect(removed).toMatchObject({ t: 'ops', rev: (state.rev as number) + 1 })
      const stored = ops.length
      // Made on the sheet as it stood before the row went: nothing of it is left to commit.
      a.ws.send(JSON.stringify({ t: 'ops', id: 31, baseRev: state.rev, mutations: [setCell(50, 0, 'gone')] }))
      expect(await a.next()).toEqual({ t: 'ack', id: 31, rev: removed.rev })
      expect(ops.length).toBe(stored)
      a.ws.send(JSON.stringify({ t: 'hello', token: 'x', cid: CID, since: removed.rev, snapshot: false }))
      expect(await a.next()).toMatchObject({ t: 'state', rev: removed.rev, last: { id: 31, rev: removed.rev }, ops: [] })
      for (const c of [a, b]) c.ws.close()
    })

    it('a socket that asks for the sheet again and again is let go', async () => {
      const { HELLOS_A_MINUTE } = await import('./sheet')
      const a = await client('s1', await tokenFor('s1', 'edit', 'owner'), undefined, { cid: CID })
      const first = await a.next()
      const closed = new Promise<number>((resolve) => a.ws.on('close', (code) => resolve(code)))
      for (let i = 0; i <= HELLOS_A_MINUTE; i++) a.ws.send(JSON.stringify({ t: 'hello', token: 'x', cid: CID, since: first.rev, snapshot: false }))
      expect(await closed).toBe(1008)
    })

    it("holds a guest's link to its sends a minute and tells the page why; the owner's own page is not counted", async () => {
      const { SHEET_BUDGET, TOO_MANY_EDITS, clearSheetBudget } = await import('./sheet')
      const was = SHEET_BUDGET.sends
      SHEET_BUDGET.sends = 2
      clearSheetBudget()
      try {
        links.set('L5', { linkId: 'L5', item: { sheet: 's1' }, role: 'edit', expiresAt: Date.now() + 60_000, revokedAt: null })
        const g = await client('s1', await tokenFor('s1', 'edit', 'guest:L5', 'L5'), 'L5', { cid: CID })
        let rev = (await g.next()).rev as number
        for (const id of [1, 2]) {
          g.ws.send(JSON.stringify({ t: 'ops', id, baseRev: rev, mutations: [setCell(30 + id, 0, id)] }))
          await g.next()
          rev = (await g.next()).rev as number
        }
        g.ws.send(JSON.stringify({ t: 'ops', id: 3, baseRev: rev, mutations: [setCell(33, 0, 3)] }))
        expect(await g.next()).toEqual({ t: 'refused', id: 3, reason: TOO_MANY_EDITS })
        const own = await client('s1', await tokenFor('s1', 'edit', 'owner'), undefined, { cid: CID })
        let at = (await own.next()).rev as number
        for (const id of [1, 2, 3, 4]) {
          own.ws.send(JSON.stringify({ t: 'ops', id, baseRev: at, mutations: [setCell(40 + id, 0, id)] }))
          await own.next()
          at = (await own.next()).rev as number
        }
        for (const c of [g, own]) c.ws.close()
      } finally {
        SHEET_BUDGET.sends = was
        clearSheetBudget()
      }
      void rowOf
    })
  })

  describe('who is on the sheet', () => {
    const range = { startRow: 3, endRow: 3, startColumn: 1, endColumn: 2 }

    it("tells everyone else a person's selection under the service's name and hue: the link's name for a guest, the owner's for him, never the page's", async () => {
      links.set('L6', { linkId: 'L6', item: { sheet: 's1' }, role: 'edit', expiresAt: Date.now() + 60_000, revokedAt: null, guest: { name: 'Dana Lee' } } as never)
      const guest = await client('s1', await tokenFor('s1', 'edit', 'guest:L6', 'L6'), 'L6')
      const owner = await client('s1', await tokenFor('s1', 'edit', 'owner'))
      await guest.next()
      await owner.next()
      guest.ws.send(JSON.stringify({ t: 'presence', sheet: 'sheet1', range, name: 'Landon Hale', hue: 7, id: 'owner' }))
      const seen = await owner.next()
      expect(seen).toMatchObject({ t: 'presence', name: 'Dana Lee', hue: 1, sheet: 'sheet1', range })
      expect(seen.id).not.toBe('owner')
      owner.ws.send(JSON.stringify({ t: 'presence', sheet: 'sheet1', range: { ...range, startRow: 9, endRow: 9 } }))
      const his = await guest.next()
      expect(his).toMatchObject({ t: 'presence', name: 'Landon Hale', hue: 2 })
      // Nobody hears their own selection back.
      expect(guest.queue).toHaveLength(0)
      // One who comes now is told who is already here; a second window of the same person wears the same hue.
      const late = await client('s1', await tokenFor('s1', 'edit', 'owner'))
      await late.next()
      const here = [await late.next(), await late.next()]
      expect(here.map((p) => p.name).sort()).toEqual(['Dana Lee', 'Landon Hale'])
      late.ws.send(JSON.stringify({ t: 'presence', sheet: 'sheet1', range }))
      expect(await guest.next()).toMatchObject({ t: 'presence', name: 'Landon Hale', hue: 2 })
      // A selection cleared, and a socket that leaves, are told as gone.
      guest.ws.send(JSON.stringify({ t: 'presence', range: null }))
      expect(await owner.next()).toMatchObject({ t: 'presence', name: 'Landon Hale' })
      expect(await owner.next()).toEqual({ t: 'left', id: seen.id })
      late.ws.close()
      const left = await guest.next()
      expect(left.t).toBe('left')
      for (const c of [guest, owner]) c.ws.close()
    })

    it("his desktop grid's selection, said through main, is told to the sheet's sockets under his name; main is told who is on the sheet, and a grid that went quiet is let go", async () => {
      const { internalSheetRoutes } = await import('./internalSheet')
      const { onPresence, sweepPresence, DESKTOP_PRESENCE_MS } = await import('./sheetRooms')
      const say = (body: Record<string, unknown>) => internalSheetRoutes.find((r) => r.path === '/internal/sheet/presence')!.run({ sheet: { lifeos: 's1' }, id: 'desktop:item1', ...body }, routeCtx) as Promise<{ people: { id: string; name: string }[] }>
      links.set('L7', { linkId: 'L7', item: { sheet: 's1' }, role: 'edit', expiresAt: Date.now() + 60_000, revokedAt: null, guest: { name: 'Dana Lee' } } as never)
      const guest = await client('s1', await tokenFor('s1', 'edit', 'guest:L7', 'L7'), 'L7')
      await guest.next()
      const told: { key: string; ids: string[] }[] = []
      const off = onPresence((key, people) => told.push({ key, ids: people.map((p) => p.id) }))
      // Only reading says nothing and answers nobody yet.
      expect(await say({})).toEqual({ people: [] })
      expect(await say({ at: { sheet: 'sheet1', range } })).toEqual({ people: [] })
      expect(await guest.next()).toMatchObject({ t: 'presence', id: 'desktop:item1', name: 'Landon Hale', sheet: 'sheet1', range })
      guest.ws.send(JSON.stringify({ t: 'presence', sheet: 'sheet1', range }))
      await new Promise((r) => setTimeout(r, 30))
      // Everyone else, never the grid's own selection back.
      expect((await say({})).people.map((p) => p.name)).toEqual(['Dana Lee'])
      expect(told.at(-1)).toMatchObject({ key: 'lifeos:s1' })
      expect(told.at(-1)!.ids).toContain('desktop:item1')
      await expect(say({ id: 'guest:L7' })).rejects.toThrow(/desktop/)
      await expect(say({ at: { sheet: 'sheet1', range: { ...range, endRow: 0 } } })).rejects.toThrow(/tab and a range/)
      // Half an hour with no word: the grid's window went without saying so.
      sweepPresence(Date.now() + DESKTOP_PRESENCE_MS + 1)
      expect(await guest.next()).toEqual({ t: 'left', id: 'desktop:item1' })
      expect(await say({ at: { sheet: 'sheet1', range } })).toMatchObject({ people: [{ name: 'Dana Lee' }] })
      await guest.next()
      expect(await say({ at: null })).toMatchObject({ people: [{ name: 'Dana Lee' }] })
      expect(await guest.next()).toEqual({ t: 'left', id: 'desktop:item1' })
      off()
      guest.ws.close()
    })

    it('a message that is no object closes only its own socket, before or after hello; a revoked guest says nothing more, under no name', async () => {
      for (const bad of ['null', '42', '[]', '"hi"', '{}']) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/w/sheet/s1`)
        await new Promise((resolve) => ws.on('open', resolve))
        const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
        ws.send(bad)
        expect(await closed, bad).toBe(1007)
      }
      const signed = await client('s1', await tokenFor('s1', 'edit', 'owner'))
      await signed.next()
      signed.ws.send('null')
      expect(await signed.closed).toBe(1007)
      // The service still serves.
      links.set('L8', { linkId: 'L8', item: { sheet: 's1' }, role: 'edit', expiresAt: Date.now() + 60_000, revokedAt: null, guest: { name: 'Dana Lee' } } as never)
      const guest = await client('s1', await tokenFor('s1', 'edit', 'guest:L8', 'L8'), 'L8')
      const owner = await client('s1', await tokenFor('s1', 'edit', 'owner'))
      await guest.next()
      await owner.next()
      links.delete('L8')
      guest.ws.send(JSON.stringify({ t: 'presence', sheet: 'sheet1', range }))
      expect(await guest.closed).toBe(4403)
      await new Promise((r) => setTimeout(r, 30))
      expect(owner.queue.filter((m) => m.t === 'presence')).toEqual([])
      owner.ws.close()
    })

    it('drops a selection said more than ten times a second, and one that is no box on a grid', async () => {
      const a = await client('s1', await tokenFor('s1', 'edit', 'owner'))
      const b = await client('s1', await tokenFor('s1', 'edit', 'owner'))
      await a.next()
      await b.next()
      for (let i = 0; i < 40; i++) a.ws.send(JSON.stringify({ t: 'presence', sheet: 'sheet1', range: { ...range, startRow: i, endRow: i } }))
      a.ws.send(JSON.stringify({ t: 'ops', id: 1, baseRev: 99_999, mutations: [setCell(0, 0, 1)] }))
      // The refusal comes after every presence frame was read: by then ten were passed on and the rest dropped.
      await a.next()
      await new Promise((r) => setTimeout(r, 50))
      expect(b.queue.filter((m) => m.t === 'presence')).toHaveLength(10)
      const { selectionOf } = await import('./sheetRooms')
      expect(selectionOf('sheet1', range)).toEqual({ sheet: 'sheet1', range })
      for (const bad of [null, {}, { ...range, endRow: 1 }, { ...range, startRow: -1 }, { ...range, startColumn: 1.5 }]) expect(selectionOf('sheet1', bad)).toBeNull()
      expect(selectionOf('', range)).toBeNull()
      for (const c of [a, b]) c.ws.close()
    })
  })
})
