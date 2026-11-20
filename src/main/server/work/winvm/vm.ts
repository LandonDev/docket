import { join } from 'node:path'
import type { ComputerSessionRow } from '@shared/contract-computer'
import type { SessionMeta, SessionStatus } from '@shared/events'
import type { ComputerRegistry } from '../../computer/run'
import { ComputerService } from '../../computer/service'
import { ComputerSessions } from '../../computer/sessions'
import type { SettingsStore } from '../../computer/verdicts'
import { doorSpawn, type DoorSpawn } from './door'
import { VM_TIER_GATE } from './gate'
import type { Keeper } from './keeper'
import { VmLease, type LeaseClock } from './lease'
import { VmClipboard } from './clipboard'

/**
 * The Windows VM's service on the box (docs/agents/work-winvm.md "The service
 * on the box", docs/computer-protocol.md §28.7): a third `ComputerService`,
 * beside this host's own and the box browser's, whose spawn is the guest's
 * door through the keeper's forward (door.ts), with `ComputerSessions` of its
 * own. Those sessions run with `vm: true` (the VM's launch list, its rule on
 * what may be opened, the Windows key refused, Windows' words) and with a
 * session tier of their own (`VM_TIER_GATE`): the guest has no person at it
 * but him. Every act a Work thread makes there goes through run.ts as on any
 * computer, the hold included. The service stops with the machine.
 */

/** The VM's computer, as the rows and `computer.drive` name it. */
export const VM_COMPUTER = 'vm:windows'

export interface VmRegistry extends ComputerRegistry {
  rootSessionOf(id: string): string
  onMeta(fn: (m: SessionMeta) => void): unknown
  onRemoved(fn: (ids: string[]) => void): unknown
}

export interface VmWiring {
  registry: VmRegistry
  store: SettingsStore
  /** <userData>: the service's pictures land in `winvm/computer` */
  dataDir: string
  log?: (line: string) => void
  /** test seams: the spawn, where a thread's pictures land (attachmentDir(thread)/computer on a host) */
  spawn?: DoorSpawn['spawn']
  landing?: (threadId: string) => string
  leaseClock?: LeaseClock
}

export interface VmHost {
  service: ComputerService
  sessions: ComputerSessions
  lease: VmLease
  /** the sessions' rows, named as the VM's computer */
  rows: Pick<ComputerSessions, 'rows' | 'onRows' | 'stop'>
  /** ends the door's connections: the machine sleeps */
  closeDoor(): void
  /** his paste in, his copy out, and the clipboard kept across his Take over (clipboard.ts) */
  clipboard: VmClipboard
}

let host: VmHost | null = null
/** the keeper and the wake of a waiting thread, both Work's: set while Work is on (startVm) */
let keeperOf: () => Keeper | null = () => null
let wakeThread: (threadId: string, notice: string) => void = () => {}

export const NO_KEEPER = 'refused: the Windows VM is not on this host while Work is off'
const SETTLED: readonly SessionStatus[] = ['idle', 'done', 'error', 'stopped', 'watching']

/** Made once at boot by index.ts on the box. */
export function wireVm(o: VmWiring): VmHost {
  const dataDir = join(o.dataDir, 'winvm', 'computer')
  const log = o.log ?? ((line: string) => console.log(`[winvm] ${line}`))
  const keeper = (): Keeper => {
    const k = keeperOf()
    if (!k) throw new Error(NO_KEEPER)
    return k
  }
  const door = doorSpawn({ door: () => keeper().door(), fetch: (rel, local) => keeper().fetch(rel, local), hostDataDir: dataDir, log })
  const service = new ComputerService({
    dataDir,
    bin: () => 'tc-computer.exe (the Windows VM)',
    spawn: o.spawn ?? door.spawn,
    unavailable: () => (keeperOf() ? null : NO_KEEPER)
  })
  const sessions = new ComputerSessions({
    service,
    registry: o.registry,
    store: o.store,
    dataDir,
    rootOf: (id) => o.registry.rootSessionOf(id),
    gate: () => VM_TIER_GATE,
    vm: true,
    log,
    ...(o.landing ? { landing: o.landing } : {})
  })
  const pane = (id: string): string => {
    try {
      return o.registry.rootSessionOf(id) || id
    } catch {
      return id
    }
  }
  const lease = new VmLease({
    pane,
    title: (id) => o.registry.get(id)?.title || 'another thread',
    wake: (id, notice) => wakeThread(id, notice),
    ...(o.leaseClock ? { clock: o.leaseClock } : {})
  })
  o.registry.onMeta((m) => {
    sessions.onMeta(m)
    lease.turn(m.id, SETTLED.includes(m.status))
  })
  o.registry.onRemoved((ids) => {
    void sessions.end(ids)
    lease.ended(ids)
  })
  const named = (rows: ComputerSessionRow[]): ComputerSessionRow[] => rows.map((r) => ({ ...r, computer: VM_COMPUTER }))
  host = {
    service,
    sessions,
    lease,
    rows: {
      rows: () => named(sessions.rows()),
      onRows: (fn) => sessions.onRows((rows) => fn(named(rows))),
      stop: (threadId) => sessions.stop(threadId)
    },
    closeDoor: () => door.closeAll(),
    clipboard: new VmClipboard({ service: () => service, wake: () => keeper().wake() })
  }
  return host
}

/** The VM's service of this host, once wired; null elsewhere. A test sets its own. */
export const vmHost = (): VmHost | null => host
export const setVmHost = (h: VmHost | null): void => {
  host = h
}

/**
 * Work started: the keeper is there to wake the machine, a waiting thread can be woken, and the service stops
 * whenever the machine goes to sleep. Returns the stop for Work turning off.
 */
export function startVm(keeper: () => Keeper | null, wake: (threadId: string, notice: string) => void): () => void {
  keeperOf = keeper
  wakeThread = wake
  const k = keeper()
  const off = k?.onState((s) => {
    if (s.state === 'going-to-sleep' || s.state === 'asleep' || s.state === 'none') host?.closeDoor()
  })
  return () => {
    off?.()
    host?.closeDoor()
    keeperOf = () => null
    wakeThread = () => {}
  }
}

const wired = (): VmHost => {
  if (!host) throw new Error('the Windows VM is not on this host')
  return host
}

/** His paste into the VM from the picture (B7's VideoSource for `vm:windows`): his text on the guest's clipboard, then Ctrl+V. */
export const vmPaste = (text: string): Promise<void> => wired().clipboard.paste(text)
/** His copy in the VM, for the viewer to hand to his own clipboard: the guest's text, cut at 1 MB. */
export const vmCopied = (): ReturnType<VmClipboard['copied']> => wired().clipboard.copied()
/** At his Take over (B8): the guest's clipboard kept as it is. */
export const saveClipboard = (): Promise<void> => wired().clipboard.save()
/** At his Hand back (B8): the guest's clipboard put back as it was at Take over, so nothing he copied is left for an agent. */
export const restoreClipboard = (): Promise<void> => wired().clipboard.restore()
