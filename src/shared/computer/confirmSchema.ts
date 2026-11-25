import { z } from 'zod'
import { CONFIRM_KINDS, CONFIRM_WHAT_MAX, type Confirm } from './policy'

/**
 * The flag on `computer_act` and `computer_batch`; undescribed here, descriptions.ts gives the tools described copies.
 * Apart from policy.ts so the words the window draws for a computer step (words.ts, in the first paint) carry no zod.
 */
export const ConfirmSchema = z.object({
  kind: z.enum(CONFIRM_KINDS),
  what: z.string().min(1).max(CONFIRM_WHAT_MAX)
})

// The schema and the plain shape are one thing.
const _same: [z.infer<typeof ConfirmSchema>] extends [Confirm] ? ([Confirm] extends [z.infer<typeof ConfirmSchema>] ? true : false) : false = true
void _same
