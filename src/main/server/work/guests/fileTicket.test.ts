import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket as WsSocket } from 'ws'
import { createCollaborationClient, type CollaborationClient } from 'work-kit/collab'
import { createCollabSigner, fileDocName, generateCollabKeys, LIFEOS_COLLAB_AUDIENCE, TEMPCODE_COLLAB_AUDIENCE, type CollabSigner } from 'work-kit/collab-server'
import type { CanvasItem, CanvasSource } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { LIMITS } from '../service/routes/guests'
import { servicePaths } from '../service/config'
import { startWorkService, type RunningService } from '../service/serve'
import { TcsheetBackend } from '../sheets/host/backends'
import { SheetHost } from '../sheets/host/host'
import { fileSheetId, GuestRuntime, servesPublic, TICKET_REFUSALS } from './links'
import { ensureGuestTables } from './store'

/*
 * The owner's hosted editor on a document or a sheet kept as a file (the phone-files plan, PF4): main's
 * ticket for a canvas item, every refusal, and the real Work service behind it: the room a ticket redeems
 * to, an edit through the socket written to the file, and the sheet socket held to the pass.
 */

const shared = vi.hoisted(() => ({ paths: new Set<string>() }))
vi.mock('../files/policy', () => ({ sharedOf: (_ctx: unknown, source: { path?: string }) => !!source.path && shared.paths.has(source.path) }))

const SECRET = 's'.repeat(43)
const LOCAL: Caller = { kind: 'local', caps: [] }
const PHONE: Caller = { kind: 'remote', caps: ['read', 'operate'] }
const open: { dirs: string[]; services: RunningService[]; clients: CollaborationClient[]; convex: FakeConvex[]; hosts: SheetHost[] } = { dirs: [], services: [], clients: [], convex: [], hosts: [] }

