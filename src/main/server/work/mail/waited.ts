/**
 * Drafts whose owner press already waited out the undo time in the window
 * (docs/agents/work-mail.md "Send"). `work.mail.send {waited: true}` marks
 * the draft for the length of its one call into the hold; the hold's
 * `mail.send` takes the mark when the owner himself decided, and only then
 * tells LifeOS the mail is due at once (`compose.send {immediate}`). Nothing
 * on the wire of the Outbox carries this, so a send from the Outbox page, by
 * a grant or from the phone keeps LifeOS's queue and its Undo.
 */
const waited = new Set<string>()

export function markWaited(draftId: string): void {
  waited.add(draftId)
}

/** True once, for a draft that was marked; the mark is gone after. */
export function takeWaited(draftId: string): boolean {
  return waited.delete(draftId)
}
