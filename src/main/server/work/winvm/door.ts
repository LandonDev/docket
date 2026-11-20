import type { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { dirname, join, win32 } from 'node:path'
import { PassThrough } from 'node:stream'

/**
 * The VM's `ComputerService` spawn (docs/agents/work-winvm.md "The service on
 * the box"): in place of a child process, a connection to the guest's door
 * (docs/computer-protocol.md §29.1) through the keeper's SSH forward, knocked
 * with the token. What the host writes to the child's stdin goes to the door
 * and what the door answers comes out of its stdout, so `ComputerConnection`
 * reads it as it reads a child.
 *
 * The host's data dir is a box path the guest cannot write: `initialize`
 * carries the guest's own folder in its place, and every picture the service
 * names under it is copied home over the same SSH connection and its path
 * rewritten, before the frame reaches the host, as if the service had
 * written it on this machine. Frames keep their order.
 */

/** Where the guest's service keeps its pictures: tcuser's own, outside the four folders nothing may run from. */
export const GUEST_DATA_DIR = 'C:\\Users\\tcuser\\AppData\\Local\\TempCode\\computer'
const GUEST_HOME = 'C:\\Users\\tcuser'

/** How long a spawn asks again while the door says another host is in. */
export const BUSY_WAIT_MS = 10_000
/** How long a spawn waits after its knock for the door's busy line: a door that lets it in says nothing first. */
const BUSY_LISTEN_MS = 250
const BUSY = 'another host is connected'

/**
 * One knock: the connection once the door let it in, or null when it said another host is in. Anything the
 * door sends past its silence is the service's own and is handed back to the stream.
 */
function enter(socket: string, token: string): Promise<Socket | null> {
  return new Promise((resolve, reject) => {
    const s = connect(socket)
    let got = ''
    let timer: NodeJS.Timeout | null = null
    const onData = (b: Buffer): void => {
      got += b.toString()
      if (got.includes(BUSY)) {
        if (timer) clearTimeout(timer)
        s.off('data', onData)
        s.destroy()
        resolve(null)
      }
    }
    s.once('connect', () => {
      s.write(`${token}\n`)
      s.on('data', onData)
      timer = setTimeout(() => {
        s.off('data', onData)
        // held until the stream reads it, so nothing the service says first is lost
        s.pause()
        if (got) s.unshift(Buffer.from(got))
        resolve(s)
      }, BUSY_LISTEN_MS)
    })
    s.once('error', (e) => {
      if (timer) clearTimeout(timer)
      reject(e)
    })
  })
}

export interface DoorSpawnOptions {
  /** wakes the machine and answers the forward's socket and the token (the keeper's `door()`) */
  door(): Promise<{ socket: string; token: string }>
  /** copies a file under tcuser's profile (forward slashes) to a box path (the keeper's `fetch`) */
  fetch(rel: string, local: string): Promise<void>
  /** the box folder the pictures land in: the `ComputerService`'s dataDir */
  hostDataDir: string
  guestDataDir?: string
  log?(line: string): void
  /** BUSY_WAIT_MS but in a test */
  busyWaitMs?: number
}

type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  stdio: unknown[]
  pid: number
  exitCode: number | null
  signalCode: null
  killed: boolean
  kill(): boolean
}

export interface DoorSpawn {
  spawn: typeof nodeSpawn
  /** Ends every connection: the machine goes to sleep, and the service with it (a clean exit, never a crash). */
  closeAll(): void
}

