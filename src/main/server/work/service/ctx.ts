import { existsSync, realpathSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import type { CanvasSource, Principal } from '@shared/work'
import { fileDocName, LIFEOS_COLLAB_AUDIENCE, MAX_TOKEN_SECONDS, type CollabClaims as KitClaims, type Jwk, type TrustedIssuer } from 'work-kit/collab-server'
import { listEnvironments } from '../../remote/environments'
import type { CtxPart, WorkPartDeps } from '../ctx'
import { lifeosAddress } from '../lifeos/ctx'
import type { WorkCtx } from '../modules'
import { WORK_OFF } from '../scope'
import { lifeosServerOf, servicePaths, servicePort } from './config'
import { hostedDir, spawnServiceChild } from './spawn'
import { ServiceSupervisor, type ServiceChild } from './supervisor'

/**
 * `ctx.service` (docs/agents/work-service.md): the Work service's addresses,
 * its collaboration tokens and its internal routes. The service runs only
 * while Work is on (`deps.whileOn`); this part forks it, and a service that
 * fails is restarted with nothing of the host waiting on it.
 */

/** What a collaboration token says: one document or sheet, a role, and who holds it. Minutes long. */
export interface CollabClaims {
  item: { doc: string } | { sheet: string }
  role: 'view' | 'comment' | 'edit'
  principal: Principal
  /** a file-backed item's source, for the host that serves it */
  source?: CanvasSource
}

/** How long a token this host signs lasts; clients refresh every 45 s (M16). */
export const TOKEN_SECONDS = 5 * 60
/** How long a token or an internal call waits for a service that is still starting before it says so. */
export const STARTING_WAIT_MS = 20_000

/** The item is served by another host: the caller routes the request there (`host` is its environment id). */
export class ServedElsewhere extends Error {
  constructor(readonly host: string) {
    super(`this host does not serve that item; ${host} does`)
  }
}

/** Setting: LifeOS's collab public keys, a JWKS (`{"keys":[…]}`), so its apps' tokens open a socket here. */
export const LIFEOS_JWKS_SETTING = 'work.lifeos.jwks'
const LIFEOS_ISSUER = 'https://lifeos.landonhale.com/auth'

/** Test seams for the part as `buildWorkCtx` makes it: set before `startWork`, cleared after. */
export const serviceSeamsFor: { current: { spawn?: () => ServiceChild; hostedDir?: string; backoffMs?: number; env?: NodeJS.ProcessEnv } | null } = { current: null }

const supervisors = new WeakMap<WorkCtx, ServiceSupervisor>()
/** The host's Work service, for a test or a pillar's own proof. */
export const serviceOf = (ctx: WorkCtx): ServiceSupervisor | undefined => supervisors.get(ctx)

function lifeosIssuer(deps: WorkPartDeps, env: NodeJS.ProcessEnv): TrustedIssuer | null {
  const raw = (env.TEMP_CODE_USER_DATA && env.TEMP_CODE_LIFEOS_JWKS) || deps.store.getSetting(LIFEOS_JWKS_SETTING)
  if (!raw) return null
  try {
    // As LifeOS keeps it (a `data:` URL around base64 JSON) or as the JSON itself.
    const json = raw.startsWith('data:') ? Buffer.from(raw.slice(raw.indexOf(',') + 1), raw.includes(';base64,') ? 'base64' : 'utf8').toString('utf8') : raw
    const keys = (JSON.parse(json) as { keys?: Jwk[] }).keys
    if (!Array.isArray(keys) || keys.length === 0) return null
    const iss = (env.TEMP_CODE_USER_DATA && env.TEMP_CODE_LIFEOS_ISSUER) || LIFEOS_ISSUER
    return { by: 'lifeos', iss, aud: LIFEOS_COLLAB_AUDIENCE, keys }
  } catch {
    return null
  }
}

/**
 * One spelling for a file: resolved, with every link followed and the disk's own letter case
 * (realpath(3)), through the nearest folder that exists when the file or its folders are not made yet.
 */
export function canonicalPath(path: string): string {
  let head = resolve(path)
  const tail: string[] = []
  while (!existsSync(head)) {
    const up = dirname(head)
    if (up === head) return resolve(path)
    tail.unshift(basename(head))
    head = up
  }
  return join(realpathSync.native(head), ...tail)
}

/** The ws: or http: address of a route on this host's public listener. */
const SOCKET_ROUTE = /^\/(w\/(doc|sheet|office)|g\/ws)(\/|$)/

export const servicePart: CtxPart<'service'> = (ctx, deps) => {
  const seams = serviceSeamsFor.current ?? {}
  const env = seams.env ?? process.env
  const paths = servicePaths(deps.dataDir)
  if (paths.moved) ctx.log(`[work-service] ${deps.dataDir} is too deep for a socket's path; the socket is ${paths.socketPath}, where the LifeOS worker will not look`)
  let port = 0
  try {
    port = servicePort(env)
  } catch (err) {
    ctx.log(`[work-service] ${(err as Error).message}; using any free port`)
  }
  const lifeos = () => ({
    ...lifeosServerOf({ env, savedHosts: listEnvironments(deps.store) }),
    url: lifeosAddress(env).url
  })
  const supervisor = new ServiceSupervisor({
    spawn: seams.spawn ?? spawnServiceChild,
    host: deps.environmentId,
    port,
    ...paths,
    get hostedDir() {
      return seams.hostedDir ?? hostedDir()
    },
    lifeos,
    lifeosIssuer: () => lifeosIssuer(deps, env),
    jwt: () => ctx.lifeos.jwt(),
    log: (line) => ctx.log(line),
    ...(seams.backoffMs !== undefined ? { backoffMs: seams.backoffMs } : {})
  })
  supervisors.set(ctx, supervisor)
  // Only Electron can fork a utility process; a host run any other way (a test that brings no spawn) serves no documents.
  const canFork = !!seams.spawn || !!process.versions.electron
  deps.whileOn(() => {
    if (!canFork) return void ctx.log('[work-service] not started: this host is not running in Electron')
    void supervisor.start().catch((err: Error) => ctx.log(`[work-service] did not start: ${err.message}`))
    return () => void supervisor.stop().catch(() => {})
  })

  const running = (): void => {
    if (!ctx.enabled()) throw new Error(WORK_OFF)
    if (supervisor.state() !== 'running') throw new Error(`the Work service is not running on this host (${supervisor.state()})`)
  }
  /** As `running`, but a service still starting (Work just turned on, the host just booted) is waited for, not refused. */
  const runningSoon = async (): Promise<void> => {
    if (ctx.enabled() && supervisor.state() === 'starting') await supervisor.ready(STARTING_WAIT_MS)
    running()
  }

  return {
    service: {
      url(route) {
        running()
        if (!route.startsWith('/')) throw new Error('a route starts with /')
        return `${SOCKET_ROUTE.test(route) ? 'ws' : 'http'}://127.0.0.1:${supervisor.port()}${route}`
      },

      async token(claims) {
        await runningSoon()
        const signer = supervisor.tokenSigner()
        if (!signer) throw new Error('the Work service is not running on this host')
        if ('sheet' in claims.item) {
          // A live sheet is a LifeOS sheet, served where LifeOS's documents are (routes/sheet.ts, milestone 27).
          const server = lifeos()
          if (!server.here) {
            if (server.host === null) throw new Error('this isolated instance serves no LifeOS sheets (TEMP_CODE_WORK_LIFEOS_SERVER=here lets it)')
            throw new ServedElsewhere(server.host)
          }
          return (await signer.sign({ sheet: claims.item.sheet, role: claims.role, principal: claims.principal } as KitClaims, Math.min(TOKEN_SECONDS, MAX_TOKEN_SECONDS))).token
        }
        const kit: KitClaims = { doc: claims.item.doc, role: claims.role, principal: claims.principal }
        const source = claims.source
        if (source?.at === 'file') {
          // A file is served by the host it is on (§19), under its path's name, and a path has one spelling.
          if (source.host !== deps.environmentId) throw new ServedElsewhere(source.host)
          const path = canonicalPath(source.path)
          if (claims.item.doc !== fileDocName(path)) throw new Error('a file document is named by its resolved path (fileDocName(canonicalPath(path)))')
          kit.file = { path }
        } else if (source && !(source.at === 'lifeos' && source.table === 'docs')) {
          throw new Error('the Work service serves LifeOS documents and .tcdoc files')
        } else {
          if (claims.item.doc.startsWith('file:')) throw new Error('a file document needs its source')
          const server = lifeos()
          if (!server.here) {
            if (server.host === null) throw new Error('this isolated instance serves no LifeOS documents (TEMP_CODE_WORK_LIFEOS_SERVER=here lets it)')
            throw new ServedElsewhere(server.host)
          }
        }
        return (await signer.sign(kit, Math.min(TOKEN_SECONDS, MAX_TOKEN_SECONDS))).token
      },

      async internal(route, body) {
        await runningSoon()
        const secret = supervisor.internalSecret()
        if (!secret) throw new Error('the Work service is not running on this host')
        const payload = JSON.stringify(body ?? {})
        return new Promise((resolve, reject) => {
          let done = false
          const finish = (err: Error | null, answer?: unknown): void => {
            if (done) return
            done = true
            clearTimeout(deadline)
            if (err) reject(err)
            else resolve(answer)
          }
          // A whole call, not only a quiet socket, ends at 30 s; an answer past 16 MiB is not read.
          const deadline = setTimeout(() => req.destroy(new Error(`${route}: the Work service did not answer in 30 s`)), 30_000)
          const req = httpRequest(
            {
              socketPath: paths.socketPath,
              path: route,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${secret}` },
              timeout: 30_000
            },
            (res) => {
              const chunks: Buffer[] = []
              let size = 0
              res.on('data', (c: Buffer) => {
                size += c.length
                if (size > 16 * 1024 * 1024) return void req.destroy(new Error(`${route}: the Work service's answer is too large`))
                chunks.push(c)
              })
              res.on('error', (err) => finish(err))
              res.on('end', () => {
                let answer: unknown
                try {
                  answer = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                } catch {
                  return finish(new Error(`${route}: the Work service did not answer in JSON`))
                }
                if ((res.statusCode ?? 500) >= 400) return finish(new Error((answer as { error?: string }).error ?? `${route}: ${res.statusCode}`))
                finish(null, answer)
              })
            }
          )
          req.on('timeout', () => req.destroy(new Error(`${route}: the Work service did not answer in 30 s`)))
          req.on('error', (err) => finish(err))
          req.end(payload)
        })
      }
    }
  }
}
