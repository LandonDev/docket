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
  | { on: 'file'; source: CanvasSource; by: 'someone-else' }

export const TriggerSchema = z.discriminatedUnion('on', [
  z.object({ on: z.literal('schedule'), rrule: z.string(), tz: z.string() }),
  z.object({ on: z.literal('lifeos'), kinds: z.array(z.string()), filter: z.record(z.string(), z.string()).optional() }),
  z.object({ on: z.literal('read'), addon: z.string(), tool: z.string(), args: z.unknown(), fire: z.enum(['changed', 'non-empty']), everySec: z.number().int().positive() }),
  z.object({ on: z.literal('file'), source: CanvasSourceSchema, by: z.literal('someone-else') })
])

/** One way a trigger fires. `arm` returns its disarm; `cursor` is what the routine last saw. */
export interface TriggerSource<T extends Trigger = Trigger> {
  on: T['on']
  /** "Weekdays at 7:00 AM", "When Dana Lee changes it" */
  words(t: T): string
  arm(t: T, fire: (cause: string) => void, cursor: unknown): () => void
}
