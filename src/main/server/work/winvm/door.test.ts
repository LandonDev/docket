import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { doorSpawn, GUEST_DATA_DIR, guestInit, homePictures } from './door'

/**
 * The VM's spawn over a stand-in door on a unix socket: the knock comes
 * first, `initialize` names the guest's folder, a picture the service names
 * is copied home and its path rewritten, frames keep their order, and the
 * machine going to sleep ends the "child" cleanly.
 */

let dir: string
let server: Server
let conns: Socket[]
let received: string[]
const TOKEN = 'k'.repeat(64)

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'winvm-door-'))
  conns = []
  received = []
  server = createServer((s) => {
    conns.push(s)
    let buf = ''
    s.on('data', (b) => {
      buf += b.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        received.push(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    })
  })
  await new Promise<void>((r) => server.listen(join(dir, 'door.sock'), r))
})
afterEach(async () => {
  for (const c of conns) c.destroy()
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function spawnDoor(fetched: string[] = []) {
  const host = join(dir, 'host')
  const door = doorSpawn({
    door: async () => ({ socket: join(dir, 'door.sock'), token: TOKEN }),
    fetch: async (rel, local) => {
      fetched.push(rel)
      writeFileSync(local, `copy of ${rel}`)
    },
    hostDataDir: host
  })
  const child = door.spawn('tc-computer.exe', ['serve'], {}) as unknown as import('node:child_process').ChildProcess
  return { door, child, host }
}

describe("the VM's spawn through the door", () => {
  it('knocks with the token first, then carries the wire with initialize naming the guest folder', async () => {
    const { child } = spawnDoor()
    await new Promise<void>((r) => child.once('spawn', () => r()))
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { dataDir: '/box/winvm/computer', protocol: 1 } }) + '\n')
    await until(() => received.length >= 2)
    expect(received[0]).toBe(TOKEN)
    expect(JSON.parse(received[1]).params).toEqual({ dataDir: GUEST_DATA_DIR, protocol: 1 })
  })

  it('copies a picture the service names home over the connection, rewrites its path, and keeps the frames in order', async () => {
    const fetched: string[] = []
    const { child, host } = spawnDoor(fetched)
    await new Promise<void>((r) => child.once('spawn', () => r()))
    const lines: string[] = []
    child.stdout!.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean)))
    const shot = `${GUEST_DATA_DIR}\\shots\\s1\\1.png`
    conns[0].write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { shot: { path: shot, width: 10 } } }) + '\n')
    conns[0].write(JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }) + '\n')
    await until(() => lines.length >= 2)
    const first = JSON.parse(lines[0])
    expect(first.id).toBe(2)
    expect(first.result.shot.path).toBe(join(host, 'shots', 's1', '1.png'))
    expect(readFileSync(first.result.shot.path, 'utf8')).toBe('copy of AppData/Local/TempCode/computer/shots/s1/1.png')
    expect(fetched).toEqual(['AppData/Local/TempCode/computer/shots/s1/1.png'])
    expect(JSON.parse(lines[1]).id).toBe(3)
  })

  it('the machine going to sleep ends it with a clean exit, which the service reads as idle, not a crash', async () => {
    const { door, child } = spawnDoor()
    await new Promise<void>((r) => child.once('spawn', () => r()))
    const exit = new Promise<number>((r) => child.once('exit', (code: number) => r(code)))
    door.closeAll()
    expect(await exit).toBe(0)
  })

  it('asks again while the door says another host is in (the keeper\'s knock still ending), then gets in', async () => {
    let busy = 2
    server.removeAllListeners('connection')
    server.on('connection', (s: Socket) => {
      conns.push(s)
      s.once('data', () => {
        if (busy-- > 0) {
          s.write('{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"another host is connected"}}\n')
          s.end()
        } else s.on('data', (b) => received.push(...b.toString().split('\n').filter(Boolean)))
      })
    })
    const { child } = spawnDoor()
    await new Promise<void>((r) => child.once('spawn', () => r()))
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'state.get', params: {} }) + '\n')
    await until(() => received.length >= 1)
    expect(conns).toHaveLength(3)
    expect(JSON.parse(received[0]).method).toBe('state.get')
  })

  it('gives up on a door that stays busy, saying so', async () => {
    server.removeAllListeners('connection')
    server.on('connection', (s: Socket) => {
      conns.push(s)
      s.once('data', () => s.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"another host is connected"}}\n'))
    })
    const door = doorSpawn({ door: async () => ({ socket: join(dir, 'door.sock'), token: TOKEN }), fetch: async () => {}, hostDataDir: dir, busyWaitMs: 400 })
    const child = door.spawn('x', [], {}) as unknown as import('node:child_process').ChildProcess
    const err = await new Promise<Error>((r) => child.once('error', r))
    expect(err.message).toBe('another host is connected to the service in the Windows VM')
  })

  it('a door that cannot be woken fails the spawn with why', async () => {
    const door = doorSpawn({ door: async () => Promise.reject(new Error('The Windows VM is not set up.')), fetch: async () => {}, hostDataDir: dir })
    const child = door.spawn('x', [], {}) as unknown as import('node:child_process').ChildProcess
    const err = await new Promise<Error>((r) => child.once('error', r))
    expect(err.message).toBe('The Windows VM is not set up.')
  })
})

describe('the frames', () => {
  it('leaves every frame but initialize as it is', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'state.get', params: { dataDir: '/x' } })
    expect(guestInit(line, GUEST_DATA_DIR)).toBe(line)
  })

  it('copies nothing outside the guest folder and never a path that steps out of it', async () => {
    const fetched: string[] = []
    const fetch = async (rel: string) => void fetched.push(rel)
    const out = await homePictures(JSON.stringify({ a: { path: 'C:\\Windows\\win.ini' }, b: { path: `${GUEST_DATA_DIR}\\..\\..\\x.png` } }), GUEST_DATA_DIR, dir, fetch)
    expect(fetched).toEqual([])
    expect(JSON.parse(out).a.path).toBe('C:\\Windows\\win.ini')
  })
})
