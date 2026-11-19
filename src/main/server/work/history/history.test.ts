import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { fileDocName } from 'work-kit/collab-server'
import type { HistoryCompare, HistoryVersions } from '@shared/contract-work-history'
import type { ClientRequest } from '@shared/contract'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { servicePaths } from '../service/config'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { startWorkService, type RunningService } from '../service/serve'
import type { ServiceConfig } from '../service/wire'
import { history, namesFor } from './index'

/*
 * History end to end on this host: the Work service in process (its socket
 * routes, a real Hocuspocus with gc off, a .tcdoc on disk and a fake LifeOS),
 * and the module that answers `work.history.*` calling it as main does.
 */

const SECRET = 'h'.repeat(43)
const open: { dirs: string[]; services: RunningService[]; convex: FakeConvex[] } = { dirs: [], services: [], convex: [] }

afterEach(async () => {
  await Promise.all(open.services.splice(0).map((s) => s.stop().catch(() => {})))
  await Promise.all(open.convex.splice(0).map((c) => c.close()))
  for (const d of open.dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function post(socketPath: string, path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { error?: string }
        if ((res.statusCode ?? 500) >= 400) reject(new Error(parsed.error ?? `HTTP ${res.statusCode}`))
        else resolve(parsed)
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'm19-hist-'))
  open.dirs.push(dir)
  const convex = await startFakeConvex()
  open.convex.push(convex)
  mkdirSync(join(dir, 'data'), { recursive: true })
  const config: ServiceConfig = {
    port: 0,
    socketPath: servicePaths(join(dir, 'data')).socketPath,
    secret: SECRET,
    dataDir: join(dir, 'data', 'work-service'),
    hostedDir: join(dir, 'hosted'),
    host: 'env_box',
    lifeos: { here: true, url: convex.url },
    trusted: [],
    links: []
  }
  const service = await startWorkService(config, { jwt: async () => 'owner-jwt', log: () => {} })
  open.services.push(service)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
  db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run('t1', 'Venue for the spring LAN')
  const ctx = {
    db,
    host: 'env_box',
    reaches: (by: Caller) => by.kind !== 'remote',
    service: { internal: (route: string, body: unknown) => post(config.socketPath, route, body) }
  } as unknown as WorkCtx
  const ask = async <T,>(method: string, params: unknown, by: Caller = { kind: 'local', caps: [] }): Promise<T> => {
    const done = await history.handle!({ id: '1', method, params } as ClientRequest, ctx, by)
    if (!done.handled) throw new Error('not handled')
    return done.result as T
  }
  return { dir, convex, service, config, ctx, ask }
}

const md = (...lines: string[]) => lines.join('\n\n')

describe('history of a .tcdoc on this host', () => {
  it('lists, cuts, compares one column of rows, restores, and keeps every version inside the file', async () => {
    const r = await rig()
    const path = join(r.dir, 'Run of show.tcdoc')
    const source = { at: 'file', host: 'env_box', path } as const
    const name = fileDocName(path)
    await r.service.collab.writeMarkdown(name, 'owner', md('# Morning', 'Setup at 8:00 AM', 'Doors at 9:00 AM'), { path })
    const first = await r.ask<{ id: string }>('work.history.cut', { source, label: 'Wrote the morning' })
    await r.service.collab.writeMarkdown(name, 'agent:env_box:t1', md('# Morning', 'Setup at 7:30 AM', 'Check-in at 8:30 AM', 'Doors at 9:00 AM'), { path })
    const second = await r.ask<{ id: string }>('work.history.cut', { source })

    const listed = await r.ask<HistoryVersions>('work.history.versions', { source })
    expect(listed.versions.map((v) => [v.cause, v.by])).toEqual([
      ['named', ['agent:env_box:t1']],
      ['named', ['owner']]
    ])
    expect(listed.versions[1]!.label).toBe('Wrote the morning')
    expect(listed.names).toEqual({ 'agent:env_box:t1': 'Venue for the spring LAN', owner: 'You' })

    const compare = await r.ask<HistoryCompare>('work.history.compare', { source, from: first.id, to: second.id })
    expect(compare.diff.rows.map((row) => [row.kind, row.by])).toEqual([
      ['changed', ['agent:env_box:t1']],
      ['added', ['agent:env_box:t1']]
    ])
    expect(compare.names['agent:env_box:t1']).toBe('Venue for the spring LAN')

    expect(await r.ask('work.history.restore', { source, versionId: first.id })).toMatchObject({ mode: 'direct' })
    expect((await r.service.collab.read(name, { path })).markdown).toContain('8:00 AM')
    const after = await r.ask<HistoryVersions>('work.history.versions', { source })
    expect(after.versions[0]).toMatchObject({ cause: 'restore', restoredFrom: first.id })
    // The older versions still compare after the restore.
    expect((await r.ask<HistoryCompare>('work.history.compare', { source, from: first.id, to: second.id })).diff.rows).toHaveLength(2)
  })

  it("a LifeOS document's branch is listed with what it suggests, and Accept takes one row", async () => {
    const r = await rig()
    r.convex.docs.set('kd1', { _id: 'kd1', sector: 'life', seq: 0, title: 'Plan', shared: true, markdown: '', plain: '' })
    const fence = { sectors: 'all' }
    await post(r.config.socketPath, '/internal/doc/write', { docId: 'kd1', markdown: md('# Plan', 'Alpha', 'Bravo'), because: 'asked', botId: 'k', fence })
    await post(r.config.socketPath, '/internal/doc/write', { docId: 'kd1', markdown: md('# Plan', 'Alpha!', 'Bravo!'), because: 'own', origin: { host: 'env_box', threadId: 't1' }, fence })
    const source = { at: 'lifeos', table: 'docs', id: 'kd1' } as const
    const { branches, names } = await r.ask<{ branches: { id: string; diff: HistoryCompare['diff'] }[]; names: Record<string, string> }>('work.history.branches', { source })
    expect(branches).toHaveLength(1)
    expect(names['agent:env_box:t1']).toBe('Venue for the spring LAN')
    const rows = branches[0]!.diff.rows
    expect(rows.map((row) => row.right?.text)).toEqual(['Alpha!', 'Bravo!'])
    expect(await r.ask('work.history.decide', { source, branchId: branches[0]!.id, which: [rows[0]!.id], accept: true })).toEqual(expect.objectContaining({ left: 1 }))
    expect((await r.service.collab.read('kd1')).markdown).toBe('# Plan\n\nAlpha!\n\nBravo\n')
    expect(await r.ask('work.history.decide', { source, branchId: branches[0]!.id, which: 'all', accept: false })).toEqual({ left: 0 })
    expect((await r.ask<{ branches: unknown[] }>('work.history.branches', { source })).branches).toEqual([])
  })
})

describe('who may ask', () => {
  it("a remote key outside the fence is refused a file's history; a file on another host is named there; a mail is not a document", async () => {
    const r = await rig()
    const path = join(r.dir, 'x.tcdoc')
    await expect(r.ask('work.history.versions', { source: { at: 'file', host: 'env_box', path } }, { kind: 'remote', caps: ['read'] })).rejects.toBeInstanceOf(FenceError)
    await expect(r.ask('work.history.versions', { source: { at: 'file', host: 'env_mac', path } })).rejects.toThrow(/another host/)
    await expect(r.ask('work.history.versions', { source: { at: 'lifeos', table: 'outbox', id: 'o1' } })).rejects.toThrow(/documents/)
  })

  it("refuses a bot key's call on the socket: history's acts are the owner's", async () => {
    const r = await rig()
    r.convex.docs.set('kd2', { _id: 'kd2', sector: 'life', seq: 0, title: 'Plan', shared: true, markdown: '', plain: '' })
    for (const fence of [{ sectors: 'all', botId: 'k1' }, { sectors: ['life'], client: 'tempcode', draftOnly: true }])
      await expect(post(r.config.socketPath, '/internal/history/decide', { docId: 'kd2', branchId: 'b', which: 'all', accept: true, fence })).rejects.toThrow("history is the owner's")
    await expect(post(r.config.socketPath, '/internal/history/list', { file: join(r.dir, 'x.tcdoc'), fence: { sectors: 'all', botId: 'k1' } })).rejects.toThrow("history is the owner's")
  })

  it('leaves methods that are not its own to the rest of the chain', async () => {
    const r = await rig()
    expect(await history.handle!({ id: '1', method: 'work.history.list', params: {} } as unknown as ClientRequest, r.ctx, { kind: 'local', caps: [] })).toEqual({ handled: false })
  })

  it('names each principal as a screen shows it', async () => {
    const r = await rig()
    expect(namesFor(r.ctx, ['owner', 'lifeos:desktop', 'lifeos:bot:k1', 'agent:env_box:t1', 'agent:env_mac:t9', 'agent:env_box:gone', 'guest:l1', 'external:Dana Lee'])).toEqual({
      owner: 'You',
      'lifeos:desktop': 'You',
      'lifeos:bot:k1': 'LifeOS',
      'agent:env_box:t1': 'Venue for the spring LAN',
      'agent:env_mac:t9': 'An agent',
      'agent:env_box:gone': 'An agent',
      'guest:l1': 'A guest',
      'external:Dana Lee': 'Dana Lee'
    })
  })
})
