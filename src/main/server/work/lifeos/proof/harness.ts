import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Headless instances of the BUILT tree for milestone 7's proofs (the shape
 * of scripts/e2e-addons.ts): each with its own HOME, its own Aliax vault
 * (`TEMP_CODE_ALIAX_DATA_DIR`), its own data folder and a dead provider, so
 * nothing touches the installed app, the box's service or the real vault.
 * Driven over the local socket (the implicit admin). Run from the repo root
 * after `electron-vite build`.
 */

export const REPO = process.cwd()
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let failures = 0
export const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
export const failed = (): number => failures
export const note = (m: string): void => console.log(`      ${m}`)

export const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

export const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(250)
  }
  note(`timed out: ${label}`)
  return false
}

export interface Inst {
  name: string
  home: string
  data: string
  tmp: string
  work: string
  remote: number
  log: string
  proc?: ChildProcess
}

export class Proof {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'tc-m7-proof-')))
  private readonly children: ChildProcess[] = []
  readonly instances: Inst[] = []

  async instance(name: string): Promise<Inst> {
    const inst: Inst = {
      name,
      home: join(this.root, `${name}-home`),
      data: join(this.root, `${name}-data`),
      tmp: join(this.root, `${name}-tmp`),
      work: join(this.root, `${name}-work`),
      remote: await freePort(),
      log: join(this.root, `${name}.log`)
    }
    for (const d of [inst.data, inst.tmp, inst.work, inst.home]) mkdirSync(d, { recursive: true })
    this.instances.push(inst)
    return inst
  }

  /** A child this proof owns: killed with its group at the end. */
  own(proc: ChildProcess): ChildProcess {
    this.children.push(proc)
    return proc
  }

  launch(inst: Inst, opts: { platform: 'darwin' | 'linux'; env?: Record<string, string> }): void {
    const base = Object.fromEntries(
      Object.entries(process.env as Record<string, string>).filter(([k]) => !k.startsWith('TEMP_CODE_') && !k.startsWith('CLAUDE') && k !== 'ANTHROPIC_BASE_URL' && k !== 'ELECTRON_RUN_AS_NODE')
    )
    const env: Record<string, string> = {
      ...base,
      HOME: inst.home,
      TMPDIR: inst.tmp,
      TEMP_CODE_USER_DATA: inst.data,
      TEMP_CODE_HEADLESS: '1',
      TEMP_CODE_REMOTE_PORT: String(inst.remote),
      TEMP_CODE_CLAIM_SHIM: '0',
      TEMP_CODE_WORK_ROOT: inst.work,
      TEMP_CODE_E2E_STATUS: '1',
      TEMP_CODE_BUILD_PLATFORM: opts.platform,
      TEMP_CODE_ADDON_TRACE: '1',
      TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'),
      TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9',
      AGENT_CLI_CREDENTIAL_STORE: 'file',
      NODE_ENV: 'production',
      SHELL: '/bin/bash',
      ...opts.env
    }
    const electron = join(REPO, 'node_modules', '.bin', 'electron')
    const argv = process.platform === 'linux' ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.'] : [electron, '.']
    const proc = spawn(argv[0]!, argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
    proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
    this.own(proc)
    inst.proc = proc
  }

  logOf(inst: Inst): string {
    return existsSync(inst.log) ? readFileSync(inst.log, 'utf8') : ''
  }

  async up(inst: Inst): Promise<boolean> {
    return until(`${inst.name} up`, 120_000, () => existsSync(join(inst.data, 'server.json')))
  }

  async down(inst: Inst): Promise<void> {
    const pid = inst.proc?.pid
    if (!pid) return
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(-pid, sig)
      } catch {
        /* gone */
      }
      await sleep(1500)
    }
    inst.proc = undefined
  }

  async close(keep = process.env.TC_M7_KEEP === '1'): Promise<void> {
    for (const inst of this.instances) await this.down(inst)
    for (const proc of this.children) {
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL')
      } catch {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
    if (!keep) rmSync(this.root, { recursive: true, force: true })
    else note(`kept ${this.root}`)
  }
}

const portOf = (inst: Inst): number => (JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }).port

/** One request on the instance's local socket (the implicit admin). */
export async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(inst)}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`${inst.name}: no answer to ${method}`))
    }, timeoutMs)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'proof', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'proof') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(frame.error))
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error(`${inst.name}: socket error on ${method}`))
    })
  })
}

/** Every frame the instance's local socket hears while it is open: the wire a screen reads. */
export function listen(inst: Inst): { frames: string[]; close(): void } {
  const frames: string[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(inst)}/`)
  ws.addEventListener('message', (ev) => frames.push(String(ev.data)))
  return { frames, close: () => ws.close() }
}

export const textOf = (r: { content: { type: string; text?: string }[] }): string => r.content.map((c) => c.text ?? `[${c.type}]`).join('\n')

/** Pairs `client` to `home` as the e2e proofs do: an admin key of the home's, added on the client. */
export async function pair(proof: Proof, client: Inst, home: Inst, homeName: string): Promise<string> {
  const clientId = (await rpc<{ environmentId: string }>(client, 'remote.status')).environmentId
  const key = await rpc<{ token: string }>(home, 'remote.keys.create', { name: `${client.name} (m7 proof)`, audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(client, 'remote.environments.add', { url: `http://127.0.0.1:${home.remote}`, key: key.token, name: homeName })
  check(`${home.name} logged ${client.name}'s registration`, await until('registers', 60_000, () => proof.logOf(home).includes(`[peer-calls] ${clientId} registered`)))
  return clientId
}
