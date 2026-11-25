import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { draftKeyOf, draftOf, type Draft, type DraftKey } from '@shared/work/drafts'

/**
 * The draft store (docs/agents/work-files.md "Drafts survive a crash", src/shared/work/drafts.ts): each edit a window
 * made that its file's host has not acknowledged, one JSON file a draft under `<userData>/drafts`, written by this
 * process as he edits. A file's folder is named for its workspace, holder and file; the draft in it for its base.
 * Only an app window reaches it, over IPC (`registerDrafts`): no wire method, so no thread, guest page or remote key
 * can read it, and nothing of it sits in a folder OneDrive or Teams syncs.
 *
 * A draft a live window is still editing is claimed by that window and is not offered to another: it is let go when
 * its editor goes without sending it, or the window reloads, crashes or closes. A fresh start claims nothing.
 */

const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32)
let writes = 0
const fileDir = (k: Omit<DraftKey, 'base'>): string => hash(`${k.workspaceId}\0${k.holder}\0${k.file}`)

export class DraftStore {
  /** writes not yet on disk, by path: a draft, or null for its removal */
  private want = new Map<string, Draft | null>()
  private running = new Map<string, Promise<void>>()
  /** path → the window that is editing it */
  private claims = new Map<string, number>()

  constructor(readonly dir: string) {}

  private pathOf(k: DraftKey): string {
    return join(this.dir, fileDir(k), `${hash(k.base)}.json`)
  }

  /** The newest edit of a draft, kept: written at once, or after the write under way, coalesced. */
  put(d: Draft, owner?: number): void {
    const path = this.pathOf(d)
    if (owner !== undefined) this.claims.set(path, owner)
    this.want.set(path, d)
    void this.settle(path)
  }

  /** The host acknowledged it, or he chose to let it go. */
  drop(k: DraftKey): void {
    const path = this.pathOf(k)
    this.claims.delete(path)
    this.want.set(path, null)
    void this.settle(path)
  }

  /** Its editor went without sending it: it is offered on the next open. */
  release(k: DraftKey): void {
    this.claims.delete(this.pathOf(k))
  }

  /** A window reloaded, crashed or closed: every draft it was editing is offered on the next open. */
  releaseOwner(owner: number): void {
    for (const [path, by] of this.claims) if (by === owner) this.claims.delete(path)
  }

  /** The drafts of one file no live window is editing, newest first. */
  async list(k: Omit<DraftKey, 'base'>): Promise<Draft[]> {
    const dir = join(this.dir, fileDir(k))
    const names = await readdir(dir).catch(() => [] as string[])
    const paths = new Set([...names.filter((n) => n.endsWith('.json')).map((n) => join(dir, n)), ...[...this.want.keys()].filter((p) => dirname(p) === dir)])
    const out: Draft[] = []
    for (const path of paths) {
      if (this.claims.has(path)) continue
      const d = this.want.has(path) ? this.want.get(path)! : await readFile(path, 'utf8').then((s) => draftOf(JSON.parse(s)), () => null)
      // A folder shared by two files whose names hash alike holds only its own file's drafts.
      if (d && d.workspaceId === k.workspaceId && d.holder === k.holder && d.file === k.file) out.push(d)
    }
    return out.sort((a, b) => b.at - a.at)
  }

  /** Every write asked so far is on disk. */
  async settled(): Promise<void> {
    while (this.running.size) await Promise.all(this.running.values())
  }

  private settle(path: string): Promise<void> {
    const under = this.running.get(path)
    if (under) return under
    const run = (async () => {
      while (this.want.has(path)) {
        const d = this.want.get(path)!
        try {
          if (d === null) {
            await rm(path, { force: true })
            // The file's folder goes with its last draft, while no other draft of it is being written.
            const busy = [...this.running.keys(), ...this.want.keys()].some((p) => p !== path && dirname(p) === dirname(path))
            if (!busy) await rmdir(dirname(path)).catch(() => undefined)
          } else {
            const tmp = `${path}.${process.pid}.${++writes}.tmp`
            await mkdir(dirname(path), { recursive: true, mode: 0o700 })
            await writeFile(tmp, JSON.stringify(d), { mode: 0o600 })
            await rename(tmp, path)
          }
        } catch (err) {
          console.error('[drafts] a draft was not written', err)
        }
        // A newer ask while this one wrote goes next; this one is done.
        if (this.want.get(path) === d) this.want.delete(path)
      }
    })().finally(() => this.running.delete(path))
    this.running.set(path, run)
    return run
  }
}

/**
 * The store's IPC, for app windows alone (`isAppWindow`: a window main made for the app, never a guest page or a
 * webview inside one). Writes are fire-and-forget so typing never waits on the disk; a list is asked and answered.
 */
export async function registerDrafts(userData: string, isAppWindow: (id: number) => boolean): Promise<DraftStore> {
  const { ipcMain } = await import('electron')
  const store = new DraftStore(join(userData, 'drafts'))
  const watched = new Set<number>()
  const watch = (sender: Electron.WebContents): void => {
    if (watched.has(sender.id)) return
    watched.add(sender.id)
    const id = sender.id
    const off = (): void => store.releaseOwner(id)
    sender.on('did-navigate', off)
    sender.on('render-process-gone', off)
    sender.once('destroyed', () => {
      off()
      watched.delete(id)
    })
  }
  ipcMain.on('drafts:put', (e, raw: unknown) => {
    const d = isAppWindow(e.sender.id) ? draftOf(raw) : null
    if (!d) return
    watch(e.sender)
    store.put(d, e.sender.id)
  })
  ipcMain.on('drafts:drop', (e, raw: unknown) => {
    const k = isAppWindow(e.sender.id) ? draftKeyOf(raw) : null
    if (k) store.drop(k)
  })
  ipcMain.on('drafts:release', (e, raw: unknown) => {
    const k = isAppWindow(e.sender.id) ? draftKeyOf(raw) : null
    if (k) store.release(k)
  })
  ipcMain.handle('drafts:list', (e, raw: unknown) => {
    const k = isAppWindow(e.sender.id) ? draftKeyOf({ ...(raw as object), base: '-' }) : null
    return k ? store.list(k) : []
  })
  return store
}
