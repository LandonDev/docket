import type { BlockDiff } from 'work-kit/formats/diff'
import { z } from 'zod'
import { CanvasSourceSchema } from './work/canvas'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The history pillar's wire (docs/agents/work-history.md): a document's
 * versions, the compare of any two, a restore, and the branches that hold
 * suggestions. Its methods are `work.history.<verb>`; src/shared/work/wire.ts
 * has the helpers and the rules. A source is a LifeOS document
 * (`{ at: 'lifeos', table: 'docs' }`) or a `.tcdoc` on this host.
 *
 * Who did something is a principal (`owner`, `agent:<host>:<thread>`,
 * `guest:<link>`, `lifeos:<client>`, `external:<name>`); each answer
 * carries `names`, the words a screen shows for each one it holds.
 */

/** When a version was cut (LifeOS's `DOC_VERSION_CAUSES`). */
export type HistoryCause = 'agent-turn' | 'before-agent' | 'guest-end' | 'idle' | 'before-restore' | 'restore' | 'import' | 'named'

export interface HistoryVersion {
  id: string
  at: number
  cause: HistoryCause
  /** a name the owner gave it, or what an acceptance took */
  label?: string
  /** who wrote since the version before */
  by: string[]
  restoredFrom?: string
  /** `blocks` once a compaction made its snapshot unreadable: it still compares and restores */
  kept: 'snapshot' | 'blocks'
}

export interface HistoryVersions {
  versions: HistoryVersion[]
  /** whether others can see it: a restore then waits as suggestions */
  shared: boolean
  names: Record<string, string>
}

export type { BlockDiff, DiffBlock, DiffLine, DiffRow, DiffRun, InlineOp } from 'work-kit/formats/diff'

export interface HistoryCompare {
  diff: BlockDiff
  names: Record<string, string>
}

export interface HistoryBranch {
  id: string
  baseVersionId: string
  authors: string[]
  label: string
  at: number
  editedAt: number
  diff: BlockDiff
}

/** A write's result. A direct restore also names the version cut just before it: its Undo goes back there. */
export type HistoryWrite = { mode: 'direct'; versionId?: string; beforeVersionId?: string } | { mode: 'branch'; branchId: string; versionId: string }

const side = z.union([z.literal('live'), z.string().min(1).max(64)])

export const HistoryRequestSchemas = [
  /** → HistoryVersions, newest first */
  request('work.history.versions', z.object({ source: CanvasSourceSchema })),
  /** → HistoryCompare: `from` and `to` are version ids or `live` */
  request('work.history.compare', z.object({ source: CanvasSourceSchema, from: side, to: side })),
  /** → HistoryVersion: a version cut now, named by the owner */
  request('work.history.cut', z.object({ source: CanvasSourceSchema, label: z.string().max(200).optional() })),
  /** → HistoryWrite: the document back to a version, as a forward edit; on a shared document a branch of suggestions */
  request('work.history.restore', z.object({ source: CanvasSourceSchema, versionId: z.string().min(1).max(64) })),
  /** → { branches: HistoryBranch[]; names }: the pending branches, each with what it suggests */
  request('work.history.branches', z.object({ source: CanvasSourceSchema })),
  /** → { left: number }: Accept or Reject rows of a branch (block ids), or all of it */
  request(
    'work.history.decide',
    z.object({
      source: CanvasSourceSchema,
      branchId: z.string().min(1).max(64),
      which: z.union([z.literal('all'), z.array(z.string().min(1).max(64)).min(1).max(1000)]),
      accept: z.boolean(),
      /** the branch's `editedAt` as the screen read it: a branch an agent changed since is refused, not taken as he never saw it */
      editedAt: z.number().int().min(0).optional()
    })
  )
] as const

export type HistoryPush = never

export const HISTORY_CAPS = {
  'work.history.versions': 'read',
  'work.history.compare': 'read',
  'work.history.cut': 'operate',
  'work.history.restore': 'operate',
  'work.history.branches': 'read',
  'work.history.decide': 'operate'
} satisfies CapsOf<typeof HistoryRequestSchemas>
export const HISTORY_RELAY = {} satisfies RelayOf<typeof HistoryRequestSchemas>
