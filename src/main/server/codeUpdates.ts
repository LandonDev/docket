import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'
import type { ServerPush } from '@shared/contract'
import type { CodeChunk, CodeSettings } from '@shared/contract-code'
import {
  CODE_AVAILABLE_PUSH,
  CODE_CHUNK_BYTES,
  CODE_MAX_UNPACKED_BYTES,
  CODE_UPDATES_OFF,
  CODE_UPDATES_SETTING,
  chosenHost,
  decideOffer,
  fellBackLine,
  insecureLine,
  refusedLine,
  type CodeHost,
  type CodeUpdateStatus
} from '@shared/codeUpdate'
import type { CodeBoot } from '../codeChoice'
import { PACK_MANIFEST, offerHead, type CodeOfferHead } from './codeOffer'
import type { LinkRequest } from './remote/peerCalls'

/**
 * The Mac's side of a code-only update (docs/agents/code-only-updates.md).
 * A host this Mac links to as admin says it packed a commit's code
 * (`code-available` on the link, or `code.latest` asked when the link comes
 * up); this Mac asks for the manifest, lets its own boot code judge it
 * (`CodeBoot.refusal`: the base stamp, the release), fetches the packed tree
 * in chunks over the same link, checks its size and sha256, unpacks it under
 * `<userData>/code/` and hands it to boot (`CodeBoot.offer`), which checks
 * the entry files again. Then the update row offers "Restart to update";
 * nothing runs before that restart, and boot gives the tree one trial
 * (src/main/codeChoice.ts).
 *
 * Who may put code here: the ONE host the setting names (`chosenHost`), a
 * saved environment whose key holds admin, over the link this Mac dialed to
 * it, and only when that link cannot be read or answered for by the network
 * (`routeIsSecure`: TLS or loopback). The Mac's only admin host is chosen at
 * first use and written down; a host saved later is never taken on its own
 * word, since a host states its own caps when it is saved. The bytes are
 * fetched by this Mac from that host; no caller can hand them in. A fetch
 * that breaks off keeps its part file and goes on from there at the next
 * offer. A pack that failed its checks is not fetched again until the host
 * has another.
 */

export const INCOMING_DIR = 'incoming'
const CHUNK_TIMEOUT_MS = 120_000

export interface CodeUpdatesDeps {
  /** What boot.ts picked (codeBoot.ts); null where boot.js did not start the process. */
  boot: CodeBoot | null
  getSetting: (key: string) => string | null
  setSetting: (key: string, value: string) => void
  /** The saved environments whose key holds admin. */
  adminHosts: () => CodeHost[]
  /** The connected link to a host, or null. */
  link: (envId: string) => LinkRequest | null
  /** Whether the link to `envId` is one code may cross (routeIsSecure on the route it opened). */
  secure: (envId: string) => boolean
  /** Every change of the status, whole (update.ts shows it). */
  onStatus?: (status: CodeUpdateStatus) => void
  /** Unpack a .tar.gz into an empty folder; the system tar when absent. */
  extract?: (tarball: string, dest: string) => Promise<void>
  log?: (line: string) => void
}

const systemTar = (tarball: string, dest: string): Promise<void> =>
  new Promise((done, fail) => {
    execFile(existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar', ['-xzf', tarball, '-C', dest], { timeout: 120_000 }, (err, _out, stderr) =>
      err ? fail(new Error(`tar: ${String(stderr || err.message).split('\n')[0]}`)) : done()
    )
  })

/** The bytes a .tar.gz unpacks to, counted without writing any; rejects past `limit`. */
export const unpackedBytes = (path: string, limit: number): Promise<number> =>
  new Promise((done, fail) => {
    let total = 0
    const source = createReadStream(path)
    const gunzip = createGunzip()
    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        source.destroy()
        gunzip.destroy()
        fail(new Error(`the pack unpacks to more than ${Math.round(limit / (1024 * 1024))} MB`))
      }
    })
    gunzip.on('end', () => done(total))
    gunzip.on('error', fail)
    source.on('error', fail)
    source.pipe(gunzip)
  })

/** Remove a folder a pack may have left unreadable: its modes are opened first when the plain remove fails. */
function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    try {
      execFileSync('chmod', ['-R', 'u+rwX', path], { stdio: 'ignore' })
    } catch {
      // nothing to open
    }
    rmSync(path, { recursive: true, force: true })
  }
}

const sha256OfFile = (path: string): Promise<string> =>
  new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')))
  })

/** What an unpacked pack may hold: one `out/` of plain files and folders. The first thing that is not, or null. */
export function treeProblem(dest: string): string | null {
  const top = readdirSync(dest)
  if (top.length !== 1 || top[0] !== 'out') return `the pack holds ${top.join(', ') || 'nothing'}, not one out/`
  const walk = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const st = lstatSync(path)
      if (st.isDirectory()) {
        const inner = walk(path)
        if (inner) return inner
      } else if (!st.isFile()) return `${path.slice(dest.length + 1)} is not a plain file`
    }
    return null
  }
  return walk(join(dest, 'out'))
}

