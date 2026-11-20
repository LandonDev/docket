import type { ComputerSessionRow } from '@shared/contract-computer'

/**
 * Who has a computer's wheel, changed on the host in one call
 * (`computer.drive`, docs/agents/live-video.md "Take over"). A computer is
 * named `<kind>:<id>`: `browser:<pane>` is the box browser's page of a Work
 * pane, `vm:windows` the Windows VM. The wheel's store is not the core's, so
 * each kind's owner registers a hook (Work's browser pillar registers
 * `browser`, as it registers `configureOwnerDrives`). Take over hands him the
 * wheel first, waits for the change to land, and only then stops every
 * session that was driving it, on this host, the box's browser or a bridged
 * Mac: the other way round the page had no row between the two steps and its
 * picture went. A person's own window (`window:<thread>`) takes no input.
 */

export type ComputerDriver = 'owner' | 'agent'

export interface ComputerDriveHook<T = unknown> {
  /** Which threads' sessions drive this computer now. Read before the change: a session the change marks his is still stopped. */
  holds(id: string): (threadId: string) => boolean
  /** Changes the wheel; resolves once the change has landed (the picture's driver too). Throws a refusal in words a screen can show. */
  drive(id: string, driver: ComputerDriver): Promise<T>
}

/** What the host's computer methods give: every session row it lists, and Stop for each (computer/rpc.ts ComputerRpc). */
export interface DriveSessions {
  sessions(): { sessions: readonly ComputerSessionRow[] }
  stop(sessionId: string): Promise<{ stopped: boolean }>
}

export const NOT_DRIVABLE = 'refused: a window on his own computer takes no input from the picture'
export const unknownComputer = (computer: string): string => `refused: there is no computer ${computer} to drive here`

const hooks = new Map<string, ComputerDriveHook>()
let sessions: DriveSessions | null = null

/** A kind's owner registers its hook while it runs; a stop clears only its own hook, as configureOwnerDrives does. */
export function configureComputerDrive(kind: string, hook: ComputerDriveHook | null, unless?: ComputerDriveHook): void {
  if (hook) hooks.set(kind, hook)
  else if (!unless || hooks.get(kind) === unless) hooks.delete(kind)
}

/** Set once at boot (index.ts): the sessions a Take over stops. */
export function configureDriveSessions(s: DriveSessions | null): void {
  sessions = s
}

/** `<kind>:<id>` split at the first colon; null for a name with no kind. */
export function parseComputer(computer: string): { kind: string; id: string } | null {
  const at = computer.indexOf(':')
  return at > 0 && at < computer.length - 1 ? { kind: computer.slice(0, at), id: computer.slice(at + 1) } : null
}

/** Hands a computer's wheel to him or back: the hook's answer, after his Take over stopped what was driving it. */
export async function driveComputer<T = unknown>(computer: string, driver: ComputerDriver, log: (line: string) => void = console.log): Promise<T> {
  const named = parseComputer(computer)
  if (named?.kind === 'window') throw new Error(NOT_DRIVABLE)
  const hook = named ? hooks.get(named.kind) : undefined
  if (!named || !hook) throw new Error(unknownComputer(computer))
  const holds = hook.holds(named.id)
  const live = driver === 'owner' ? (sessions?.sessions().sessions ?? []).filter((r) => r.driver !== 'owner' && holds(r.threadId)) : []
  const answer = (await hook.drive(named.id, driver)) as T
  await Promise.all(
    live.map((r) =>
      sessions!.stop(r.threadId).catch((err) => {
        log(`[computer] Take over could not stop ${r.threadId}: ${String(err)}`)
      })
    )
  )
  return answer
}
