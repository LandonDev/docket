import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configure } from 'aliax-core'
import { WebSocket } from 'ws'
import type { Capability } from '@shared/capabilities'
import type { RunningServer } from '../index'

/**
 * Work through a real server on a temp database: the switch over the wire,
 * the capability gate and the path fence in front of the mount, and the
 * create paths refusing Work by name until its milestone lands.
 */
let root: string
let server: RunningServer

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-work-server-'))
  configure({
    dataDir: join(root, 'aliax'),
    fetch: async () => {
      throw new Error('no network in tests')
    },
    secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
    appName: 'temp-code-test'
  })
  mkdirSync(join(root, 'out', 'renderer'), { recursive: true })
  writeFileSync(join(root, 'out', 'renderer', 'index.html'), '<!doctype html><html><body></body></html>')
  const { startServer } = await import('../index')
  server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0, appPath: root })
}, 60_000)
afterAll(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

interface Socket {
  ws: WebSocket
  pushes: { push: string; [key: string]: unknown }[]
  request: (method: string, params?: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>
}
function open(url: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pushes: Socket['pushes'] = []
    let next = 1
    const pending = new Map<string, (frame: { ok: boolean; result?: unknown; error?: string }) => void>()
    ws.on('message', (d) => {
      const frame = JSON.parse(String(d))
      if (frame.push) pushes.push(frame)
      else pending.get(frame.id)?.(frame)
    })
    ws.on('error', reject)
    ws.on('open', () =>
      resolve({
        ws,
        pushes,
        request: (method, params) =>
          new Promise((r) => {
            const id = String(next++)
            pending.set(id, r)
            ws.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }))
          })
      })
    )
  })
}
const local = (): Promise<Socket> => open(`ws://127.0.0.1:${server.port}`)
/** A key's socket through the fixed port: a ticket, then the upgrade. */
async function remote(caps: Capability[]): Promise<Socket> {
  const { token } = await server.remoteAuth.createKey({ name: `key-${caps.join('-')}`, audience: 'client', caps, createdBy: 'local' })
  const ticket = await new Promise<string>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.remote!.port, path: '/api/ticket', method: 'POST', headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve(JSON.parse(text).ticket))
    })
    req.on('error', reject)
    req.end()
  })
  return open(`ws://127.0.0.1:${server.remote!.port}/ws?ticket=${ticket}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const pushed = async (sock: Socket, name: string): Promise<Socket['pushes']> => {
  for (let i = 0; i < 100 && !sock.pushes.some((p) => p.push === name); i++) await sleep(20)
  return sock.pushes.filter((p) => p.push === name)
}

describe('Work on a running host, as it ships', () => {
  it('is off, and says so to anyone who asks', async () => {
    const me = await local()
    expect(await me.request('work.get')).toMatchObject({ ok: true, result: { enabled: false } })
    const phone = await remote(['read'])
    expect(await phone.request('work.get')).toMatchObject({ ok: true, result: { enabled: false } })
    me.ws.close()
    phone.ws.close()
  })

  it('the database carries the core columns and no Work row', () => {
    expect(server.store.listWorkspaces().every((w) => w.kind === undefined)).toBe(true)
    expect(server.store.getSetting('work')).toBeNull()
  })

  it('refuses every way of making a Work thing, by name, and still answers the code paths', async () => {
    const me = await local()
    expect(await me.request('workspace.create', { kind: 'work', name: 'Purdue', sector: 'purdue' })).toEqual({ id: '1', ok: false, error: "not built: workspace.create {kind: 'work'} (milestone 6)" })
    expect(await me.request('session.create', { provider: 'claude', model: 'claude-opus-5-5', cwd: root, scope: 'work' })).toMatchObject({ ok: false, error: "not built: session.create {scope: 'work'} (milestone 6)" })
    expect(await me.request('session.create', { provider: 'claude', model: 'claude-opus-5-5', cwd: root, about: { kind: 'task', label: 'T', ref: { at: 'lifeos', table: 'tasks', id: 'k' } } })).toMatchObject({
      ok: false,
      error: 'not built: session.create {about} (milestone 7)'
    })
    expect(await me.request('workspace.create', {})).toMatchObject({ ok: false, error: 'workspace.create needs a path' })
    expect(server.store.listWorkspaces()).toEqual([])
    expect(server.registry.list({ archived: false })).toEqual([])
    // a pillar method no contract file declares is not a request this host speaks
    expect((await me.request('work.outbox.list', {})).error).toMatch(/^bad request: /)
    // the code paths answer as before
    expect(await me.request('workspace.list')).toMatchObject({ ok: true, result: [] })
    const made = await me.request('workspace.create', { path: root, name: 'code' })
    expect(made).toMatchObject({ ok: true, result: { name: 'code', path: root } })
    expect(made.result).not.toHaveProperty('kind')
    me.ws.close()
  })

  it('only an admin sets the switch, the bridge methods never leave the loopback, and a source outside the roots is fenced', async () => {
    const reader = await remote(['read', 'operate'])
    expect(await reader.request('work.set', { enabled: true })).toMatchObject({ ok: false, error: 'forbidden: work.set needs admin' })
    expect(await reader.request('app.workTools', { sessionId: 's', token: 't' })).toMatchObject({ ok: false, error: 'forbidden: app.workTools is local-only' })
    expect(await reader.request('app.workCall', { sessionId: 's', token: 't', call: 1, tool: 'x', args: {} })).toMatchObject({ ok: false, error: 'forbidden: app.workCall is local-only' })
    expect(await reader.request('app.workCancel', { sessionId: 's', token: 't', call: 1 })).toMatchObject({ ok: false, error: 'forbidden: app.workCancel is local-only' })
    expect(
      await reader.request('session.create', { provider: 'claude', model: 'claude-opus-5-5', about: { kind: 'selection', label: 'hosts', ref: { at: 'file', host: server.environmentId, path: '/etc/hosts' } } })
    ).toMatchObject({ ok: false, error: 'forbidden: session.create is outside app-managed roots' })
    expect((await reader.request('work.get')).result).toEqual({ enabled: false })
    reader.ws.close()
  })

  it('turned on by an admin, tells every socket once; a bridge call still needs the thread\'s own token', async () => {
    const me = await local()
    const phone = await remote(['read'])
    const admin = await remote(['admin'])
    expect(await admin.request('work.set', { enabled: true })).toMatchObject({ ok: true, result: { enabled: true } })
    for (const sock of [me, phone, admin]) expect(await pushed(sock, 'work')).toEqual([{ push: 'work', settings: { enabled: true } }])
    expect((await me.request('work.get')).result).toEqual({ enabled: true })
    expect(await me.request('app.workTools', { sessionId: 's', token: 'guess' })).toMatchObject({ ok: false, error: "forbidden: not this thread's Work token" })
    // on or off, nothing makes a Work thing before milestone 6
    expect(await me.request('workspace.create', { kind: 'work', name: 'Purdue' })).toMatchObject({ ok: false, error: "not built: workspace.create {kind: 'work'} (milestone 6)" })
    expect(await me.request('work.set', { enabled: false })).toMatchObject({ ok: true, result: { enabled: false } })
    expect((await pushed(me, 'work')).at(-1)).toEqual({ push: 'work', settings: { enabled: false } })
    for (const sock of [me, phone, admin]) sock.ws.close()
  })
})
