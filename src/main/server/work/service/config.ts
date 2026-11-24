import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LifeosServer } from './wire'

/**
 * Where the Work service listens, and which host serves LifeOS's documents
 * (architecture §8.1, §19). Pure, so a test can call each with its own env.
 */

/** The installed host's public port; only this one is named in scripts/box/ingress.yml. */
export const INSTALLED_WORK_PORT = 7695

/** The installed box's data dir (docs/box.md: /etc/temp-code.env sets it); processGuard's BOX_PROD_DATA_DIR, held equal by a test. */
export const BOX_DATA_DIR = '/srv/agents/temp-code-data'

/**
 * Whether this is an isolated instance (a dev or proof instance) rather than
 * an installed host. `TEMP_CODE_USER_DATA` alone does not say: the installed
 * box runs with it, set to its own data dir. So an instance is isolated when
 * it names a data dir that is not the box's own. A proof or dev instance on
 * the box always has a dir of its own (the single-instance lock keeps a
 * second process off the box's), so it stays isolated and never becomes a
 * second writer to the owner's documents.
 */
export function isIsolatedInstance(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = env.TEMP_CODE_USER_DATA?.trim()
  if (!dir) return false
  return resolve(dir) !== BOX_DATA_DIR
}

/**
 * Whether this host's pages reach beyond it at all: the box behind its tunnel, or a proof that names its origin
 * (`TEMP_CODE_WORK_PUBLIC_ORIGIN`). Any other host's service answers on loopback alone, which no phone opens.
 */
export function servesPublic(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.TEMP_CODE_WORK_PUBLIC_ORIGIN || (process.platform === 'linux' && !isIsolatedInstance(env))
}

/**
 * The public listener's port: `TEMP_CODE_WORK_PORT` if set, else 7695 for
 * an installed host (the box included), else 0 (any free port) for an
 * isolated instance, so two dev instances never fight over one.
 */
export function servicePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TEMP_CODE_WORK_PORT
  if (raw !== undefined && raw !== '') {
    const port = Number(raw)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`TEMP_CODE_WORK_PORT is not a port: ${raw}`)
    return port
  }
  return isIsolatedInstance(env) ? 0 : INSTALLED_WORK_PORT
}

/** A Unix socket's path holds at most 104 bytes on macOS (108 on Linux). */
const SOCKET_PATH_MAX = 100

/**
 * `<userData>/work-service.sock` and `<userData>/work-service.secret`, where
 * the LifeOS worker finds them (M17: `WORK_SERVICE_SOCK`,
 * `WORK_SERVICE_SECRET_FILE`). A data dir too deep for a socket's path (a
 * test's) puts the socket in the temp dir under a name of its own.
 */
export function servicePaths(dataDir: string): { socketPath: string; secretFile: string; serviceDir: string; moved: boolean } {
  const socket = join(dataDir, 'work-service.sock')
  const fits = Buffer.byteLength(socket) <= SOCKET_PATH_MAX
  const socketPath = fits ? socket : join(tmpdir(), `tc-work-${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}.sock`)
  return { socketPath, secretFile: join(dataDir, 'work-service.secret'), serviceDir: join(dataDir, 'work-service'), moved: !fits }
}

/**
 * Who serves LifeOS's documents (§8.1: one service per store). The box,
 * always: a Linux host serves them itself, and a host that knows a Linux
 * host (a saved host whose hello said linux) is a client of it. Only a host
 * with no box at all serves them from here. An isolated instance serves
 * none unless `TEMP_CODE_WORK_LIFEOS_SERVER` says `here` (or names the host
 * that does), so a dev instance is never a second writer to them.
 */
export function lifeosServerOf(o: {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  savedHosts: readonly { id: string; platform?: string | null }[]
}): LifeosServer {
  const env = o.env ?? process.env
  if (isIsolatedInstance(env)) {
    // An isolated instance never becomes a second writer to the owner's LifeOS documents unless a proof says so.
    const named = env.TEMP_CODE_WORK_LIFEOS_SERVER
    if (named === 'here') return { here: true }
    return { here: false, host: named || null }
  }
  if ((o.platform ?? process.platform) === 'linux') return { here: true }
  const box = o.savedHosts.find((h) => h.platform === 'linux')
  return box ? { here: false, host: box.id } : { here: true }
}

/** What a host that does not serve LifeOS documents says when asked to. */
export const notServedWords = (host: string | null): string =>
  host ? `this host does not serve LifeOS documents; ${host} does, and here they are read-only` : 'this isolated instance serves no LifeOS documents (TEMP_CODE_WORK_LIFEOS_SERVER=here lets it); here they are read-only'
