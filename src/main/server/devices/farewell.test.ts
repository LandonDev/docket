import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { FAREWELL_CLOSE, FAREWELL_TTL_MS } from '@shared/contract-devices'
import { generateDeviceKeys } from '@shared/devices/keys'
import type { Store } from '../db'
import { startRemoteListener, type RemoteListener } from '../remote/listener'
import { makeBox } from './boxTestkit'

let listener: RemoteListener | null = null
afterEach(async () => {
  await listener?.close()
  listener = null
})

async function listen(box: Awaited<ReturnType<typeof makeBox>>) {
  const store = { getSetting: () => null, setSetting: () => {} } as unknown as Store
  listener = await startRemoteListener({ port: 0, auth: box.auth, store, environmentId: 'env_box', version: 'test', attach: () => {}, farewell: (p, body) => box.farewell.handle(p, body) })
  const base = `http://127.0.0.1:${listener.port}`
  const post = async (path: string, token: string, body: unknown = {}) => {
    const res = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const open = async (token: string) => {
    const { body } = await post('/api/ticket', token)
    const ws = new WebSocket(`ws://127.0.0.1:${listener!.port}/ws?ticket=${body.ticket as string}`)
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    await new Promise<void>((ok, bad) => (ws.once('open', () => ok()), ws.once('error', bad)))
    return { ws, closed }
  }
  return { post, open }
}

describe('devices.remove and farewell', () => {
  it('closes the key\'s sockets with FAREWELL_CLOSE and refuses it everything but /api/farewell', async () => {
    const box = await makeBox(Date.now())
    const pc = await box.computer()
    box.mailbox.post(box.letter(pc, 1))
    const http = await listen(box)
    const sock = await http.open(pc.token)
    const { removalId } = box.farewell.remove('env_pc')
    expect(await sock.closed).toBe(FAREWELL_CLOSE)
    expect(box.farewells).toEqual([pc.keyId])
    expect(box.dropped).toEqual([pc.keyId])
    expect(box.bindings.get('env_pc')).toMatchObject({ state: 'removing', removalId })
    // A second Remove answers the same removal.
    expect(box.farewell.remove('env_pc')).toEqual({ removalId })
    expect((await http.post('/api/ticket', pc.token)).status).toBe(403)
    // Its mail is the remove letter alone, once the giver posts it.
    expect((await http.post('/api/farewell', pc.token, { op: 'mail' })).body).toEqual({ letter: null, removal: { removalId } })
    const gone = box.letter(pc, 2, 'remove')
    box.mailbox.post(gone)
    expect((await http.post('/api/farewell', pc.token, { op: 'mail' })).body).toEqual({ letter: JSON.parse(JSON.stringify(gone)), removal: { removalId } })
    expect(box.mailbox.mail('env_pc')).toEqual({ letter: gone, removal: { removalId } })
  })

  it('a receipt signed by the computer revokes the key and retires the binding; a bad one is refused', async () => {
    const box = await makeBox(Date.now())
    const pc = await box.computer()
    const http = await listen(box)
    const { removalId } = box.farewell.remove('env_pc')
    expect((await http.post('/api/farewell', pc.token, { op: 'receipt', removalId, signature: box.receipt(pc, removalId, generateDeviceKeys()) })).status).toBe(403)
    expect((await http.post('/api/farewell', pc.token, { op: 'receipt', removalId: 'another', signature: box.receipt(pc, 'another') })).status).toBe(404)
    expect(box.auth.getKey(pc.keyId)!.revokedAt).toBeNull()
    expect((await http.post('/api/farewell', pc.token, { op: 'receipt', removalId, signature: box.receipt(pc, removalId) })).body).toEqual({ ok: true })
    expect(box.auth.getKey(pc.keyId)!.revokedAt).not.toBeNull()
    expect(box.bindings.get('env_pc')).toMatchObject({ state: 'retired' })
    expect(box.farewell.inFarewell(pc.keyId)).toBe(false)
    expect(box.toGiver.at(-1)).toEqual({ push: 'device-gone', envId: 'env_pc' })
    const row = box.db.prepare(`SELECT receipt_at, revoked_at FROM device_removals WHERE removal_id = ?`).get(removalId) as { receipt_at: number; revoked_at: number }
    expect(row.receipt_at).not.toBeNull()
    expect(row.revoked_at).not.toBeNull()
    expect((await http.post('/api/farewell', pc.token, { op: 'mail' })).status).toBe(401)
  })

  it("a retired computer's env id is handed on to leave every workspace's reach", async () => {
    const box = await makeBox()
    const retired: string[] = []
    ;(box.farewell as unknown as { deps: { onRetired?: (e: string) => void } }).deps.onRetired = (e) => void retired.push(e)
    const pc = await box.computer()
    const { removalId } = box.farewell.remove('env_pc')
    expect(retired).toEqual([])
    box.farewell.handle(box.principalOf(pc), { op: 'receipt', removalId, signature: box.receipt(pc, removalId) })
    expect(retired).toEqual(['env_pc'])
  })

  it('a key that is not in farewell has no farewell route', async () => {
    const box = await makeBox(Date.now())
    const pc = await box.computer()
    const http = await listen(box)
    expect((await http.post('/api/farewell', pc.token, { op: 'mail' })).status).toBe(403)
  })

  it('the sweep revokes a farewell key 30 days after its removal with no receipt', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    box.farewell.remove('env_pc')
    box.clock.now += FAREWELL_TTL_MS - 1
    expect(box.farewell.sweep()).toBe(0)
    expect(box.auth.getKey(pc.keyId)!.revokedAt).toBeNull()
    box.clock.now += 1
    expect(box.farewell.sweep()).toBe(1)
    expect(box.auth.getKey(pc.keyId)!.revokedAt).not.toBeNull()
    expect(box.bindings.get('env_pc')!.state).toBe('retired')
    expect(box.farewell.sweep()).toBe(0)
  })

  it('farewell survives a restart: the keys are read back from the removals', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    box.farewell.remove('env_pc')
    const { Farewell } = await import('./farewell')
    const again = new Farewell(box.db, { bindings: box.bindings, mailbox: box.mailbox, auth: box.auth, toGiver: () => {}, log: () => {} })
    expect(again.inFarewell(pc.keyId)).toBe(true)
  })

  it('a removal half written before a crash is finished at boot, before any request (F19)', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    const { Farewell } = await import('./farewell')
    const boot = () => new Farewell(box.db, { bindings: box.bindings, mailbox: box.mailbox, auth: box.auth, toGiver: () => {}, log: () => {} })
    // The removal row written, the binding not yet marked: an older build's crash between the two.
    box.db.prepare(`INSERT INTO device_removals (removal_id, env_id, key_id, at) VALUES (?, ?, ?, ?)`).run('r1', 'env_pc', pc.keyId, box.clock.now)
    const again = boot()
    expect(box.bindings.get('env_pc')).toMatchObject({ state: 'removing', removalId: 'r1' })
    expect(again.handle(box.principalOf(pc), { op: 'mail' })).toMatchObject({ removal: { removalId: 'r1' } })
    // Marked revoked, the key and binding still live: the next boot ends them.
    box.db.prepare(`UPDATE device_removals SET revoked_at = ? WHERE removal_id = 'r1'`).run(box.clock.now)
    boot()
    expect(box.auth.getKey(pc.keyId)!.revokedAt).not.toBeNull()
    expect(box.bindings.get('env_pc')!.state).toBe('retired')
  })

  it('Remove writes the removal and the binding together, and a binding retires only under its own removal (F19)', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    const mark = box.bindings.markRemoving.bind(box.bindings)
    box.bindings.markRemoving = () => {
      throw new Error('crash')
    }
    expect(() => box.farewell.remove('env_pc')).toThrow('crash')
    expect(box.db.prepare(`SELECT COUNT(*) AS n FROM device_removals`).get()).toEqual({ n: 0 })
    box.bindings.markRemoving = mark
    const { removalId } = box.farewell.remove('env_pc')
    box.bindings.retire('env_pc', 'another')
    expect(box.bindings.get('env_pc')!.state).toBe('removing')
    box.bindings.retire('env_pc', removalId)
    expect(box.bindings.get('env_pc')!.state).toBe('retired')
    expect(pc.keyId).toBeTruthy()
  })
})
