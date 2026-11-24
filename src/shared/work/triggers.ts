import { z } from 'zod'
import { CanvasSourceSchema, type CanvasSource } from './canvas'

/**
 * What fires a routine or a watch (`work_routines.trigger_spec`). The
 * scheduler and the four sources are milestone 32's; a pillar adds a source
 * through `WorkModule.triggers`.
 */
export type Trigger =
  | { on: 'schedule'; rrule: string; tz: string }
  | { on: 'lifeos'; kinds: string[]; filter?: Record<string, string> }
  | { on: 'read'; addon: string; tool: string; args: unknown; fire: 'changed' | 'non-empty'; everySec: number }
  | { on: 'file'; source: TriggerFileSource; by: 'someone-else' }

/**
 * A Microsoft form a routine watches for new answers (docs/agents/work-msforms.md "Answers as data in Work"): Forms'
 * own id in one workspace. Not a canvas source: it opens nothing by itself.
 */
export type MsformTriggerSource = { at: 'msform'; workspaceId: string; formId: string }
/** What a file trigger watches: a canvas source, or a Microsoft form's answers. */
export type TriggerFileSource = CanvasSource | MsformTriggerSource

export const MsformTriggerSourceSchema = z.object({ at: z.literal('msform'), workspaceId: z.string().min(1), formId: z.string().min(1) })

export const TriggerSchema = z.discriminatedUnion('on', [
  z.object({ on: z.literal('schedule'), rrule: z.string(), tz: z.string() }),
  z.object({ on: z.literal('lifeos'), kinds: z.array(z.string()), filter: z.record(z.string(), z.string()).optional() }),
  z.object({ on: z.literal('read'), addon: z.string(), tool: z.string(), args: z.unknown(), fire: z.enum(['changed', 'non-empty']), everySec: z.number().int().positive() }),
  z.object({ on: z.literal('file'), source: z.union([CanvasSourceSchema, MsformTriggerSourceSchema]), by: z.literal('someone-else') })
])

/** What a firing says is new, for a job: opaque to the engine. */
export type TriggerRange = Readonly<Record<string, unknown>>

/** One way a trigger fires. `arm` returns its disarm; `cursor` is what the routine last saw. */
export interface TriggerSource<T extends Trigger = Trigger> {
  on: T['on']
  /** A `file` source names the place it watches (`microsoft`, `google`, `msform`, …): the engine asks it only about files there. */
  at?: TriggerFileSource['at']
  /** "Weekdays at 7:00 AM", "When Dana Lee changes it" */
  words(t: T): string
  /**
   * `fire`'s `range` is the source's own opaque account of what is new (a Microsoft form's `{formId, fromId, toId}`):
   * the engine hands it to a routine's job as `at.range` and reads nothing in it.
   */
  arm(t: T, fire: (cause: string, range?: TriggerRange) => void, cursor: unknown): () => void
}