export function doorSpawn(o: DoorSpawnOptions): DoorSpawn {
  const guestDir = o.guestDataDir ?? GUEST_DATA_DIR
  const live = new Set<FakeChild>()
  const spawn = ((): FakeChild => {
    const child = new EventEmitter() as FakeChild
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdio = [child.stdin, child.stdout, child.stderr]
    // no process of its own on this machine: nothing to put in a job or to signal
    child.pid = 0
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    live.add(child)
    let sock: Socket | null = null
    let ended = false
    const exit = (code: number): void => {
      if (ended) return
      ended = true
      live.delete(child)
      child.exitCode = code
      child.stdout.end()
      child.stderr.end()
      setImmediate(() => {
        child.emit('exit', code, null)
        child.emit('close', code, null)
      })
    }
    const ready: Promise<Socket> = o.door().then(async ({ socket, token }) => {
      const end = Date.now() + (o.busyWaitMs ?? BUSY_WAIT_MS)
      for (;;) {
        if (ended) throw new Error('stopped before the door opened')
        const s = await enter(socket, token)
        if (s) return s
        // the door lets one host in at a time, and frees the place only once the last host's service has ended
        // (the keeper's knock, a service just stopped): it is asked again for a few seconds
        if (Date.now() >= end) throw new Error('another host is connected to the service in the Windows VM')
        await new Promise((r) => setTimeout(r, 300))
      }
    })
    let inBuf = ''
    child.stdin.on('data', (b: Buffer) => {
      inBuf += b.toString()
      let nl: number
      while ((nl = inBuf.indexOf('\n')) >= 0) {
        const line = inBuf.slice(0, nl)
        inBuf = inBuf.slice(nl + 1)
        const out = guestInit(line, guestDir)
        void ready.then((s) => s.write(out + '\n'), () => {})
      }
    })
    let outBuf = ''
    let queue: Promise<void> = Promise.resolve()
    ready.then(
      (s) => {
        sock = s
        child.emit('spawn')
        s.on('data', (b: Buffer) => {
          outBuf += b.toString()
          let nl: number
          while ((nl = outBuf.indexOf('\n')) >= 0) {
            const line = outBuf.slice(0, nl)
            outBuf = outBuf.slice(nl + 1)
            queue = queue.then(async () => {
              const frame = await homePictures(line, guestDir, o.hostDataDir, o.fetch).catch((e: Error) => {
                o.log?.(`winvm: a picture did not come home: ${e.message}`)
                return line
              })
              if (!ended) child.stdout.write(frame + '\n')
            })
          }
        })
        s.on('close', () => void queue.then(() => exit(0)))
        s.on('error', () => {})
        s.resume()
      },
      (e: Error) => {
        child.stderr.write(`${e.message}\n`)
        child.emit('error', e)
        exit(1)
      }
    )
    child.kill = () => {
      child.killed = true
      if (sock) sock.destroy()
      else exit(0)
      return true
    }
    return child
  }) as unknown as typeof nodeSpawn
  return {
    spawn,
    closeAll: () => {
      for (const c of [...live]) c.kill()
    }
  }
}

/** `initialize` with the guest's folder for the host's: the service writes where tcuser can. */
export function guestInit(line: string, guestDir: string): string {
  if (!line.includes('"initialize"')) return line
  try {
    const f = JSON.parse(line) as { method?: string; params?: { dataDir?: string } }
    if (f.method !== 'initialize' || !f.params) return line
    f.params.dataDir = guestDir
    return JSON.stringify(f)
  } catch {
    return line
  }
}

/** Every `"path"` under the guest's folder in a frame, copied home and rewritten to the box's copy. */
export async function homePictures(line: string, guestDir: string, hostDir: string, fetch: DoorSpawnOptions['fetch']): Promise<string> {
  if (!line.includes('"path"')) return line
  const frame = JSON.parse(line) as unknown
  const lower = guestDir.toLowerCase()
  const jobs: Promise<void>[] = []
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'path' && typeof x === 'string' && x.toLowerCase().startsWith(lower + '\\')) {
        const parts = win32.relative(guestDir, x).split('\\')
        // never a step out of the folder, whatever the frame says
        if (parts.some((p) => p === '..' || p === '')) continue
        const local = join(hostDir, ...parts)
        mkdirSync(dirname(local), { recursive: true })
        const rel = win32.relative(GUEST_HOME, x).split('\\').join('/')
        jobs.push(fetch(rel, local))
        ;(v as Record<string, unknown>)[k] = local
      } else walk(x)
    }
  }
  walk(frame)
  await Promise.all(jobs)
  return JSON.stringify(frame)
}
