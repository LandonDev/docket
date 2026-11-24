import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnLowered } from '../../../childPriority'

/**
 * ONLYOFFICE Docs Community's `docservice`, run from the toolchain's
 * unpacked .deb as this user (docs/agents/work-sheets.md, "The full
 * editor"). Unmodified: what we write is its config, as the vendor's
 * packaging does. It takes no root, no database and no queue server (an
 * in-memory queue and editor data), and listens on a Unix socket in a 0700
 * folder, never on a TCP port: it ignores a bind address, and a path for
 * its port is the one way to keep it off every interface.
 */

/**
 * The loopback address the storage server binds and the only private
 * address the docservice may fetch from: nothing else on the box listens on
 * 127.0.0.2 alone, so the editor's own URL fetches (an image from a URL)
 * reach none of this host's other services.
 */
export const STORAGE_HOST = '127.0.0.2'

/** Separate secrets: the browser's config and sessions, the docservice's callbacks to us, and its cache links. */
export interface DsSecrets {
  browser: string
  outbox: string
  storage: string
}

/** Where the docservice lives inside the toolchain's onlyoffice folder. */
export const DS_ROOT = 'var/www/onlyoffice/documentserver'

/** The unpacked tree's own paths, as its production-linux.json names them. */
const VENDOR = {
  ds: '/var/www/onlyoffice/documentserver',
  appData: '/var/lib/onlyoffice/documentserver/App_Data',
  etc: '/etc/onlyoffice/documentserver'
}

/** A Unix socket's path is at most 107 bytes: a deep folder moves it to the temp dir under a hash. */
export function dsSocketPath(home: string): string {
  const socket = join(home, 'run', 'ds.sock')
  return Buffer.byteLength(socket) <= 100 ? socket : join(tmpdir(), `tc-full-${createHash('sha256').update(home).digest('hex').slice(0, 16)}`, 'ds.sock')
}

/**
 * Writes the docservice's config under `home/conf`: the vendor's default and
 * production files with their paths moved into the tool's folder and ours,
 * and a local.json with the socket, one secret for every token it checks
 * and signs, and leave to fetch from this host's loopback (the storage
 * server is on 127.0.0.1).
 */
export function writeDsConfig(o: { toolDir: string; home: string; socket: string; secrets: DsSecrets }): string {
  const etc = join(o.toolDir, 'etc/onlyoffice/documentserver')
  const ds = join(o.toolDir, DS_ROOT)
  const conf = join(o.home, 'conf')
  const data = join(o.home, 'data')
  mkdirSync(join(conf, 'log4js'), { recursive: true, mode: 0o700 })
  for (const dir of ['cache/files', 'docbuilder', 'Data']) mkdirSync(join(data, dir), { recursive: true, mode: 0o700 })
  writeFileSync(join(conf, 'default.json'), readFileSync(join(etc, 'default.json')))
  const production = readFileSync(join(etc, 'production-linux.json'), 'utf8')
    .split(`${VENDOR.ds}/../Data`).join(join(data, 'Data'))
    .split(VENDOR.ds).join(ds)
    .split(VENDOR.appData).join(data)
    .split(VENDOR.etc).join(conf)
  writeFileSync(join(conf, 'production-linux.json'), production)
  // Warnings and worse, as the vendor ships it; TEMP_CODE_FULL_EDITOR_LOG=info says what each request did.
  const log4js = readFileSync(join(etc, 'log4js/production.json'), 'utf8')
  writeFileSync(join(conf, 'log4js/production.json'), process.env.TEMP_CODE_FULL_EDITOR_LOG === 'info' ? log4js.replace('"WARN"', '"INFO"') : log4js)
  const browser = { string: o.secrets.browser }
  const local = {
    services: {
      CoAuthoring: {
        server: { port: o.socket },
        secret: { browser, inbox: browser, session: browser, outbox: { string: o.secrets.outbox } },
        token: { enable: { browser: true, request: { inbox: true, outbox: true } } },
        'request-filtering-agent': { allowPrivateIPAddress: false, allowMetaIPAddress: false, allowIPAddressList: [STORAGE_HOST] }
      }
    },
    storage: { fs: { secretString: o.secrets.storage } }
  }
  writeFileSync(join(conf, 'local.json'), JSON.stringify(local, null, 2), { mode: 0o600 })
  chmodSync(join(conf, 'local.json'), 0o600)
  return conf
}

/** One GET over the docservice's socket: its status and body. */
export function dsGet(socket: string, path: string, timeoutMs = 5000): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`${path}: the full editor did not answer`)))
    req.on('error', reject)
    req.end()
  })
}

/** The resident memory of every process in a group, from /proc (the docservice and the converters it starts). */
export async function groupRss(pgid: number, proc = '/proc'): Promise<number> {
  let total = 0
  const page = 4096
  for (const name of readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue
    let stat: string
    try {
      stat = await readFile(join(proc, name, 'stat'), 'utf8')
    } catch {
      continue
    }
    // pid (comm) state ppid pgrp …: comm may hold spaces and parentheses, so fields count from the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (Number(fields[2]) === pgid) total += Number(fields[21]) * page
  }
  return total
}

