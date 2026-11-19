import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createCollabSigner, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE, type CollabSigner } from 'work-kit/collab-server'
import { guestCells, moveThrough, refusal } from '../../sheets/host/live'
import type { ServiceLink } from '../wire'
import type { RouteCtx } from './route'
import { sheetRoute } from './sheet'

/**
 * The live sheet route over a real socket: a LifeOS sheet kept by a fake
 * Convex in memory, tokens signed by a key the route trusts.
 */

const ops: { rev: number; by: string; at: number; mutations: string }[] = []
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
      return []
  }
  throw new Error(`unexpected ${fn}`)
}

const links = new Map<string, ServiceLink>()
let server: Server
let port: number
let signer: CollabSigner
beforeAll(async () => {
  const keys = await generateCollabKeys('k1')
  signer = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:test' })
  const wss = new WebSocketServer({ noServer: true })
  const ctx = {
    config: () => ({ lifeos: { here: true, host: null }, trusted: [{ by: 'host', iss: 'tempcode:test', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }] }),
    convex,
    links: () => links,
    wss,
    log: () => {}
  } as unknown as RouteCtx
  server = createServer()
  server.on('upgrade', (req, socket, head) => sheetRoute.upgrade!(req, socket, head, ctx, /x/.exec('x')!))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

type Msg = Record<string, unknown> & { t: string }
async function client(sheet: string, token: string): Promise<{ ws: WebSocket; next(): Promise<Msg>; closed: Promise<number> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/w/sheet/${sheet}`)
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
  ws.send(JSON.stringify({ t: 'hello', token }))
  return { ws, closed, next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiting.push(resolve))) }
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
    const b = await client('s1', await tokenFor('s1', 'edit', 'guest:L1', 'L1'))
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

  it('refuses a token for another sheet and a socket that never says hello with one', async () => {
    const c = await client('s1', await tokenFor('s2', 'edit', 'owner'))
    expect(await c.closed).toBe(4403)
    const d = await client('s1', 'not-a-token')
    expect(await d.closed).toBe(4401)
  })

  it('a view link writes nothing; a guest inserts at most 1,000 rows at once, and keeps to values and formats', () => {
    expect(refusal([setCell(0, 0, 1)], 'view', true)).toBe('this link can view, not edit')
    expect(refusal([setCell(0, 0, 1), insertRow(1)], 'edit', true)).toBeNull()
    const huge = { id: 'sheet.mutation.insert-row', params: { unitId: 's1', subUnitId: 'sheet1', range: { startRow: 0, endRow: 1_999_999, startColumn: 0, endColumn: 25 } } }
    expect(refusal([huge], 'edit', true)).toMatch(/at most 1000 rows/)
    const rich = { id: 'sheet.mutation.set-range-values', params: { unitId: 's1', subUnitId: 'sheet1', cellValue: { 0: { 0: { v: 1, p: { body: {} }, custom: { x: 1 } } } } } }
    expect(guestCells([rich])[0].params).toMatchObject({ cellValue: { 0: { 0: { v: 1 } } } })
    expect((guestCells([rich])[0].params as { cellValue: Record<string, Record<string, object>> }).cellValue[0][0]).toEqual({ v: 1 })
  })

  it('a stale structural edit cannot be moved: the client reloads', () => {
    expect(moveThrough([insertRow(2)], [insertRow(0)])).toBeNull()
    expect(moveThrough([setCell(3, 0, 1)], [setCell(0, 0, 2)])).toEqual([setCell(3, 0, 1)])
  })
})
