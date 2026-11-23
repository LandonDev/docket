import type { LifeosClient } from '../lifeos/ctx'
import type { LifeEvent } from './gather'

/**
 * LifeOS in memory, as the prep pillar reads it as the owner: the public
 * functions with the fences they have (`people:page` and `tasks:search` by
 * sector; `events:get`, `people:find` and `tasks:get` across every sector,
 * since the owner's session holds them all). For tests only.
 */
export interface FakePerson {
  _id: string
  name: string
  sectors: string[]
  emails: string[]
  mail?: { _id: string; sector: string; subject: string; lastMessageAt: number; unread?: boolean }[]
}
export interface FakeTask {
  _id: string
  sector: string
  title: string
  status: string
  dueAt?: number
  askerId?: string
  waitingOnPersonId?: string
  description?: string
  key?: string
}

export class FakeLifeos implements LifeosClient {
  events = new Map<string, LifeEvent>()
  people = new Map<string, FakePerson>()
  tasks = new Map<string, FakeTask>()
  /** `outbox` rows by the thread that made them (`compose:byOrigin`) */
  outbox: { _id: string; status: string; origin: { threadId: string }; message: { subject: string; to: { address: string; name?: string }[] } }[] = []
  calls: { fn: string; args: Record<string, unknown> }[] = []
  /** fail every call of this function with this message */
  failing = new Map<string, string>()
  connected = true
  private n = 0

  event(e: Partial<LifeEvent> & { _id: string }): LifeEvent {
    const row: LifeEvent = { sector: 'purdue', title: 'Staff sync', startsAt: Date.parse('2026-11-23T14:00:00-05:00'), endsAt: Date.parse('2026-11-23T14:45:00-05:00'), allDay: false, ...e }
    this.events.set(row._id, row)
    return row
  }
  person(p: FakePerson): FakePerson {
    this.people.set(p._id, p)
    return p
  }
  task(t: Partial<FakeTask> & { _id: string; title: string }): FakeTask {
    const row: FakeTask = { sector: 'purdue', status: 'todo', ...t }
    this.tasks.set(row._id, row)
    return row
  }
  called(fn: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args)
  }

  private async run<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ fn, args })
    if (!this.connected) throw new Error('LifeOS is unreachable')
    const fail = this.failing.get(fn)
    if (fail) throw new Error(fail)
    switch (fn) {
      case 'events:get': {
        const event = this.events.get(String(args.id))
        if (!event) throw new Error('not found')
        return event as T
      }
      case 'events:range': {
        const { from, to, sector } = args as { from: number; to: number; sector?: string }
        return [...this.events.values()].filter((e) => e.startsAt >= from && e.startsAt < to && (!sector || e.sector === sector)).sort((a, b) => a.startsAt - b.startsAt) as T
      }
      case 'people:find': {
        const email = String(args.email ?? '').toLowerCase()
        return ([...this.people.values()].find((p) => p.emails.includes(email)) ?? null) as T
      }
      case 'people:page': {
        const person = this.people.get(String(args.id))
        const sector = String(args.sector)
        if (!person?.sectors.includes(sector)) return null as T
        const tasks = [...this.tasks.values()]
          .filter((t) => t.sector === sector && ['todo', 'doing', 'waiting'].includes(t.status) && (t.askerId === person._id || t.waitingOnPersonId === person._id))
          .map((t) => ({ _id: t._id, title: t.title, status: t.status, ...(t.dueAt !== undefined ? { dueAt: t.dueAt } : {}), relation: t.askerId === person._id ? 'asked' : 'waiting' }))
        const mail = (person.mail ?? [])
          .filter((m) => m.sector === sector)
          .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
          .map((m) => ({ _id: m._id, subject: m.subject, snippet: '', lastMessageAt: m.lastMessageAt, unread: m.unread ?? false }))
        return { person: { _id: person._id, name: person.name, notes: '', sectors: person.sectors, emails: person.emails, phones: [] }, mail, coming: [], recent: [], tasks, shared: [] } as T
      }
      case 'tasks:search': {
        const words = String(args.text).toLowerCase().split(/\s+/).filter(Boolean)
        return [...this.tasks.values()].filter((t) => (!args.sector || t.sector === args.sector) && words.some((w) => t.title.toLowerCase().includes(w))).slice(0, 20) as T
      }
      case 'tasks:get': {
        const task = this.tasks.get(String(args.id))
        if (!task) throw new Error('not found')
        return { task, rawMessage: null, mailThreadId: null, project: null, merged: [] } as T
      }
      case 'tasks:create': {
        const key = typeof args.key === 'string' ? args.key : undefined
        const same = key ? [...this.tasks.values()].find((t) => t.key === key) : undefined
        if (same) return same._id as T
        const id = `task_${++this.n}`
        this.tasks.set(id, { _id: id, sector: String(args.sector), title: String(args.title), status: 'todo', ...(typeof args.description === 'string' ? { description: args.description } : {}), ...(typeof args.dueAt === 'number' ? { dueAt: args.dueAt } : {}), ...(key ? { key } : {}) })
        return id as T
      }
      case 'compose:byOrigin':
        return this.outbox.filter((r) => r.origin.threadId === args.threadId) as T
    }
    throw new Error(`no function ${fn}`)
  }
  query = <T>(fn: string, args?: Record<string, unknown>): Promise<T> => this.run<T>(fn, args)
  mutation = <T>(fn: string, args?: Record<string, unknown>): Promise<T> => this.run<T>(fn, args)
  action = <T>(fn: string, args?: Record<string, unknown>): Promise<T> => this.run<T>(fn, args)
}