export class CodeUpdates {
  private status: CodeUpdateStatus = {}
  private busy: Promise<void> | null = null
  /** A host that offered while a fetch ran: asked once that fetch ends. */
  private again: string | null = null
  private answered = false
  private mounted = false
  /** Packs that failed their checks, by commit: the tarball's sha256. Not fetched again until the host has another. */
  private readonly bad = new Map<string, string>()

  constructor(private readonly deps: CodeUpdatesDeps) {}

  /** The one host code is taken from, or null. The only admin host is chosen here once and written down. */
  private chosen(): string | null {
    const { host, pin } = chosenHost(this.deps.getSetting(CODE_UPDATES_SETTING), this.deps.adminHosts())
    if (pin) this.deps.setSetting(CODE_UPDATES_SETTING, pin)
    return host
  }

  private log(line: string): void {
    this.deps.log?.(`[code] ${line}`)
  }

  private set(patch: CodeUpdateStatus): void {
    this.status = { ...this.status, ...patch }
    this.deps.onStatus?.(this.status)
  }

  /** At boot: what runs, a tree that did not start (said once), a tree still waiting; then the trees no one names are removed. */
  start(): void {
    const boot = this.deps.boot
    if (!boot) return
    const staged = boot.staged()
    this.set({
      ...(boot.running ? { running: { commit: boot.running.commit, release: boot.running.release, subject: boot.running.subject } } : {}),
      ...(boot.fellBack ? { notice: fellBackLine(boot.fellBack.commit, boot.bundle.version) } : {}),
      ...(staged ? { offer: { commit: staged.commit, release: staged.release, subject: staged.subject, phase: 'ready' as const } } : {})
    })
    if (boot.fellBack) this.log(`${boot.fellBack.commit.slice(0, 7)} ${boot.fellBack.why}; running the bundle's ${boot.bundle.version}`)
    boot.sweep([INCOMING_DIR])
  }

  /** This app's own window got its first answer from this server. */
  windowAnswered(): void {
    this.answered = true
    this.maybeStarted()
  }

  /** This app's own window mounted: its app shell ran its effects (windows.ts hears `window:close-subscribe`). */
  windowMounted(): void {
    this.mounted = true
    this.maybeStarted()
  }

  /** Both signs of a launch that works: boot is told it started, and decides by itself when the tree is good. */
  private maybeStarted(): void {
    if (this.answered && this.mounted) this.deps.boot?.started()
  }

  settings(): CodeSettings {
    const boot = this.deps.boot
    return { host: this.chosen(), hosts: this.deps.adminHosts(), cannot: boot ? boot.cannot : 'not a packaged build' }
  }

  /** The choice. Null is off: it names no tree, so the next launch runs the bundle's code. A host is asked at once. */
  setHost(host: string | null): CodeSettings {
    if (host !== null && !this.deps.adminHosts().some((h) => h.id === host)) throw new Error('not a host this Mac holds an admin key for')
    if (host === null || host !== this.chosen()) {
      // Off, or another host: what the last one staged is forgotten.
      this.deps.setSetting(CODE_UPDATES_SETTING, host ?? CODE_UPDATES_OFF)
      this.deps.boot?.forget()
      this.set({ offer: undefined })
      this.deps.boot?.sweep([INCOMING_DIR])
    }
    if (host) this.consider(host)
    return this.settings()
  }

  /** A push on a link this Mac holds. The host is the link's, never the frame's own word. */
  onPeerPush(from: string, push: ServerPush): boolean {
    if (push.push !== CODE_AVAILABLE_PUSH) return false
    this.consider(from)
    return true
  }

  /** A link came up: the host may have packed code while this Mac was away. */
  linkUp(envId: string): void {
    this.consider(envId)
  }

  /** Ask `envId` for its newest pack and take it when every rule holds. One fetch at a time. */
  consider(envId: string): void {
    const boot = this.deps.boot
    if (!boot?.dir || this.chosen() !== envId) return
    if (!this.deps.secure(envId)) {
      const name = this.deps.adminHosts().find((h) => h.id === envId)?.name ?? envId
      this.log(`from ${envId}: the link is not encrypted; nothing asked`)
      if (this.status.notice !== insecureLine(name)) this.set({ notice: insecureLine(name) })
      return
    }
    if (this.busy) {
      this.again = envId
      return
    }
    this.busy = this.run(envId, boot)
      .catch((err: unknown) => {
        this.log(`from ${envId}: ${err instanceof Error ? err.message : String(err)}`)
        if (this.status.offer?.phase === 'downloading') this.set({ offer: undefined })
      })
      .finally(() => {
        this.busy = null
        const next = this.again
        this.again = null
        if (next) this.consider(next)
      })
  }

  /** The fetch under way, for a test to wait on. */
  idle(): Promise<void> {
    return this.busy ? this.busy.then(() => this.idle()) : Promise.resolve()
  }