export interface DocserviceOpts {
  toolDir: string
  home: string
  secrets: DsSecrets
  log(line: string): void
  spawn?: typeof nodeSpawn
  /** how long a start may take before it is given up */
  readyMs?: number
}

/** One docservice process: started on demand, stopped whole (its process group). */
export class Docservice {
  readonly socket: string
  private child: ChildProcess | null = null
  private exited: Promise<void> | null = null

  constructor(private readonly o: DocserviceOpts) {
    this.socket = dsSocketPath(o.home)
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  running(): boolean {
    return this.child !== null
  }

  /** Starts it and resolves once its healthcheck answers; `onExit` hears an exit we did not ask for. */
  async start(onExit: (code: number | null) => void): Promise<void> {
    if (this.child) return
    this.killStale()
    const runDir = join(this.socket, '..')
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    chmodSync(runDir, 0o700)
    rmSync(this.socket, { force: true })
    // What the last run left in its cache is not ours to keep: every open starts from the file.
    rmSync(join(this.o.home, 'data'), { recursive: true, force: true })
    const conf = writeDsConfig({ toolDir: this.o.toolDir, home: this.o.home, socket: this.socket, secrets: this.o.secrets })
    const ds = join(this.o.toolDir, DS_ROOT)
    // Its log is kept beside its config, new each start, for whoever needs to see why it failed.
    const logFd = openSync(join(this.o.home, 'docservice.log'), 'w')
    // The doc service runs below the server (childPriority.ts).
    const child = (this.o.spawn ?? spawnLowered('tool'))('./docservice', [], {
      cwd: join(ds, 'server/DocService'),
      detached: true,
      stdio: ['ignore', logFd, 'pipe'],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: this.o.home,
        NODE_ENV: 'production-linux',
        NODE_CONFIG_DIR: conf,
        NODE_DISABLE_COLORS: '1',
        APPLICATION_NAME: 'ONLYOFFICE',
        PKG_NATIVE_CACHE_PATH: join(this.o.home, 'pkg-cache'),
        LD_LIBRARY_PATH: join(ds, 'server/FileConverter/bin')
      }
    })
    closeSync(logFd)
    this.child = child
    writeFileSync(join(runDir, 'docservice.pid'), String(child.pid ?? ''))
    let tail = ''
    const keep = (c: Buffer): void => {
      tail = (tail + c.toString()).slice(-2000)
    }
    child.stderr?.on('data', keep)
    this.exited = new Promise((resolve) =>
      child.once('exit', (code) => {
        const asked = this.child !== child
        if (!asked) this.child = null
        if (!asked) {
          // Its converters are in its group and outlive it: they go too.
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL')
          } catch {
            /* gone */
          }
          this.o.log(`[full-editor] the docservice exited (${code}): ${tail.trim().split('\n').slice(-3).join(' | ')}`)
          onExit(code)
        }
        resolve()
      })
    )
    let failed: Error | null = null
    child.once('error', (err) => {
      failed = err
      this.o.log(`[full-editor] the docservice did not start: ${err.message}`)
      if (this.child === child) this.child = null
    })
    const deadline = Date.now() + (this.o.readyMs ?? 90_000)
    while (Date.now() < deadline) {
      if (failed || this.child !== child) throw new Error('The full editor stopped while it started.')
      const ok = await dsGet(this.socket, '/healthcheck', 2000).catch(() => null)
      if (ok?.status === 200 && ok.body.toString().trim() === 'true') return
      await new Promise((r) => setTimeout(r, 400))
    }
    await this.stop()
    throw new Error('The full editor did not start in time.')
  }

  /** Stops the whole group: TERM, then KILL after five seconds. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child?.pid) return
    this.child = null
    const group = -child.pid
    try {
      process.kill(group, 'SIGTERM')
    } catch {
      /* already gone */
    }
    const killed = setTimeout(() => {
      try {
        process.kill(group, 'SIGKILL')
      } catch {
        /* gone */
      }
    }, 5000)
    await this.exited
    clearTimeout(killed)
    rmSync(this.socket, { force: true })
    rmSync(join(this.socket, '..', 'docservice.pid'), { force: true })
  }

  /** A docservice a run of ours left behind (the app was killed): stopped before another starts on its socket. */
  private killStale(): void {
    const file = join(this.socket, '..', 'docservice.pid')
    if (!existsSync(file)) return
    const pid = Number(readFileSync(file, 'utf8'))
    rmSync(file, { force: true })
    if (!Number.isInteger(pid) || pid <= 1) return
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      if (!cmd.includes('docservice')) return
      process.kill(-pid, 'SIGKILL')
      this.o.log(`[full-editor] stopped a docservice an earlier run left (${pid})`)
    } catch {
      /* not running */
    }
  }
}
