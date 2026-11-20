import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createCollabSigner, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE, type CollabSigner, type TrustedIssuer } from 'work-kit/collab-server'
import type { FromService, LifeosServer, ServiceConfig, ServiceLink, ServiceProject, ToService } from './wire'

/**
 * Main's side of the Work service (docs/agents/work-service.md): forks the
 * utility process while Work is on, feeds it, restarts it when it dies and
 * stops it when Work goes off. Nothing it does can stop the host: a service
 * that will not start is logged and tried again, with a growing wait.
 */

/** The child as main sees it: Electron's utility process, or a test's stand-in. */
export interface ServiceChild {
  post(m: ToService): void
  onMessage(fn: (m: FromService) => void): void
  onExit(fn: (code: number | null) => void): void
  kill(): void
}

export interface SupervisorDeps {
  spawn(): ServiceChild
  /** this host's environment id: the signer's `iss` is `tempcode:<id>` */
  host: string
  port: number
  socketPath: string
  secretFile: string
  serviceDir: string
  hostedDir: string
  lifeos: () => LifeosServer & { url: string }
  /** LifeOS's own collab issuer, when its public keys are known here */
  lifeosIssuer: () => TrustedIssuer | null
  /** an unfenced device JWT for the owner (ctx.lifeos.jwt()) */
  jwt(): Promise<string>
  log(line: string): void
  /** first wait before a restart; doubles to 30 s */
  backoffMs?: number
  readyTimeoutMs?: number
}

export type ServiceState = 'off' | 'starting' | 'running' | 'waiting'

const MAX_BACKOFF = 30_000

