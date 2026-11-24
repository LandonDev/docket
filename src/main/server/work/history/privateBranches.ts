import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { BranchRow, BranchStatus, CollabFile, NewBranch, NewVersion, VersionContent, VersionRow, VersionStore } from 'work-kit/collab-server'

/**
 * Agent suggestions stay private (docs/agents/work-docs.md, the owner's
 * ruling of 2026-11-23: nothing an agent suggests reaches anyone else until he
 * approves it and the file is really edited).
 *
 * work-kit's `FileVersionStore` keeps a `.tcdoc`'s branches inside the zip
 * (`branches/<id>.yjs`), so a file in a OneDrive, Teams or cloud folder, or
 * one he copies or mails, would carry an agent's pending words to whoever
 * opens it. This store keeps every branch an agent wrote under this host's
 * own data instead (`<service data>/private-branches/<sha256 of the path>/`,
 * 0700), for every `.tcdoc`: a path's sharing can change with no write (a
 * move into a synced folder), so none is trusted to stay private.
 *
 * - Versions, and the branches of people (a Word author's `external:`, a
 *   restore of his own), stay in the file as before.
 * - Reads list both places, so nothing already pending is lost, and the
 *   first call that touches a file moves any agent branch it still holds
 *   out of it.
 * - A branch that is decided (merged or dropped) is removed here: accepted
 *   words are in the file as an ordinary edit, rejected ones are gone.
 * - Keyed by the file's path: a `.tcdoc` moved or renamed leaves its pending
 *   agent suggestions behind (the agent suggests again).
 *
 * Loaded by the service's entry: node, work-kit and fflate only
 * (service/boundary.test.ts).
 */

/** Whose suggestions are an agent's: TempCode's threads (`agent:<host>:<thread>`) and LifeOS's bot keys. */
export const AGENT_PRINCIPALS = ['agent:', 'lifeos:bot:'] as const

export const isAgentPrincipal = (principal: string): boolean => AGENT_PRINCIPALS.some((p) => principal.startsWith(p))

/** A branch any agent wrote: kept private, and left out of every export. */
export const isAgentBranch = (branch: { authors: readonly string[] }): boolean => branch.authors.some(isAgentPrincipal)

const BRANCHES_INDEX = 'branches/index.json'
const INDEX = 'index.json'

const newId = (): string => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** Written whole under a temp name and renamed: a reader sees the old file or the new one. */
function land(path: string, data: Uint8Array | string, mode?: number): void {
  const temp = `${path}.${process.pid}.writing`
  writeFileSync(temp, data, mode === undefined ? {} : { mode })
  renameSync(temp, path)
}

export class PrivateBranchStore implements VersionStore {
  readonly kind = 'file' as const
  constructor(
    private readonly inner: VersionStore,
    /** this host's own folder for them, outside any synced folder */
    private readonly root: string,
    private readonly now: () => number = Date.now
  ) {}

  /** The folder a file's agent branches are kept in. */
  dirOf(file?: CollabFile): string {
    if (!file) throw new Error('a file document needs its file')
    return join(this.root, createHash('sha256').update(file.path).digest('hex').slice(0, 32))
  }

  private rows(file?: CollabFile): BranchRow[] {
    const index = join(this.dirOf(file), INDEX)
    return existsSync(index) ? (JSON.parse(readFileSync(index, 'utf8')) as BranchRow[]) : []
  }

