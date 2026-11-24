import { stat } from 'node:fs/promises'

/**
 * Whether a drive a folder he added lies on is there now. A mapped network drive whose share is gone (the VPN
 * down) can hold a file call for half a minute, and every sync call on it holds the whole host. So a folder on
 * such a drive is asked about only here, with a deadline, and the libraries' sync code reads the answer kept:
 * a drive not known to be there is not touched, and its place shows as not reachable.
 */

/** How long one look at a drive may take before it counts as not there. */
export const DRIVE_PROBE_MS = 1_500
/** How long a drive's answer stands before the next places call asks again. */
export const DRIVE_FRESH_MS = 30_000

/** The drive or share a path lies on, when it is one that may hang: a letter that is not the system's, or a `\\server\share`. Null: a path of this disk. */
export function driveOf(path: string, systemDrive = process.env.SystemDrive ?? 'C:'): string | null {
  const share = /^[\\/]{2}(?![?.][\\/])([^\\/]+)[\\/]+([^\\/]+)/.exec(path)
  if (share) return `\\\\${share[1]}\\${share[2]}`.toLowerCase()
  const letter = /^([a-zA-Z]:)(?:[\\/]|$)/.exec(path)?.[1]?.toUpperCase()
  return letter && letter !== systemDrive.toUpperCase() ? letter : null
}

const seen = new Map<string, { up: boolean; at: number }>()
/** A look under way, until the drive answers: one past its deadline is still running in the thread pool, and no second one starts beside it. */
const looking = new Map<string, Promise<boolean>>()
let look = (root: string): Promise<unknown> => stat(root)
/** A test stands in for the look at a drive (a `stat` that hangs, or fails). */
export const setDriveLook = (fn?: (root: string) => Promise<unknown>): void => void ((look = fn ?? ((root) => stat(root))), seen.clear(), looking.clear())

/** Whether the drive a path lies on answered its last look: true for a path of this disk; false while it is not known to be there. */
export function driveUp(path: string, now = Date.now()): boolean {
  const drive = driveOf(path)
  if (!drive) return true
  const was = seen.get(drive)
  if (!was || now - was.at > DRIVE_FRESH_MS) void probeDrive(path)
  return was?.up ?? false
}

/** Looks at the drive a path lies on, waiting at most `ms`; answers whether it is there. A drive that answers late is kept as there. */
export function probeDrive(path: string, ms = DRIVE_PROBE_MS): Promise<boolean> {
  const drive = driveOf(path)
  if (!drive) return Promise.resolve(true)
  let going = looking.get(drive)
  if (!going) {
    going = look(/^[a-zA-Z]:$/.test(drive) ? `${drive}\\` : drive).then(
      () => true,
      () => false
    )
    looking.set(drive, going)
    void going.then((up) => {
      looking.delete(drive)
      seen.set(drive, { up, at: Date.now() })
    })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)))
  return Promise.race([going, late]).then((up) => {
    clearTimeout(timer)
    if (up !== null) return up
    seen.set(drive, { up: false, at: Date.now() })
    return false
  })
}

/** Looks at every drive these folders lie on at once, within one deadline; answers whether any drive's answer changed. */
export async function probeDrives(folders: readonly string[], ms = DRIVE_PROBE_MS): Promise<boolean> {
  const drives = new Map<string, string>()
  for (const f of folders) {
    const d = driveOf(f)
    if (d && !drives.has(d)) drives.set(d, f)
  }
  const before = [...drives.keys()].map((d) => seen.get(d)?.up)
  await Promise.all([...drives.values()].map((f) => probeDrive(f, ms)))
  return [...drives.keys()].some((d, i) => seen.get(d)?.up !== before[i])
}
