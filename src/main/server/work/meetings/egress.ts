import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * Running a child with the network blocked (docs/agents/work-meetings.md,
 * "The pipeline"). A recording is transcribed on the host that holds it and
 * no part of it goes to any service: the decoder and the transcriber run
 * inside a block the child cannot lift. Linux: a new user and network
 * namespace (`unshare -r -n`), whose only interface is a loopback that is
 * down. macOS: `sandbox-exec` with every network operation denied. Anything
 * else has no block, and a transcription there refuses to run: there is no
 * unblocked fallback and no switch to turn the block off.
 */

const UNSHARE = '/usr/bin/unshare'
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const DENY_NETWORK = '(version 1)(allow default)(deny network*)'

export interface BlockHost {
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
}

/** `cmd args` wrapped so it runs with no network at all, or null where this host has no such block. */
export function noNetwork(cmd: string, args: string[], host: BlockHost = {}): { cmd: string; args: string[] } | null {
  const platform = host.platform ?? process.platform
  const exists = host.exists ?? existsSync
  if (platform === 'linux' && exists(UNSHARE)) return { cmd: UNSHARE, args: ['-r', '-n', '--', cmd, ...args] }
  if (platform === 'darwin' && exists(SANDBOX_EXEC)) return { cmd: SANDBOX_EXEC, args: ['-p', DENY_NETWORK, cmd, ...args] }
  return null
}

/** How the block works on this host, in a few words: what a summary names. */
export const blockHow = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'linux' ? 'unshare -r -n (a user and network namespace of its own)' : platform === 'darwin' ? 'sandbox-exec (deny network*)' : 'none'

export type NetworkBlock = { ok: true; how: string } | { ok: false; why: string }

let checked: Promise<NetworkBlock> | null = null

/** Whether a child really runs inside the block here: tried once per process. */
export function networkBlock(): Promise<NetworkBlock> {
  checked ??= tryBlock()
  return checked
}

export async function canBlockNetwork(): Promise<boolean> {
  return (await networkBlock()).ok
}

async function tryBlock(): Promise<NetworkBlock> {
  const wrapped = noNetwork('/bin/sh', ['-c', 'exit 0'])
  if (!wrapped) return { ok: false, why: `${process.platform} has no way here to run a child with the network blocked` }
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(wrapped.cmd, wrapped.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, why: `${wrapped.cmd} would not start: ${err.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const said = out.trim().split('\n').slice(-2).join(' / ').slice(0, 300)
      resolve(code === 0 ? { ok: true, how: blockHow() } : { ok: false, why: `${wrapped.cmd} exited ${code ?? 'on a signal'}${said ? `: ${said}` : ''}` })
    })
  })
}

/** The sentence a transcription refuses with when the block is not there. */
export const refusalOf = (why: string): string => `This host cannot run a transcription with the network blocked: ${why}.`
