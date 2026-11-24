import {
  parseWorkSettings,
  parseWorkspaceWorkSettings,
  WORK_SETTING_KEY,
  WorkspaceWorkSettingsSchema,
  type WorkSettings,
  type WorkspaceWorkSettings
} from '@shared/work'
import type { Store } from '../db'

/**
 * The Work switch and a workspace's own Work settings (docs/agents/work.md).
 *
 * The switch is one setting per host (`settings.work`, `{ enabled }`), off
 * by default. No sync engine carries it: a client that turns it on writes
 * `work.set` to every host it is linked to. Code branches on a row
 * (`kind === 'work'`, `scope === 'work'`), never on the switch; the switch
 * only decides whether Work things can be made, shown and started.
 */
export type WorkSettingsStoreDeps = Pick<Store, 'getSetting' | 'setSetting' | 'getWorkspaceWorkSettings' | 'setWorkspaceWorkSettings'> & Partial<Pick<Store, 'listWorkspaces' | 'onSettingSet'>>

export class WorkSettingsStore {
  private readonly listeners = new Set<(settings: WorkSettings) => void>()

  /**
   * `hostLive` (devices/binding.ts `mayRoute`): a given computer whose binding
   * is no longer live is dropped from every workspace's `mayUseDesktop` as it
   * is read, so no route reaches a removed computer.
   */
  constructor(
    private readonly store: WorkSettingsStoreDeps,
    private readonly hostLive: (envId: string) => boolean = () => true
  ) {
    // The switch is read on every Work request. It is kept in memory only where the store says when anyone writes
    // it (`onSettingSet`), so turning Work off is seen by the very next call; a store that cannot say is read each time.
    this.store.onSettingSet?.(WORK_SETTING_KEY, () => (this.kept = null))
  }
  private kept: WorkSettings | null = null

  get(): WorkSettings {
    if (this.kept) return this.kept
    const read = parseWorkSettings(this.store.getSetting(WORK_SETTING_KEY))
    if (this.store.onSettingSet) this.kept = Object.freeze(read)
    return read
  }

  enabled(): boolean {
    return this.get().enabled
  }

  /** Sets the switch; listeners hear it only when it changed. */
  set(next: WorkSettings): WorkSettings {
    const before = this.get()
    this.store.setSetting(WORK_SETTING_KEY, JSON.stringify({ enabled: next.enabled }))
    if (before.enabled !== next.enabled) for (const fn of [...this.listeners]) fn({ enabled: next.enabled })
    return { enabled: next.enabled }
  }

  onChange(fn: (settings: WorkSettings) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** A workspace's Work settings; the defaults for one that stored none. */
  workspace(id: string): WorkspaceWorkSettings {
    const settings = parseWorkspaceWorkSettings(this.store.getWorkspaceWorkSettings(id))
    return settings.mayUseDesktop.every(this.hostLive) ? settings : { ...settings, mayUseDesktop: settings.mayUseDesktop.filter(this.hostLive) }
  }

  /**
   * A removed computer leaves every workspace's `mayUseDesktop` for good, not only as it is read: the
   * same install set up again under its env id gets the reach its new link names and nothing older.
   */
  dropHost(envId: string): number {
    let dropped = 0
    for (const w of this.store.listWorkspaces?.() ?? []) {
      const stored = parseWorkspaceWorkSettings(this.store.getWorkspaceWorkSettings(w.id))
      if (!stored.mayUseDesktop.includes(envId)) continue
      this.store.setWorkspaceWorkSettings(w.id, JSON.stringify({ ...stored, mayUseDesktop: stored.mayUseDesktop.filter((e) => e !== envId) }))
      dropped++
    }
    return dropped
  }

  /** Merges a patch into a workspace's Work settings. Throws for a workspace this host does not have. */
  setWorkspace(id: string, patch: Partial<WorkspaceWorkSettings>): void {
    const next = WorkspaceWorkSettingsSchema.parse({ ...this.workspace(id), ...patch })
    if (!this.store.setWorkspaceWorkSettings(id, JSON.stringify(next))) throw new Error(`no such workspace: ${id}`)
  }
}
