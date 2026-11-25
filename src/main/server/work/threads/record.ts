import type { OutboxItem, OutboxRequest, WorkResult } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import { errorText, needsHim, WORK_HOME, type CanvasSource } from '@shared/work'
import {
  doneWords,
  failedWords,
  heldWords,
  isMadeKind,
  madeWords,
  workingWords,
  type RecordMade,
  type RecordOpen,
  type RecordWait,
  type RecordWork,
  type ThreadOutcome,
  type ThreadRecord
} from '@shared/work/threadRecord'
import type { WorkPartDeps } from '../ctx'
import type { WorkCtx } from '../modules'
import { outboxHostOf } from '../outbox/ctx'
import { resultsOf } from '../outbox/results'

/**
 * What a Work thread left him (docs/agents/work.md "What a thread left him"): one pure function from records that
 * exist (the Outbox's held items and requests, the thread's Results, its LifeOS links and the session's own state),
 * and the host's keeper of it. The keeper folds the outcome line into the session summary the rail reads
 * (`SessionMeta.workOutcome`, sessions.ts `workOutcomeOf`) from what it holds in memory, so a list costs no read a row;
 * it reads again only when an Outbox item or a Result changes, and says the thread's meta again then.
 * `work.threads.record` answers the whole record, with the LifeOS links read at that ask.
 */

/** What the outcome reads of a root's decorated meta. */
export type OutcomeMeta = Pick<SessionMeta, 'status' | 'failure' | 'statusDetail' | 'treeHasLiveWork' | 'treeCanContinue'>

type HeldFacts = Pick<OutboxItem, 'kind' | 'state' | 'scheduledFor' | 'dismissedAt'>
type ResultFacts = Pick<WorkResult, 'id' | 'sessionId' | 'workspaceId' | 'kind' | 'summary' | 'ref' | 'undoneAt' | 'createdAt'>

const asks = (root: OutcomeMeta): boolean => root.status === 'waiting' && !root.treeCanContinue
const failed = (root: OutcomeMeta): boolean => !root.treeHasLiveWork && (root.status === 'error' || !!root.failure)
const working = (root: OutcomeMeta): boolean => root.status === 'running' || root.status === 'starting' || !!root.treeHasLiveWork

/**
 * The one most pressing line: a question or approval, a failure (the turn's, then a send's), what is held for his
 * press, live work, then the newest thing it made or did. Null: a thread that left nothing yet.
 */
export function outcomeOf(root: OutcomeMeta, held: readonly HeldFacts[], results: readonly ResultFacts[]): ThreadOutcome | null {
  if (asks(root)) return { words: 'Asks you', tone: 'asks' }
  if (failed(root)) return { words: failedWords(root.failure?.kind), tone: 'failed' }
  const waiting = held.filter((i) => needsHim(i))
  const sendFailed = waiting.filter((i) => i.state === 'failed')
  if (sendFailed.length) return { words: "Couldn't send", tone: 'failed' }
  const words = heldWords(waiting)
  if (words) return { words, tone: 'held' }
  if (working(root)) return { words: workingWords(root.statusDetail), tone: 'working' }
  const last = newest(results.filter((r) => r.undoneAt === null))
  if (!last) return null
  return isMadeKind(last.kind) ? { words: madeWords(madeOf(last)), tone: 'made' } : { words: doneWords(last.kind, last.summary), tone: 'done' }
}

const newest = <T extends { createdAt: number }>(rows: readonly T[]): T | null => rows.reduce<T | null>((best, r) => (!best || r.createdAt > best.createdAt ? r : best), null)

/** A files Result's ref (files/tools.ts): the files it left, each to open in a Files tab of the workspace. */
type FilesRef = { at: 'files'; workspaceId: string; files: { ref: CanvasSource; name: string }[] }
const FILE_VERB: Record<string, string> = { make: 'Made', rename: 'Renamed', move: 'Moved', copy: 'Copied', trash: 'Put in Trash' }

function filesOf(ref: unknown): FilesRef | null {
  const r = ref as Partial<FilesRef> | null
  return r?.at === 'files' && typeof r.workspaceId === 'string' && Array.isArray(r.files) && r.files.length ? (r as FilesRef) : null
}

