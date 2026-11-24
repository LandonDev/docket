import type { DigestDay, DigestList } from '@shared/contract-work-digest'
import { errorText } from '@shared/work/ids'
import type { NoticeWork, TellRow } from '@shared/work/tell'
import type { Notifier } from '../../remote/notifier'
import type { Deliverer } from './ctx'
import type { LedgerRow } from './store'
import { digestWords, jobFromSector, nowWords } from './words'

/**
 * A tell or a day's digest, handed to the notifier (docs/agents/work-digest.md).
 *
 * An interrupt goes to the phone as one banner for everything that cannot
 * wait: every interrupt of a host shares one collapse id (the hub's own
 * rule for a notice with no thread, and this host's own APNs sender's), so
 * while more than one is open the body names them all and a banner that
 * replaced another still says everything. A tell that opens a held item a
 * thread made goes through `Notifier.held`, on that thread, as it always
 * did: the phone app of today opens the Outbox item from it.
 *
 * The digest is sent by one host (`sendsDigest`). Before it sends, it asks
 * each linked host what it holds for the day and adds what answers within
 * five seconds, a thing two hosts tell under one key counted once.
 */

export const PEER_WAIT_MS = 5_000
/** Every interrupt of a host replaces the last on the phone. */
export const NOW_KEY = 'now'

export interface DeliverDeps {
  /** null until the host has built it, late in boot */
  notifier(): Pick<Notifier, 'work' | 'held'> | null
  sendsDigest(): boolean
  /** each linked host's rows, asked on its own with the limit; one that does not answer in time adds nothing */
  peers(day: string): Promise<TellRow[]>[]
  log(line: string): void
}

const jobOf = (row: Pick<TellRow, 'sector'>): string | null => jobFromSector(row.sector)
/** The same on every host that tells the same thing: the row's key, its id when it has none. */
const nameOf = (row: Pick<TellRow, 'id' | 'key'>): string => row.key ?? row.id

/** What a linked host holds for the day: its rows that waited, in that day's digest or not stamped yet (its own look may come seconds after ours). */
export const ofDay = (list: Pick<DigestList, 'rows'>, day: string): TellRow[] => list.rows.filter((r) => r.toldAt == null && (r.day === day || r.day === null))

/** One list from several hosts, a key two of them hold counted once (a row with no key is its own). */
export function mergeByKey(lists: readonly (readonly TellRow[])[]): TellRow[] {
  const seen = new Set<string>()
  const out: TellRow[] = []
  for (const rows of lists) {
    for (const row of rows) {
      const name = row.key ? `k:${row.key}` : `i:${row.host}:${row.id}`
      if (seen.has(name)) continue
      seen.add(name)
      out.push(row)
    }
  }
  return out
}

/** A held item a thread made: its interrupt goes out on that thread (`Notifier.held`), not as a notice of Work's. */
const onItsThread = (row: Pick<TellRow, 'open'>): boolean => !!row.open && 'held' in row.open && !!row.open.thread

const within = <T>(wait: Promise<T>, ms: number, otherwise: T): Promise<T> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(otherwise), ms)
    timer.unref?.()
    wait.then(
      (value) => (clearTimeout(timer), resolve(value)),
      () => (clearTimeout(timer), resolve(otherwise))
    )
  })

export function makeDeliverer(deps: DeliverDeps): Deliverer & { digestSent(day: DigestDay, rows: LedgerRow[]): Promise<boolean> } {
  /** False: no notifier yet, so the day is offered again later (ctx.ts `offerOwed`). */
  const digestSent = async (day: DigestDay, rows: LedgerRow[]): Promise<boolean> => {
    if (!deps.sendsDigest()) return true
    if (!deps.notifier()) return false
    const far = await Promise.all(deps.peers(day.day).map((ask) => within(ask, PEER_WAIT_MS, [] as TellRow[])))
    const all = mergeByKey([rows, ...far])
    const notifier = deps.notifier()
    if (!notifier) return false
    if (all.length === 0) return true
    const key = `digest:${day.day}`
    notifier.work({ ...digestWords(all.length, all, jobOf), urgent: false, work: { key, digest: day.day } })
    return true
  }
  return {
    now(row, open) {
      const notifier = deps.notifier()
      if (!notifier) return false
      if (onItsThread(row) && row.open && 'held' in row.open) {
        notifier.held(row.open.thread!, row.title, row.open.held)
        return true
      }
      // One a thread's own notice carried has its own banner there: this one names only the rest.
      // The one that could not wait is named first: where the line runs out of room, it is the older ones that are counted.
      const here = [row, ...open.filter((r) => r.id !== row.id && !onItsThread(r))]
      const work: NoticeWork = { key: NOW_KEY, tell: nameOf(row), ...(row.by != null ? { by: row.by } : {}), ...(here.length === 1 && row.open ? { open: row.open } : {}) }
      notifier.work({ ...nowWords(here, jobOf), urgent: true, work })
      return true
    },
    gone() {
      // A banner on a phone cannot be taken back; the next interrupt's body names only what is still open.
    },
    digest(day, rows) {
      return digestSent(day, rows).catch((err: unknown) => (deps.log(`digest: the day's notice was not sent: ${errorText(err)}`), true))
    },
    digestSent
  }
}
