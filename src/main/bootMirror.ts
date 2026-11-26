import { DatabaseSync } from 'node:sqlite'
import type { LaunchMirrorSnapshot, MirrorEnvironment } from '@shared/launchMirror'
import { parseWorkSettings, WORK_SETTING_KEY } from '@shared/work/scope'
import { readMirrorHosts } from './server/launchMirror'
import { listEnvironments, type EnvironmentsStore } from './server/remote/environments'

/**
 * What the first window paints from before the server exists (docs/agents/launch-mirror.md "Before the server"):
 * the launch mirror's rows and the saved hosts, read once through a read-only connection of their own, and closed
 * again before the server opens the database. It also says whether Work is on for this host, so Work's code loads
 * at once only then (index.ts). A first launch, a file not there yet, or a read that fails answers null: the
 * window's read then waits for the server's own, as every read did before.
 */
export interface BootRead {
  snapshot: LaunchMirrorSnapshot | null
  workOn: boolean
}

export function readBootMirror(dbPath: string, open: (path: string) => DatabaseSync = openReadOnly): BootRead {
  let db: DatabaseSync | null = null
  try {
    db = open(dbPath)
    const settings = settingsOf(db)
    const environments: MirrorEnvironment[] = listEnvironments(settings).map((row) => ({
      id: row.id,
      name: row.name,
      routes: row.routes.map((r) => ({ url: r.url, kind: r.kind })),
      ...(row.keyId !== undefined ? { keyId: row.keyId } : {}),
      ...(row.platform ? { platform: row.platform } : {})
    }))
    const workOn = parseWorkSettings(settings.getSetting(WORK_SETTING_KEY)).enabled
    let snapshot: LaunchMirrorSnapshot | null = null
    try {
      snapshot = { environments, hosts: readMirrorHosts(db, ['local', ...environments.map((e) => e.id)]) }
    } catch {
      // no mirror tables yet: the server makes them, and its read answers
    }
    return { snapshot, workOn }
  } catch {
    return { snapshot: null, workOn: false }
  } finally {
    try {
      db?.close()
    } catch {
      // closed
    }
  }
}

const openReadOnly = (path: string): DatabaseSync => new DatabaseSync(path, { readOnly: true })

/** The settings table as the environments reader asks it; nothing is written through a read-only connection. */
function settingsOf(db: DatabaseSync): EnvironmentsStore {
  return {
    getSetting: (key) => (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null,
    settingsWithPrefix: (prefix) =>
      new Map(
        (db.prepare(`SELECT key, value FROM settings WHERE key = ? OR key LIKE ?`).all(prefix, `${prefix}%`) as unknown as { key: string; value: string }[]).map(
          (r) => [r.key, r.value]
        )
      ),
    setSetting: () => {
      throw new Error('the boot read writes nothing')
    }
  }
}
