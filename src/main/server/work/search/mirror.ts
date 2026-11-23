import type { WorkCtx } from '../modules'
import type { Event, Person, Task } from './sources/lifeos'
import { eventsWindow } from './sources/window'

/**
 * Answers at once (docs/agents/work-search.md "The mirror"): LifeOS's
 * people, open tasks and the events of the search's window, kept in this
 * host's memory by live subscriptions while Work is on, so a search for a
 * person, an open task or an event needs no round trip. Started from the
 * module's `start` (never while Work is off) and stopped with it. What it
 * holds is dropped the moment LifeOS is no longer connected: a list that
 * may be stale is never searched, and the sources fall back to asking
 * LifeOS.
 */

const DAY = 86_400_000

export interface Mirror {
  /** Each list, or null while it has not arrived or LifeOS is not connected. */
  people(): Person[] | null
  tasks(): Task[] | null
  events(): Event[] | null
  /** Rows held now, for the figures. */
  size(): { people: number; tasks: number; events: number }
  stop(): void
}

export function makeMirror(ctx: Pick<WorkCtx, 'lifeos' | 'log'>, o: { now?: () => number; every?: (run: () => void, ms: number) => () => void } = {}): Mirror {
  const now = o.now ?? (() => Date.now())
  const every =
    o.every ??
    ((run, ms) => {
      const timer = setInterval(run, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    })
  let people: Person[] | null = null
  let tasks: Task[] | null = null
  let events: Event[] | null = null
  // LifeOS gone: what is held may be stale by the time it is back, so it goes now; the live queries fill it again.
  const live = (): boolean => {
    let up = false
    try {
      up = ctx.lifeos.connected()
    } catch {
      up = false
    }
    if (!up) people = tasks = events = null
    return up
  }
  const offPeople = ctx.lifeos.subscribe<Person[]>('people:list', { images: false }, (rows) => void (people = rows ?? null))
  const offTasks = ctx.lifeos.subscribe<Task[]>('tasks:list', {}, (rows) => void (tasks = rows ?? null))
  // The window moves with the day: asked again each day, the old query let go.
  let offEvents: () => void = () => {}
  const watchEvents = (): void => {
    offEvents()
    offEvents = ctx.lifeos.subscribe<Event[]>('events:range', eventsWindow(now()), (rows) => void (events = rows ?? null))
  }
  watchEvents()
  const offDaily = every(watchEvents, DAY)
  return {
    people: () => (live() ? people : null),
    tasks: () => (live() ? tasks : null),
    events: () => (live() ? events : null),
    size: () => ({ people: people?.length ?? 0, tasks: tasks?.length ?? 0, events: events?.length ?? 0 }),
    stop() {
      offPeople()
      offTasks()
      offEvents()
      offDaily()
      people = tasks = events = null
    }
  }
}

let current: Mirror | null = null

/** The mirror while Work is on; null before it starts and after it stops. */
export const mirror = (): Mirror | null => current
/** A test's own mirror; null puts back none. */
export const setMirror = (next: Mirror | null): void => void (current = next)

/** The module's `start`: the mirror lives while Work is on. */
export function startMirror(ctx: WorkCtx): () => void {
  const mine = makeMirror(ctx)
  current = mine
  return () => {
    mine.stop()
    if (current === mine) current = null
  }
}
