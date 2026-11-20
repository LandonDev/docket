import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * A held draft whose owner press already waited out the undo time in the window
 * (docs/agents/work-mail.md "Send"). `work.mail.send {waited: true}` runs its
 * one call into the hold inside `withWaited`; the hold's `mail.send` takes the
 * mark when the owner himself decided, and only then tells LifeOS the mail is
 * due at once (`compose.send {immediate}`).
 *
 * The mark lives in the call itself, not beside it: only the act that runs
 * inside this call's own claim can take it, once, for this draft, and it is
 * gone when the call returns. A press from the Outbox page, a grant's send and
 * the phone's run in calls of their own, find no mark, and keep LifeOS's queue
 * and its Undo, whichever of them wins the claim.
 */
type Mark = { draftId: string; live: boolean }
const scope = new AsyncLocalStorage<Mark>()

/** Runs `send`, the one call into the hold, with this draft marked as waited for its length. */
export async function withWaited<T>(draftId: string, send: () => Promise<T>): Promise<T> {
  const mark: Mark = { draftId, live: true }
  try {
    return await scope.run(mark, send)
  } finally {
    // Anything the call left running (a timer, a listener) inherits the scope: it finds the mark spent.
    mark.live = false
  }
}

/** True once, inside the call that marked this draft; never after it, and never for another draft. */
export function takeWaited(draftId: string): boolean {
  const mark = scope.getStore()
  if (!mark?.live || mark.draftId !== draftId) return false
  mark.live = false
  return true
}
