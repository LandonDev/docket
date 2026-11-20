import type { AddonRow } from '@shared/contract-addons'
import { writtenByOwner, type SessionMeta } from '@shared/events'
import type { WorkspaceMeta } from '@shared/domain'
import type { AddonCallResult } from '../../addons/addonWire'
import type { WorkPartDeps } from '../ctx'

/**
 * What the routines engine needs of the host that `WorkCtx` does not carry:
 * a watch's own add-on read (no thread behind it, so the gate lets only a
 * tool set to Runs through), the threads a run settles in, their read
 * marks, and what a run's tree left held. `routinesHostPart` is called once
 * from `buildWorkCtx` with the host's handles; a test hands the engine its
 * own `RoutinesHost`.
 */
export interface RoutinesHost {
  /** A Work workspace by id; null when there is none. */
  workspace(id: string): Pick<WorkspaceMeta, 'id' | 'name' | 'sector'> | null
  /** The add-on a watch in `workspaceId` may read, by id or name: the workspace's own, or a global one allowed in Work. */
  addon(workspaceId: string, idOrName: string): AddonRow | null
  /** Whether the host's own call (no thread) may run this tool: only when the owner set it to Runs. */
  mayRead(addonId: string, tool: string): boolean
  /** The host's own call through the add-on gate, as a watch makes it. */
  read(addonId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AddonCallResult>
  session(id: string): SessionMeta | null
  onMeta(fn: (session: SessionMeta) => void): () => void
  markRead(sessionId: string): void
  markUnread(sessionId: string): void
  /**
   * What a run's thread and its subagents left for the owner: acts held by the host, and drafts made in LifeOS
   * as their transcripts show them. `drafts: false` leaves the transcripts out, for a caller that counts
   * LifeOS's drafts from the Outbox's own list.
   */
  heldIn(sessionId: string, o?: { drafts?: boolean }): number
  /** Whether a thread below this one still works: its run has not settled while a subagent runs. */
  busyBelow(sessionId: string): boolean
  /** The thread a run made, if it was made before the host stopped. */
  threadOfRun(runId: string): string | null
  /** Whether the add-on's server calls this tool read-only (its listing or its hints): only such a tool may be watched by a thread. */
  readOnly(addonId: string, tool: string): boolean
  /** A thread's messages, oldest first: what the owner wrote, what the app or another thread wrote in, and the agent's whole answers (no streamed pieces), to draft a play from. */
  words(sessionId: string): { by: 'owner' | 'app' | 'agent'; text: string }[]
}

/** Statuses of a thread that still works or waits to. */
export const BUSY = new Set(['starting', 'running', 'queued', 'watching', 'waiting'])

let current: RoutinesHost | null = null

/** The host's handles as the engine reads them; null before boot and in a test that hands in its own. */
export const routinesHost = (): RoutinesHost | null => current

/** The LifeOS tools whose call leaves a draft waiting for the owner's press. */
const DRAFT_TOOLS = /(^|__|")(draft_mail|update_mail_draft|draft_calendar_op)("|$)/

export function routinesHostPart(deps: WorkPartDeps): void {
  const { registry, store, db } = deps
  const treeOf = (sessionId: string): string[] =>
    (db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT s.id FROM sessions s JOIN tree t ON s.parent_id = t.id) SELECT id FROM tree`).all(sessionId) as { id: string }[]).map((r) => r.id)
  current = {
    workspace: (id) => store.listWorkspaces().find((w) => w.id === id) ?? null,
    addon(workspaceId, idOrName) {
      const addons = deps.addons
      if (!addons) return null
      const rows = addons.list().filter((row) => row.workspaceId === workspaceId || (row.workspaceId == null && addons.workMarks(row.id)?.forWork === true))
      return rows.find((row) => row.id === idOrName) ?? rows.find((row) => row.workspaceId === workspaceId && row.name === idOrName) ?? rows.find((row) => row.name === idOrName) ?? null
    },
    mayRead: (addonId, tool) => deps.addonHost?.verdict(addonId, tool, { sessionId: null, work: true }) === 'run',
    async read(addonId, tool, args, signal) {
      if (!deps.addonHost) throw new Error('refused: no add-on host here')
      return deps.addonHost.call(addonId, tool, args, { work: true, sessionId: null, ...(signal ? { signal } : {}) })
    },
    session: (id) => registry.get(id),
    onMeta: (fn) => registry.onMeta((session) => fn(session)),
    markRead: (id) => registry.markRead([{ sessionId: id }]),
    markUnread: (id) => registry.markUnread([id]),
    heldIn(sessionId, o) {
      const tree = treeOf(sessionId)
      let held = 0
      try {
        const marks = tree.map(() => '?').join(',')
        held = (db.prepare(`SELECT COUNT(*) AS n FROM work_held_acts WHERE state IN ('held', 'live') AND session_id IN (${marks})`).get(...tree) as { n: number }).n
      } catch {
        // no outbox table on this host: nothing held by it
      }
      for (const id of o?.drafts === false ? [] : tree) {
        for (const row of registry.eventsAfter(id, 0)) {
          const event = row.event
          if (event.type !== 'tool-call' || event.partial) continue
          if (DRAFT_TOOLS.test(event.name) || (/addon_call$/.test(event.name) && DRAFT_TOOLS.test(JSON.stringify(event.input ?? null)))) held++
        }
      }
      return held
    },
    busyBelow: (sessionId) => treeOf(sessionId).some((id) => id !== sessionId && BUSY.has(registry.get(id)?.status ?? '')),
    threadOfRun: (runId) => (db.prepare(`SELECT id FROM sessions WHERE routine_run_id = ? LIMIT 1`).get(runId) as { id: string } | undefined)?.id ?? null,
    words: (sessionId) =>
      registry.eventsAfter(sessionId, 0).flatMap(({ event }): { by: 'owner' | 'app' | 'agent'; text: string }[] =>
        event.type === 'user-text'
          ? [{ by: !event.by || writtenByOwner(event.by) ? 'owner' : 'app', text: event.text }]
          : event.type === 'assistant-text' && !event.delta
            ? [{ by: 'agent', text: event.text }]
            : []
      ),
    readOnly(addonId, tool) {
      const listed = deps.addons?.tools(addonId)?.tools.find((t) => t.name === tool)
      const hints = deps.addons?.toolHints(addonId)[tool]
      return (listed?.readOnly === true || hints?.readOnly === true) && hints?.destructive !== true
    }
  }
}