/** Where a Result's thing opens, as the window resolves it; null for one with nowhere to open (a file put in the VM, a trashed file). */
export function openOf(result: Pick<ResultFacts, 'kind' | 'ref' | 'workspaceId'>): RecordOpen | null {
  const files = filesOf(result.ref)
  if (files && result.kind !== 'file.trash') return { at: 'files', workspaceId: files.workspaceId, ref: files.files[0]!.ref, name: files.files[0]!.name }
  const r = result.ref as { at?: string; url?: unknown; table?: string; id?: unknown } | null
  if (r?.at === 'google' && typeof r.url === 'string' && /^https:\/\//.test(r.url)) return { at: 'url', url: r.url }
  if (r?.at === 'lifeos' && r.table === 'projects' && typeof r.id === 'string' && result.workspaceId) return { at: 'project', workspaceId: result.workspaceId, projectId: r.id }
  return null
}

/** A Result as a made or changed thing: its verb and its name ("Made" "Seat map.xlsx"), else its summary split at the verb. */
export function madeOf(result: ResultFacts): RecordMade {
  const files = filesOf(result.ref)
  const own = result.kind.startsWith('file.') ? FILE_VERB[result.kind.slice('file.'.length)] : undefined
  const verb = own ?? result.summary.split(' ')[0]!
  const more = files && files.files.length > 1 ? ` and ${files.files.length - 1} more` : ''
  const rest = result.summary.startsWith(verb) ? result.summary.slice(verb.length).trim() : ''
  const name = files ? `${files.files[0]!.name}${more}` : rest || result.summary
  return { id: result.id, sessionId: result.sessionId, kind: result.kind, verb, name, summary: result.summary, at: result.createdAt, undone: result.undoneAt !== null, open: openOf(result) }
}

/** A LifeOS task as `tasks:get` answers it: what the record says of one. */
export interface TaskFacts {
  status: string
  dueAt?: number
  projectId?: string
  waitingOn?: string
  waitingSince?: number
}

export interface LinkFacts {
  entity: { table: string; id: string }
  title: string
  state: 'open' | 'done'
  at: number
}

export interface RecordFacts {
  root: OutcomeMeta & { id: string }
  /** the tree's held items, any state: what waits is read here */
  held: readonly OutboxItem[]
  /** the tree's open requests for his press */
  requests: readonly Pick<OutboxRequest, 'id' | 'n' | 'head' | 'createdAt'>[]
  /** the tree's Results */
  results: readonly ResultFacts[]
  links: readonly LinkFacts[]
  tasks: ReadonlyMap<string, TaskFacts | null>
  worksDown?: string
  workspaceId?: string | null
}

const WORK_TABLES = new Set(['tasks', 'mailThreads', 'events', 'chats'])

/** The record from its facts; pure. */
export function threadRecord(f: RecordFacts): ThreadRecord {
  const waits: RecordWait[] = []
  if (asks(f.root)) waits.push({ kind: 'asks', sessionId: f.root.id })
  if (failed(f.root)) waits.push({ kind: 'failed', sessionId: f.root.id, words: failedWords(f.root.failure?.kind), cause: f.root.failure?.summary ?? null })
  for (const r of f.requests) waits.push({ kind: 'request', id: r.id, n: r.n, head: r.head, at: r.createdAt })
  // A send that failed first, then the rest in the order he must act in.
  const held = f.held.filter((i) => needsHim(i)).sort((a, b) => Number(b.state === 'failed') - Number(a.state === 'failed') || a.createdAt - b.createdAt)
  for (const item of held) waits.push({ kind: 'held', item })
  const works: RecordWork[] = f.links
    .filter((l) => WORK_TABLES.has(l.entity.table))
    .map((l) => {
      const task = l.entity.table === 'tasks' ? f.tasks.get(l.entity.id) : undefined
      return {
        table: l.entity.table as RecordWork['table'],
        id: l.entity.id,
        title: l.title,
        state: task && (task.status === 'done' || task.status === 'dropped') ? 'done' : l.state,
        at: l.at,
        ...(task
          ? { task: { status: task.status, due: task.dueAt ?? null, projectId: task.projectId ?? null, waitingOn: task.status === 'waiting' && task.waitingOn ? { name: task.waitingOn, since: task.waitingSince ?? null } : null } }
          : {})
      }
    })
    // An open task first, then the newest link.
    .sort((a, b) => Number(b.table === 'tasks' && b.state === 'open') - Number(a.table === 'tasks' && a.state === 'open') || b.at - a.at)
  const made = f.results
    .filter((r) => isMadeKind(r.kind) && r.undoneAt === null)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(madeOf)
  return {
    sessionId: f.root.id,
    workspaceId: f.workspaceId ?? null,
    waits,
    works,
    made,
    outcome: outcomeOf(f.root, f.held, f.results),
    ...(f.worksDown ? { worksDown: f.worksDown } : {})
  }
}

// ── the keeper ──────────────────────────────────────────────────────────

/** What the keeper asks of the session registry. */
export interface RecordRegistry {
  get(sessionId: string): SessionMeta | null
  refreshMeta?(ids: Iterable<string>): void
  workOutcomeOf?: ((session: SessionMeta) => ThreadOutcome | null) | null
}

/** Where the keeper reads: the host's Outbox, Results and LifeOS links (`sourcesOf`), or a test's own. */
export interface RecordSources {
  /** every held item that waits, this host's and LifeOS's */
  waiting(): OutboxItem[]
  /** a root's Results with its subagents' */
  results(rootId: string): WorkResult[]
  /** every open request for his press */
  requests(): Pick<OutboxRequest, 'id' | 'n' | 'head' | 'createdAt' | 'sessionId'>[]
  /** the thread's LifeOS links; throws when LifeOS cannot be read */
  links(rootId: string): Promise<LinkFacts[]>
  /** one task as LifeOS has it; null when it cannot be read */
  task(id: string): Promise<TaskFacts | null>
  /** the root a thread's waits and writes belong to: a subagent's are its root's */
  rootOf(sessionId: string): string
  /** the thread's job; null for a Work Chat */
  workspaceOf(rootId: string): string | null
  log(line: string): void
}

export function sourcesOf(ctx: WorkCtx): RecordSources {
  return {
    waiting: () => outboxHostOf(ctx)?.outbox.list({ show: 'waiting', limit: 500 }).items ?? [],
    results: (rootId) => resultsOf(ctx)?.list({ sessionId: rootId, limit: 200 }) ?? [],
    requests: () => outboxHostOf(ctx)?.requests.open() ?? [],
    links: (rootId) => ctx.links.forThread(rootId),
    task: async (id) => (await ctx.lifeos.owner().query<{ task: TaskFacts } | null>('tasks:get', { id }).catch(() => null))?.task ?? null,
    rootOf: (sessionId) => {
      try {
        return ctx.canvas.paneOf(sessionId)
      } catch {
        return sessionId
      }
    },
    workspaceOf: (rootId) => {
      const id = ctx.scopeOf(rootId)?.workspaceId ?? null
      return id && id !== WORK_HOME ? id : null
    },
    log: (line) => ctx.log(line)
  }
}

/** How many task links the record reads in full: one `tasks:get` each. */
const TASKS_READ = 5

export class ThreadRecords {
  /** What waits, by root: built from one Outbox read at the first ask after a change. */
  private held: Map<string, OutboxItem[]> | null = null
  /** Each root's Results, read at its first ask after one of them changed. */
  private results = new Map<string, WorkResult[]>()

  constructor(
    private readonly sources: RecordSources,
    private readonly registry: RecordRegistry
  ) {}

  private heldMap(): Map<string, OutboxItem[]> {
    if (this.held) return this.held
    const map = new Map<string, OutboxItem[]>()
    try {
      for (const item of this.sources.waiting()) {
        if (!item.sessionId) continue
        const root = this.sources.rootOf(item.sessionId)
        map.set(root, [...(map.get(root) ?? []), item])
      }
    } catch (err) {
      this.sources.log(`threads: the Outbox was not read for the records: ${errorText(err)}`)
    }
    return (this.held = map)
  }

  heldOf(rootId: string): OutboxItem[] {
    return this.heldMap().get(rootId) ?? []
  }

  resultsOf(rootId: string): WorkResult[] {
    let rows = this.results.get(rootId)
    if (!rows) {
      try {
        rows = this.sources.results(rootId)
      } catch (err) {
        this.sources.log(`threads: thread ${rootId}'s Results were not read: ${errorText(err)}`)
        rows = []
      }
      this.results.set(rootId, rows)
    }
    return rows
  }

  /** The outcome line of a root's decorated meta, from what the keeper holds. */
  outcome(meta: SessionMeta): ThreadOutcome | null {
    return outcomeOf(meta, this.heldOf(meta.id), this.resultsOf(meta.id))
  }

  /** An Outbox row moved (its item), or LifeOS's held items did (null): the roots it touched are said again. */
  heldChanged(item: Pick<OutboxItem, 'sessionId'> | null): void {
    const before = this.held
    this.held = null
    const roots = item ? (item.sessionId ? [this.sources.rootOf(item.sessionId)] : []) : [...new Set([...(before?.keys() ?? []), ...this.heldMap().keys()])]
    if (roots.length) this.registry.refreshMeta?.(roots)
  }

  /** A Result was made or undone: its root's are read again, and the root said again. */
  resultChanged(result: Pick<WorkResult, 'rootId'>): void {
    this.results.delete(result.rootId)
    this.registry.refreshMeta?.([result.rootId])
  }

  /** Everything read again at the next ask: Work came on or went off. */
  reset(): void {
    this.held = null
    this.results.clear()
  }

  /** The whole record of a Work thread (a subagent's id answers its root's), with its LifeOS links read now. */
  async record(sessionId: string): Promise<ThreadRecord> {
    const rootId = this.sources.rootOf(sessionId)
    const root = this.registry.get(rootId)
    if (!root) throw new Error(`unknown thread: ${sessionId}`)
    if (root.scope !== 'work') throw new Error(`thread ${sessionId} is not a Work thread`)
    // Read fresh: a record is asked once a screen, and a change since the last fold must not be missed.
    this.held = null
    this.results.delete(rootId)
    const requests = this.sources.requests().filter((r) => this.sources.rootOf(r.sessionId) === rootId)
    let links: LinkFacts[] = []
    let worksDown: string | undefined
    const tasks = new Map<string, TaskFacts | null>()
    try {
      links = await this.sources.links(rootId)
      const read = links.filter((l) => l.entity.table === 'tasks').slice(0, TASKS_READ)
      await Promise.all(read.map(async (l) => void tasks.set(l.entity.id, await this.sources.task(l.entity.id))))
    } catch (err) {
      worksDown = errorText(err)
    }
    return threadRecord({
      root,
      held: this.heldOf(rootId),
      requests,
      results: this.resultsOf(rootId),
      links,
      tasks,
      workspaceId: this.sources.workspaceOf(rootId),
      ...(worksDown ? { worksDown } : {})
    })
  }
}

const keepers = new WeakMap<WorkCtx, ThreadRecords>()

/** The context's keeper, for `work.threads.record` (ctx.ts). */
export const threadRecordsOf = (ctx: WorkCtx): ThreadRecords | null => keepers.get(ctx) ?? null

/** Not a member of the context: the keeper, the registry's outcome hook, and while Work is on what it listens to. */
export function threadRecordsPart(ctx: WorkCtx, deps: Pick<WorkPartDeps, 'registry' | 'whileOn'>): void {
  const records = new ThreadRecords(sourcesOf(ctx), deps.registry)
  keepers.set(ctx, records)
  deps.registry.workOutcomeOf = (meta) => records.outcome(meta)
  deps.whileOn(() => {
    records.reset()
    const offs = [outboxHostOf(ctx)?.outbox.onChange((item) => records.heldChanged(item)), resultsOf(ctx)?.onChange((r) => records.resultChanged(r))]
    return () => {
      for (const off of offs) off?.()
      records.reset()
    }
  })
}