  private async run(envId: string, boot: CodeBoot): Promise<void> {
    const request = this.deps.link(envId)
    if (!request) return
    const manifest = await request('code.latest')
    if (manifest === null || manifest === undefined) return
    const head = offerHead(manifest)
    if (!head) throw new Error('the host sent no manifest')
    const sha256 = (manifest as { tar?: { sha256?: unknown } }).tar?.sha256
    if (this.bad.get(head.commit) === sha256) return this.log(`${head.commit.slice(0, 7)} from ${envId} skipped: this pack failed its checks`)
    const staged = boot.staged()
    const decision = decideOffer({
      chosen: this.chosen() === envId,
      refusal: boot.refusal(manifest),
      commit: head.commit,
      release: head.release,
      running: boot.running,
      staged,
      failed: boot.failed()
    })
    if (decision.kind === 'skip') return this.log(`${head.commit.slice(0, 7)} from ${envId} skipped: ${decision.why}`)
    if (decision.kind === 'refuse') {
      this.log(`${head.commit.slice(0, 7)} from ${envId} refused: ${decision.line}`)
      this.set({ notice: refusedLine(head.commit, decision.line) })
      return
    }
    const started = Date.now()
    const tree = await this.fetch(envId, request, boot.dir!, manifest, head)
    // The choice may have changed while the bytes came.
    if (this.chosen() !== envId) {
      remove(tree)
      this.set({ offer: undefined })
      return
    }
    const home = join(boot.dir!, head.commit)
    remove(home)
    renameSync(tree, home)
    try {
      boot.offer(head.commit)
    } catch (err) {
      remove(home)
      if (typeof sha256 === 'string') this.bad.set(head.commit, sha256)
      const line = err instanceof Error ? err.message : String(err)
      this.set({ offer: undefined, notice: refusedLine(head.commit, line) })
      return this.log(`${head.commit.slice(0, 7)} refused by boot: ${line}`)
    }
    boot.sweep([INCOMING_DIR])
    this.set({ offer: { commit: head.commit, release: head.release, subject: head.subject, phase: 'ready' }, notice: undefined })
    this.log(`${head.commit.slice(0, 7)} (1.0.${head.release}) from ${envId} staged in ${Date.now() - started} ms`)
  }

  /** The packed tree fetched, checked and unpacked: the folder that holds its `out/` and its manifest. */
  private async fetch(envId: string, request: LinkRequest, dir: string, manifest: unknown, head: CodeOfferHead): Promise<string> {
    const sha256 = (manifest as { tar: { sha256: string } }).tar.sha256
    const incoming = join(dir, INCOMING_DIR)
    mkdirSync(incoming, { recursive: true })
    const part = join(incoming, `${head.commit}.tar.gz.part`)
    // Only this commit's part file is worth keeping.
    for (const name of readdirSync(incoming)) if (name !== `${head.commit}.tar.gz.part`) remove(join(incoming, name))
    /** The pack is not what its manifest says: dropped, and not fetched again. */
    const reject = (why: string): Error => {
      rmSync(part, { force: true })
      this.bad.set(head.commit, sha256)
      return new Error(why)
    }
    let offset = 0
    try {
      offset = statSync(part).size
    } catch {
      // nothing fetched yet
    }
    if (offset > head.bytes) {
      rmSync(part, { force: true })
      offset = 0
    }
    const offer = { commit: head.commit, release: head.release, subject: head.subject, phase: 'downloading' as const }
    this.set({ offer: { ...offer, percent: Math.floor((offset / head.bytes) * 100) } })
    while (offset < head.bytes) {
      // The choice turned off or moved to another host: the part file stays for a later offer.
      if (this.chosen() !== envId) throw new Error('no longer the host code is taken from')
      const chunk = (await request('code.chunk', { commit: head.commit, offset, length: CODE_CHUNK_BYTES }, { timeoutMs: CHUNK_TIMEOUT_MS })) as CodeChunk
      const data = Buffer.from(typeof chunk?.data === 'string' ? chunk.data : '', 'base64')
      if (data.length === 0 || data.length > CODE_CHUNK_BYTES || offset + data.length > head.bytes) throw new Error('the host sent a chunk of the wrong size')
      appendFileSync(part, data)
      offset += data.length
      this.set({ offer: { ...offer, percent: Math.floor((offset / head.bytes) * 100) } })
    }
    const got = await sha256OfFile(part)
    if (got !== sha256) throw reject(`the pack's sha256 is ${got.slice(0, 12)}, not the manifest's ${sha256.slice(0, 12)}`)
    try {
      await unpackedBytes(part, CODE_MAX_UNPACKED_BYTES)
    } catch (err) {
      throw reject(err instanceof Error ? err.message : String(err))
    }
    const tree = join(incoming, `${head.commit}.tree`)
    remove(tree)
    mkdirSync(tree)
    let problem: string | null
    try {
      await (this.deps.extract ?? systemTar)(part, tree)
      // The archive sets its own modes: a folder it made unreadable would stop the walk and the remove.
      execFileSync('chmod', ['-R', 'u+rwX', tree], { stdio: 'ignore' })
      problem = treeProblem(tree)
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err)
    }
    if (problem) {
      remove(tree)
      throw reject(problem)
    }
    writeFileSync(join(tree, PACK_MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
    rmSync(part, { force: true })
    return tree
  }
}
