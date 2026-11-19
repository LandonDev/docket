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
export type WorkSettingsStoreDeps = Pick<Store, 'getSetting' | 'setSetting' | 'getWorkspaceWorkSettings' | 'setWorkspaceWorkSettings'>

export class WorkSettingsStore {
  private readonly listeners = new Set<(settings: WorkSettings) => void>()

  constructor(private readonly store: WorkSettingsStoreDeps) {}

  get(): WorkSettings {
    return parseWorkSettings(this.store.getSetting(WORK_SETTING_KEY))
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
    return parseWorkspaceWorkSettings(this.store.getWorkspaceWorkSettings(id))
  }

  /** Merges a patch into a workspace's Work settings. Throws for a workspace this host does not have. */
  setWorkspace(id: string, patch: Partial<WorkspaceWorkSettings>): void {
    const next = WorkspaceWorkSettingsSchema.parse({ ...this.workspace(id), ...patch })
    if (!this.store.setWorkspaceWorkSettings(id, JSON.stringify(next))) throw new Error(`no such workspace: ${id}`)
  }
}