export class ServiceSupervisor {
  private child: ServiceChild | null = null
  private wanted = false
  private stateNow: ServiceState = 'off'
  private portNow: number | null = null
  private signer: CollabSigner | null = null
  private issuers: TrustedIssuer[] = []
  private links: ServiceLink[] = []
  private readonly projects = new Map<string, ServiceProject>()
  private secret = ''
  private backoff: number
  private retry: ReturnType<typeof setTimeout> | null = null
  private readyWaiters: (() => void)[] = []
  /** bumps on every fork, so an old child's late message or exit is not taken for the new one's */
  private epoch = 0
  /** bumps on every start and stop; the two run one after another on `chain` */
  private gen = 0
  private chain: Promise<void> = Promise.resolve()
  private stable: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: SupervisorDeps) {
    this.backoff = deps.backoffMs ?? 1000
  }

  state(): ServiceState {
    return this.stateNow
  }

  /** The public listener's port while the service runs, else null. */
  port(): number | null {
    return this.stateNow === 'running' ? this.portNow : null
  }

  /** The issuer every token of this host is signed by; null until Work is on. */
  tokenSigner(): CollabSigner | null {
    return this.signer
  }

  /** Resolves once the service answers (or at once if it does). */
  ready(timeoutMs = 20_000): Promise<boolean> {
    if (this.stateNow === 'running') return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs)
      this.readyWaiters.push(() => {
        clearTimeout(t)
        resolve(true)
      })
    })
  }

  /**
   * Work turned on: a fresh key pair and secret for this run, then the fork. Starts and stops are
   * done one after another, and each knows its generation: a start that a stop overtook does
   * nothing, and a stop's clean-up never removes what a later start made.
   */
  start(): Promise<void> {
    if (this.wanted) return this.chain
    const gen = ++this.gen
    this.wanted = true
    this.chain = this.chain.then(() => this.doStart(gen)).catch((err: Error) => this.deps.log(`[work-service] did not start: ${err.message}`))
    return this.chain
  }

  private async doStart(gen: number): Promise<void> {
    if (gen !== this.gen) return
    const keys = await generateCollabKeys(`tc-${randomBytes(6).toString('hex')}`)
    if (gen !== this.gen) return
    const iss = `tempcode:${this.deps.host}`
    this.signer = await createCollabSigner({ privateJwk: keys.privateJwk, iss })
    this.issuers = [{ by: 'host', iss, aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }]
    this.secret = randomBytes(32).toString('base64url')
    mkdirSync(this.deps.serviceDir, { recursive: true, mode: 0o700 })
    writeFileSync(this.deps.secretFile, `${this.secret}\n`, { mode: 0o600 })
    // The mode is set only when the file is made: an older, looser file is tightened here.
    chmodSync(this.deps.secretFile, 0o600)
    if (gen !== this.gen) return
    this.fork()
  }

  private trusted(): TrustedIssuer[] {
    const lifeos = this.deps.lifeosIssuer()
    return lifeos ? [...this.issuers, lifeos] : this.issuers
  }

  private fork(): void {
    if (!this.wanted || !this.signer) return
    const epoch = ++this.epoch
    this.stateNow = 'starting'
    let child: ServiceChild
    try {
      child = this.deps.spawn()
    } catch (err) {
      this.deps.log(`[work-service] could not fork: ${(err as Error).message}`)
      return this.later()
    }
    this.child = child
    const readyTimer = setTimeout(() => {
      if (epoch !== this.epoch || this.stateNow === 'running') return
      this.deps.log('[work-service] did not answer in time; restarting it')
      child.kill()
    }, this.deps.readyTimeoutMs ?? 20_000)
    child.onMessage((m) => {
      if (epoch !== this.epoch) return
      if (m.t === 'ready') {
        clearTimeout(readyTimer)
        this.stateNow = 'running'
        this.portNow = m.port
        // The wait before a restart starts over only once the service has stayed up a minute.
        if (this.stable) clearTimeout(this.stable)
        this.stable = setTimeout(() => (this.backoff = this.deps.backoffMs ?? 1000), 60_000)
        this.deps.log(`[work-service] serving on 127.0.0.1:${m.port}`)
        for (const w of this.readyWaiters.splice(0)) w()
      } else if (m.t === 'jwt?') {
        const reply = (answer: ToService): void => {
          if (epoch !== this.epoch) return
          try {
            child.post(answer)
          } catch {
            // the child went while main asked LifeOS
          }
        }
        this.deps.jwt().then(
          (jwt) => reply({ t: 'jwt', id: m.id, jwt }),
          (err: Error) => reply({ t: 'jwt', id: m.id, error: err.message })
        )
      } else if (m.t === 'log') this.deps.log(`[work-service] ${m.line}`)
      else if (m.t === 'fault') this.deps.log(`[work-service] fault: ${m.message}`)
    })
    child.onExit((code) => {
      clearTimeout(readyTimer)
      if (this.stable) clearTimeout(this.stable)
      this.stable = null
      if (epoch !== this.epoch) return
      this.child = null
      this.portNow = null
      if (!this.wanted) return void (this.stateNow = 'off')
      this.deps.log(`[work-service] exited (${code ?? 'killed'}); starting it again in ${Math.round(this.backoff / 1000)} s`)
      this.later()
    })
    const config: ServiceConfig = {
      port: this.deps.port,
      socketPath: this.deps.socketPath,
      secret: this.secret,
      dataDir: this.deps.serviceDir,
      hostedDir: this.deps.hostedDir,
      host: this.deps.host,
      lifeos: this.deps.lifeos(),
      trusted: this.trusted(),
      links: this.links
    }
    try {
      child.post({ t: 'config', config })
      // A fresh child knows no projection: each goes again, in its own message.
      for (const [linkId, project] of this.projects) child.post({ t: 'project', linkId, project })
    } catch (err) {
      this.deps.log(`[work-service] could not be configured: ${(err as Error).message}`)
      child.kill()
    }
  }

  private later(): void {
    this.stateNow = 'waiting'
    if (this.retry) clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.retry = null
      this.fork()
    }, this.backoff)
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF)
  }

  /** The guest link rows (milestone 31 sends them): a revoked one's sockets close at once. */
  setLinks(links: ServiceLink[]): void {
    this.links = links
    this.child?.post({ t: 'links', links })
  }

  /** What a project link shows (null: nothing any more): kept here so a restarted service is told again. */
  setProject(linkId: string, project: ServiceProject | null): void {
    if (project) this.projects.set(linkId, project)
    else this.projects.delete(linkId)
    this.child?.post({ t: 'project', linkId, project })
  }

  /** LifeOS's keys changed: the service trusts the new set. */
  refreshTrusted(): void {
    this.child?.post({ t: 'trusted', trusted: this.trusted() })
  }

  /** The secret the internal routes take, while the service runs. */
  internalSecret(): string | null {
    return this.wanted ? this.secret : null
  }

  /** Work turned off, or the host closes: stop the child, take the secret and the socket away. */
  stop(): Promise<void> {
    ++this.gen
    this.wanted = false
    this.chain = this.chain.then(() => this.doStop()).catch((err: Error) => this.deps.log(`[work-service] did not stop cleanly: ${err.message}`))
    return this.chain
  }

  private async doStop(): Promise<void> {
    if (this.retry) clearTimeout(this.retry)
    if (this.stable) clearTimeout(this.stable)
    this.retry = this.stable = null
    const child = this.child
    this.child = null
    this.epoch++
    this.stateNow = 'off'
    this.portNow = null
    this.signer = null
    if (child) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill()
          resolve()
        }, 5000)
        child.onMessage((m) => {
          if (m.t !== 'stopped') return
          clearTimeout(t)
          resolve()
        })
        child.onExit(() => {
          clearTimeout(t)
          resolve()
        })
        try {
          child.post({ t: 'stop' })
        } catch {
          child.kill()
        }
      })
      child.kill()
    }
    // A start queued behind this stop has not run yet, so these are this run's files.
    for (const path of [this.deps.secretFile, this.deps.socketPath]) {
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch {
        // gone already
      }
    }
  }
}
