/**
 * What the service saw of each guest link, kept in this process alone and asked for by main
 * (`/internal/guests/seen`): when it was last opened, how many sockets it holds now, and when its guest last
 * changed the item (a document update passed on, or a sheet batch acknowledged). Main lists the first two beside
 * each link and tells the owner of a first open and of a day's edits (guests/tells.ts). A restart forgets it: the
 * next open says it again.
 */
export interface LinkSeen {
  at: number
  open: number
  /** when the link's guest last changed the item; absent: not since this service started */
  wrote?: number
}

export const seen = new Map<string, LinkSeen>()

export const noteOpened = (id: string, now = Date.now()): void => void seen.set(id, { ...seen.get(id), at: now, open: seen.get(id)?.open ?? 0 })

export function noteSockets(id: string, by: number, now = Date.now()): void {
  const s = seen.get(id) ?? { at: now, open: 0 }
  seen.set(id, { ...s, at: now, open: Math.max(0, s.open + by) })
}

/** The link's guest changed the item just now. */
export function noteWrote(id: string, now = Date.now()): void {
  const s = seen.get(id) ?? { at: now, open: 0 }
  seen.set(id, { ...s, wrote: now })
}
