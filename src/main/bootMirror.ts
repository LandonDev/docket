import { closeSync, existsSync, openSync, readSync } from 'node:fs'
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
  // A read-only connection to a WAL file whose -wal or -shm is gone makes them, and they stay if the boot stops
  // before the server's writer opens: the window waits for the server's own read instead. Never opened immutable,
  // which could skip frames a crash left in the WAL.
  if (walSidecarsMissing(dbPath)) return { snapshot: null, workOn: false }
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

/** The server's mirror forgets the hosts no longer saved, once it is up (index.ts): best effort, so a failed delete
 *  never stops the rest of the boot. False when it failed. */
export function forgetUnsavedHosts(mirror: { forgetExcept(keep: Iterable<string>): void }, keep: () => string[]): boolean {
  try {
    mirror.forgetExcept(keep())
    return true
  } catch (err) {
    console.error('[launch-mirror] could not forget the hosts no longer saved; the boot goes on:', err)
    return false
  }
}

/** The file is in WAL mode (its header's read and write versions are 2) and its -wal or -shm is not there. */
export function walSidecarsMissing(dbPath: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(dbPath, 'r')
    const header = Buffer.alloc(20)
    if (readSync(fd, header, 0, 20, 0) < 20) return false
    const wal = header[18] === 2 && header[19] === 2
    return wal && (!existsSync(`${dbPath}-wal`) || !existsSync(`${dbPath}-shm`))
  } catch {
    // no file: the read-only open fails on its own and makes nothing
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