beforeEach(() => {
  LIMITS.requests.clear()
  LIMITS.failures.clear()
  shared.paths.clear()
  vi.stubEnv('TEMP_CODE_WORK_PUBLIC_ORIGIN', 'https://proof.example')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(open.clients.splice(0).map((c) => c.destroy()))
  await Promise.all(open.hosts.splice(0).map((h) => h.close?.()))
  await Promise.all(open.services.splice(0).map((s) => s.stop().catch(() => {})))
  await Promise.all(open.convex.splice(0).map((c) => c.close()))
  for (const d of open.dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const until = async (what: string, ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

interface Rig {
  rt: GuestRuntime
  service: RunningService
  signer: CollabSigner
  /** LifeOS's own signer, which the service trusts for LifeOS's rows */
  lifeos: CollabSigner
  /** takes an item out of the pane */
  close(itemId: string): void
  base: string
  /** the workspace's own folder: what a remote key can reach */
  folder: string
  /** a folder of this host outside it */
  outside: string
  open(kind: CanvasItem['kind'], source: CanvasSource): string
}

async function rig(): Promise<Rig> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pf4-')))
  open.dirs.push(dir)
  const convex = await startFakeConvex()
  open.convex.push(convex)
  const keys = await generateCollabKeys('k')
  const signer = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:env_box' })
  const lifeosKeys = await generateCollabKeys('l')
  const lifeos = await createCollabSigner({ privateJwk: lifeosKeys.privateJwk, iss: 'https://lifeos.test/auth', aud: LIFEOS_COLLAB_AUDIENCE })
  const hosted = join(dir, 'hosted')
  mkdirSync(join(hosted, 'guest'), { recursive: true })
  writeFileSync(join(hosted, 'guest', 'index.html'), '<!doctype html><p>guest page</p>')
  const folder = join(dir, 'workspace')
  const outside = join(dir, 'elsewhere')
  for (const d of [join(dir, 'data'), folder, outside]) mkdirSync(d, { recursive: true })
  const service = await startWorkService(
    {
      port: 0,
      socketPath: servicePaths(join(dir, 'data')).socketPath,
      secret: SECRET,
      dataDir: join(dir, 'data', 'work-service'),
      hostedDir: hosted,
      host: 'env_box',
      lifeos: { here: true, url: convex.url },
      trusted: [
        { by: 'host', iss: 'tempcode:env_box', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] },
        { by: 'lifeos', iss: 'https://lifeos.test/auth', aud: LIFEOS_COLLAB_AUDIENCE, keys: [lifeosKeys.publicJwk] }
      ],
      links: []
    },
    { jwt: async () => 'owner-jwt', log: () => {} }
  )
  open.services.push(service)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  ensureGuestTables(db)
  const items = new Map<string, CanvasItem>()
  const base = `http://127.0.0.1:${service.port}`
  const ctx = {
    db,
    host: 'env_box',
    dataDir: join(dir, 'data'),
    log: () => {},
    push: () => {},
    canvas: { get: (id: string) => items.get(id) ?? null },
    // A remote key reaches the workspace's own folder; a screen at the host reaches everything.
    reaches: (by: Caller, path: string) => by.kind === 'local' || path.startsWith(folder + '/'),
    service: { url: (route: string) => `${base}${route}`, token: async () => 'ok', internal: async () => ({}) },
    lifeos: { owner: () => ({ query: async () => null, mutation: async () => undefined }) }
  } as unknown as WorkCtx
  const rt = new GuestRuntime(ctx, () => ({ tokenSigner: () => signer, setLinks: (links) => service.setLinks(links), setProject: (id, project) => service.setProject(id, project) }))
  let n = 0
  return {
    rt,
    service,
    signer,
    lifeos,
    base,
    folder,
    outside,
    close: (itemId) => void items.delete(itemId),
    open(kind, source) {
      const id = `item${++n}`
      items.set(id, { id, sessionId: 's1', workspaceId: 'w1', kind, title: 'Travel memo', source, state: 'open', position: n, rev: 1, createdAt: 1, updatedAt: 1 } as CanvasItem)
      return id
    }
  }
}

const file = (path: string, host = 'env_box'): CanvasSource => ({ at: 'file', host, path })
const item = (itemId: string) => ({ at: 'item' as const, itemId })
const redeem = async (r: Rig, url: string) => {
  const res = await fetch(`${r.base}/w/open/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(url).hash.replace('#t=', '') }) })
  return { status: res.status, body: (await res.json()) as { kind?: string; doc?: string; sheet?: string; token?: string; me?: string; role?: string } }
}

describe("the owner's ticket for a file-kept item", () => {
  it('refuses, in words a screen shows, everything the hosted editor cannot or must not open', async () => {
    const r = await rig()
    const memo = join(r.folder, 'Travel memo.tcdoc')
    await expect(r.rt.ticket(item('nope'), 'x', PHONE)).rejects.toThrow(TICKET_REFUSALS.gone)
    await expect(r.rt.ticket(item(r.open('pdf', file(join(r.folder, 'Rules.pdf')))), 'x', PHONE)).rejects.toThrow(TICKET_REFUSALS.kind)
    // A Word or an Excel file is saved by the desktop's own editor: the phone says where it edits.
    await expect(r.rt.ticket(item(r.open('document', file(join(r.folder, 'Letter.docx')))), 'x', PHONE)).rejects.toThrow(TICKET_REFUSALS.word)
    await expect(r.rt.ticket(item(r.open('sheet', file(join(r.folder, 'Budget.xlsx')))), 'x', PHONE)).rejects.toThrow(TICKET_REFUSALS.excel)
    // A file on another host of his is asked of that host.
    await expect(r.rt.ticket(item(r.open('document', file(memo, 'env_mac'))), 'x', PHONE)).rejects.toThrow('served elsewhere: env_mac')
    // A Google Doc's mirror and a mail's attachment are not files of his to edit here.
    await expect(r.rt.ticket(item(r.open('document', { at: 'google', account: 'a', fileId: 'f', mime: 'application/vnd.google-apps.document' })), 'x', PHONE)).rejects.toThrow(TICKET_REFUSALS.elsewhere)
  })

  it('never opens a file outside the key’s reach, nor one in a place others can open', async () => {
    const r = await rig()
    const far = r.open('document', file(join(r.outside, 'Private.tcdoc')))
    await expect(r.rt.ticket(item(far), 'x', PHONE)).rejects.toBeInstanceOf(FenceError)
    // The same item from a screen at the host is his own.
    expect((await r.rt.ticket(item(far), 'x', LOCAL)).url).toContain('/w/open#t=')
    const teams = join(r.folder, 'Shared plan.tcdoc')
    shared.paths.add(teams)
    await expect(r.rt.ticket(item(r.open('document', file(teams))), 'x', LOCAL)).rejects.toThrow(TICKET_REFUSALS.shared)
  })

  it('says so on a host whose pages no phone can open', async () => {
    const r = await rig()
    vi.stubEnv('TEMP_CODE_WORK_PUBLIC_ORIGIN', '')
    // An isolated instance (its own data folder) is behind no tunnel, as a Mac is.
    vi.stubEnv('TEMP_CODE_USER_DATA', join(r.folder, 'instance'))
    expect(servesPublic()).toBe(false)
    await expect(r.rt.ticket(item(r.open('document', file(join(r.folder, 'Travel memo.tcdoc')))), 'x', PHONE)).rejects.toThrow(TICKET_REFUSALS.noPage)
  })

  it('opens a LifeOS row named by its item as the row itself', async () => {
    const r = await rig()
    const got = await redeem(r, (await r.rt.ticket(item(r.open('document', { at: 'lifeos', table: 'docs', id: 'kdoc1' })), 'Run of show', PHONE)).url)
    expect(got.body).toMatchObject({ kind: 'doc', doc: 'kdoc1', me: 'owner', role: 'edit' })
  })

  it('redeems to the file’s room, and words typed through the socket are written into the .tcdoc', async () => {
    const r = await rig()
    const path = join(r.folder, 'Travel memo.tcdoc')
    const got = await redeem(r, (await r.rt.ticket(item(r.open('document', file(path))), 'Travel memo', PHONE)).url)
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ kind: 'doc', doc: fileDocName(path), me: 'owner', role: 'edit' })
    const client = createCollaborationClient({ documentName: got.body.doc!, token: got.body.token!, url: `ws://127.0.0.1:${r.service.port}/w/doc/${encodeURIComponent(got.body.doc!)}`, offline: false })
    open.clients.push(client)
    await until('synced', () => client.provider.isSynced)
    client.document.getText('proof').insert(0, 'Bus leaves at 7:30.')
    await until('the edit is with the service', () => !client.provider.hasUnsyncedChanges)
    await until('the file is written', () => existsSync(path), 8000)
    // The file is a .tcdoc: a zip that holds the document's state.
    expect(Object.keys(unzipSync(new Uint8Array(readFileSync(path)))).length).toBeGreaterThan(0)
    // A token for this room opens no other file's room.
    const other = createCollaborationClient({ documentName: fileDocName(join(r.folder, 'Other.tcdoc')), token: got.body.token!, url: `ws://127.0.0.1:${r.service.port}/w/doc/${encodeURIComponent(fileDocName(join(r.folder, 'Other.tcdoc')))}`, offline: false })
    open.clients.push(other)
    await new Promise((res) => setTimeout(res, 400))
    expect(other.provider.isSynced).toBe(false)
  })

  it('opens a .tcsheet on the live socket for the pass’s own token, and for nothing else', async () => {
    const r = await rig()
    const path = join(r.folder, 'Travel budget.tcsheet')
    TcsheetBackend.create(path, 'Travel budget')
    const got = await redeem(r, (await r.rt.ticket(item(r.open('sheet', file(path))), 'Travel budget', PHONE)).url)
    expect(got.body).toMatchObject({ kind: 'sheet', sheet: fileSheetId(path), me: 'owner' })
    // No path is in the name the socket is asked by.
    expect(got.body.sheet).toMatch(/^tc[0-9a-f]{40}$/)
    const hello = (sheet: string, token: string) => {
      const ws = new WsSocket(`${r.base.replace('http', 'ws')}/w/sheet/${sheet}`)
      const messages: { t: string; rev?: number }[] = []
      ws.on('message', (d) => messages.push(JSON.parse(String(d)) as { t: string }))
      ws.on('error', () => {})
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token })))
      return { ws, messages, closed: new Promise<number>((res) => ws.on('close', (code) => res(code))) }
    }
    const mine = hello(got.body.sheet!, got.body.token!)
    await until('the workbook arrives', () => mine.messages.some((m) => m.t === 'state'))
    // A cell typed on the phone lands in the file.
    mine.ws.send(JSON.stringify({ t: 'ops', id: 1, baseRev: mine.messages.find((m) => m.t === 'state')!.rev, mutations: [{ id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: { 1: { 1: { v: 180 } } } } }] }))
    await until('the edit is acknowledged', () => mine.messages.some((m) => m.t === 'ack' || m.t === 'refused'))
    expect(mine.messages.some((m) => m.t === 'ack')).toBe(true)
    const reader = new SheetHost((ref) => new TcsheetBackend((ref as { tcsheet: string }).tcsheet))
    open.hosts.push(reader)
    expect(JSON.stringify(JSON.parse((await reader.snapshotJson({ tcsheet: path })).json))).toContain('180')
    mine.ws.close()
    // A guest's token, or a token for a name no pass gave a file, opens nothing of the file.
    const guest = hello(got.body.sheet!, (await r.signer.sign({ sheet: got.body.sheet!, role: 'edit', principal: 'guest:L1', link: 'L1' }, 60)).token)
    expect(await guest.closed).toBe(4403)
    // LifeOS's own token of that name is no way in either: a file is this host's to open.
    const fromLifeos = hello(got.body.sheet!, (await r.lifeos.sign({ sheet: got.body.sheet!, role: 'edit', principal: 'owner' }, 60)).token)
    expect(await fromLifeos.closed).toBe(4403)
    // With the pass gone, the name is no file's: the route asks LifeOS for a sheet of that id, and there is none.
    r.service.setLinks([])
    const late = hello(got.body.sheet!, got.body.token!)
    await new Promise((res) => setTimeout(res, 600))
    expect(late.messages.some((m) => m.t === 'state')).toBe(false)
    late.ws.close()
  })

  it('ends a file’s pass when what let it be made no longer holds: its open socket closes within seconds', async () => {
    const r = await rig()
    const path = join(r.folder, 'Travel budget.tcsheet')
    TcsheetBackend.create(path, 'Travel budget')
    const itemId = r.open('sheet', file(path))
    const got = await redeem(r, (await r.rt.ticket(item(itemId), 'Travel budget', PHONE)).url)
    const ws = new WsSocket(`${r.base.replace('http', 'ws')}/w/sheet/${got.body.sheet!}`)
    const messages: { t: string }[] = []
    ws.on('message', (d) => messages.push(JSON.parse(String(d)) as { t: string }))
    ws.on('error', () => {})
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token: got.body.token })))
    const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)))
    await until('the workbook arrives', () => messages.some((m) => m.t === 'state'))
    // The folder becomes a place others can open: the next pass over the list drops the pass, and the socket goes.
    shared.paths.add(path)
    const at = Date.now()
    await r.rt.tick()
    expect(await closed).toBe(4403)
    expect(Date.now() - at).toBeLessThan(3000)
    // The same for an item he closed: its pass renews nothing.
    const memo = join(r.folder, 'Travel memo.tcdoc')
    const memoItem = r.open('document', file(memo))
    const opened = await redeem(r, (await r.rt.ticket(item(memoItem), 'Travel memo', PHONE)).url)
    const renew = (opened.body as { renew?: string }).renew
    r.close(memoItem)
    await r.rt.tick()
    const again = await fetch(`${r.base}/w/open/renew`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ renew }) })
    expect(again.status).toBe(403)
  })

  it('names a .tcsheet as its item spells its path, the name the desktop’s own editor opens it by', async () => {
    const r = await rig()
    const real = join(r.folder, 'Budgets')
    mkdirSync(real)
    symlinkSync(real, join(r.folder, 'Linked'))
    const spelled = join(r.folder, 'Linked', 'Trip.tcsheet')
    TcsheetBackend.create(join(real, 'Trip.tcsheet'), 'Trip')
    const got = await redeem(r, (await r.rt.ticket(item(r.open('sheet', file(spelled))), 'Trip', PHONE)).url)
    // One workbook for the phone and the desktop: both name it by the item's own path (sheets/held.ts).
    expect(got.body.sheet).toBe(fileSheetId(spelled))
  })
})
