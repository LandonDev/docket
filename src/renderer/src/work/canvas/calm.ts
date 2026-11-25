/**
 * When a file's save line says Saving… (docs/DESIGN.md "The Files place", the owner's decision 5 of the Files pass):
 * Saved <time> names the last save confirmed for these bytes, and it stays while his edits wait inside the editor's
 * own short pause; Saving… shows once a send has been out `SEND_SHOWN_MS`, or edits have waited past their pause with
 * nothing sent. A failure is the kind's to say, at once, before it asks here. Close, quit and ⌘S send what waits at
 * once (canvas/flush.ts), so the pause never holds an edit back from them. One rule for every kind that saves: text,
 * sheets, decks, documents and a Word file's line.
 */

/** How long a send may be out before the line says Saving…: under it, the last Saved line stays. */
export const SEND_SHOWN_MS = 600;

/** Each editor's own pause after his last edit before it sends (text, a deck's open box, a document's store, Word's autosave on the host). */
export const PAUSE_MS = { text: 700, deck: 2000, document: 2000, word: 3000 } as const;

export interface Unsaved {
  /** when his last edit not yet sent was made; null when none waits */
  edited: number | null;
  /** the editor's own pause after an edit */
  pause: number;
  /** when the send now out began (the first of a run of sends, back to back); null when none is out */
  sent: number | null;
}

/**
 * Whether the line says Saving… now, and in how many ms the answer changes by time alone (null: only a new fact
 * changes it). Edits waiting behind a send that is out go when it answers, so that send's time decides.
 */
export function savingNow(u: Unsaved, now: number): { saving: boolean; again: number | null } {
  if (u.sent !== null) {
    const left = u.sent + SEND_SHOWN_MS - now;
    return left <= 0 ? { saving: true, again: null } : { saving: false, again: left };
  }
  if (u.edited !== null) {
    const left = u.edited + u.pause - now;
    return left <= 0 ? { saving: true, again: null } : { saving: false, again: left };
  }
  return { saving: false, again: null };
}

/** A stage that only shows once it has lasted `SEND_SHOWN_MS` (OneDrive uploading, a copy's send to its computer): `since` is when it began. */
export const stageNow = (since: number | null, now: number): { shown: boolean; again: number | null } => {
  const { saving, again } = savingNow({ edited: null, pause: 0, sent: since }, now);
  return { shown: saving, again };
};
