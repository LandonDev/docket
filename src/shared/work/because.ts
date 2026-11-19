import { z } from 'zod'

/**
 * Why an agent writes to an item other people can see (architecture §6.7,
 * §8.4): a shared document, a guest-linked sheet, a workbook in Teams, a
 * Google file. A write there reaches them at once, so the reason is checked
 * by the host and never taken on the model's word:
 *
 *  - `own`: the agent's own idea. Always a suggestion.
 *  - `asked`: the owner asked for this change in so many words. The tool
 *    carries a quote, and the host finds that quote in one of the owner's
 *    own messages in the thread (`ctx.threads.ownerSaid`); else a suggestion.
 *  - `routine`: this run's routine was granted it. Checked against the
 *    run's standing grants; else a suggestion.
 *
 * On an item only the owner sees, every write is direct, whatever the reason.
 */
export const BECAUSE = ['asked', 'routine', 'own'] as const
export type Because = (typeof BECAUSE)[number]
export const BecauseSchema = z.enum(BECAUSE)

/** What a write tool's arguments carry beside the change itself. */
export const WriteReasonSchema = z.object({
  because: BecauseSchema,
  /** with `asked`: the owner's own words asking for this change, copied from one of his messages in this thread */
  quote: z.string().max(2_000).optional()
})
export type WriteReason = z.infer<typeof WriteReasonSchema>

export interface WriteFacts {
  /** `WorkScope.shared(source)`: other people can see the item */
  shared: boolean
  /** `ctx.threads.ownerSaid(sessionId, quote)` */
  ownerSaid(quote: string): boolean
  /** whether a standing grant of this run's routine covers the write; absent: none does */
  routineGranted?: () => boolean
}

/**
 * Whether a write lands directly or as a suggestion. The model's `because`
 * can only ever make a write weaker than it asked: nothing it says turns a
 * suggestion into a write without the host finding the owner's words or
 * the owner's grant.
 */
export function judgeWrite(reason: WriteReason, facts: WriteFacts): 'write' | 'suggest' {
  if (!facts.shared) return 'write'
  if (reason.because === 'asked') return reason.quote && facts.ownerSaid(reason.quote) ? 'write' : 'suggest'
  if (reason.because === 'routine') return facts.routineGranted?.() ? 'write' : 'suggest'
  return 'suggest'
}