  private save(file: CollabFile | undefined, rows: BranchRow[], states: Record<string, Uint8Array | null> = {}): void {
    const dir = this.dirOf(file)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const [id, state] of Object.entries(states)) {
      if (state) land(join(dir, `${id}.yjs`), state, 0o600)
      else rmSync(join(dir, `${id}.yjs`), { force: true })
    }
    if (rows.length) land(join(dir, INDEX), JSON.stringify(rows), 0o600)
    else rmSync(dir, { recursive: true, force: true })
  }

  /**
   * Moves any agent branch the file still holds out of it, in one synchronous step, as
   * `FileVersionStore` writes, so no other write of this service lands between the read and the
   * rename. The file's own index is read alone first: a file with none is left untouched.
   */
  private settle(file?: CollabFile): void {
    if (!file || !existsSync(file.path)) return
    const bytes = new Uint8Array(readFileSync(file.path))
    let index: Uint8Array | undefined
    try {
      index = unzipSync(bytes, { filter: (f) => f.name === BRANCHES_INDEX })[BRANCHES_INDEX]
    } catch {
      return
    }
    if (!index) return
    const inFile = JSON.parse(strFromU8(index)) as BranchRow[]
    const agents = inFile.filter(isAgentBranch)
    if (agents.length === 0) return
    const entries = unzipSync(bytes)
    const mine = this.rows(file)
    const states: Record<string, Uint8Array> = {}
    for (const row of agents) {
      const state = entries[`branches/${row.id}.yjs`]
      // A decided one is history already: its row goes with nothing kept.
      if (row.status === 'pending' && state && !mine.some((r) => r.id === row.id)) {
        mine.push(row)
        states[row.id] = state
      }
      delete entries[`branches/${row.id}.yjs`]
    }
    // Here first, then out of the file: a crash between the two leaves it in both, never in neither.
    if (Object.keys(states).length) this.save(file, mine, states)
    entries[BRANCHES_INDEX] = strToU8(JSON.stringify(inFile.filter((r) => !isAgentBranch(r))))
    land(file.path, zipSync(entries, { level: 6 }))
  }

  list(name: string, file?: CollabFile): Promise<VersionRow[]> {
    return this.inner.list(name, file)
  }
  content(name: string, id: string, file?: CollabFile): Promise<VersionContent> {
    return this.inner.content(name, id, file)
  }
  cut(name: string, version: NewVersion, file?: CollabFile): Promise<string> {
    return this.inner.cut(name, version, file)
  }
  keepBlocks(name: string, id: string, blocks: Parameters<VersionStore['keepBlocks']>[2], file?: CollabFile): Promise<void> {
    return this.inner.keepBlocks(name, id, blocks, file)
  }

  async branches(name: string, file?: CollabFile): Promise<BranchRow[]> {
    this.settle(file)
    const all = [...(await this.inner.branches(name, file)), ...this.rows(file)]
    return all.sort((a, b) => a.at - b.at)
  }

  async branchState(name: string, id: string, file?: CollabFile): Promise<Uint8Array> {
    this.settle(file)
    if (!this.rows(file).some((r) => r.id === id)) return this.inner.branchState(name, id, file)
    const path = join(this.dirOf(file), `${id}.yjs`)
    if (!existsSync(path)) throw new Error('not found')
    return new Uint8Array(readFileSync(path))
  }

  async createBranch(name: string, branch: NewBranch, file?: CollabFile): Promise<string> {
    if (!isAgentBranch(branch)) return this.inner.createBranch(name, branch, file)
    if (!(await this.inner.list(name, file)).some((r) => r.id === branch.baseVersionId)) throw new Error("that version is not this doc's")
    const { state, ...row } = branch
    const id = newId()
    const at = this.now()
    this.save(file, [...this.rows(file), { ...row, id, status: 'pending', at, editedAt: at }], { [id]: state })
    return id
  }

  async setBranch(name: string, id: string, change: { state?: Uint8Array; status?: BranchStatus }, file?: CollabFile): Promise<void> {
    this.settle(file)
    const rows = this.rows(file)
    const row = rows.find((r) => r.id === id)
    if (!row) return this.inner.setBranch(name, id, change, file)
    // Decided: accepted words are in the document now, rejected ones are gone; nothing of it stays.
    if (change.status && change.status !== 'pending') return this.save(file, rows.filter((r) => r.id !== id), { [id]: null })
    // Its revision, which a decision is bound to (history/serviceRoutes.ts): later than the last, two updates in one
    // millisecond included, so an Accept bound to what he read never takes words written in the same tick.
    row.editedAt = Math.max(this.now(), (row.editedAt ?? 0) + 1)
    this.save(file, rows, change.state ? { [id]: change.state } : {})
  }
}
