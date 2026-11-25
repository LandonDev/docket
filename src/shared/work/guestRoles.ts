/**
 * What a guest link can do to what (docs/agents/work-guests.md), with no zod: the window's Share sheet reads it, and
 * the contract (contract-work-guests.ts) checks every link by it.
 */

export const GUEST_ROLES = ['view', 'comment', 'edit'] as const
export type GuestRole = (typeof GUEST_ROLES)[number]

/** What kind of item a source is: a file by its name, null for a file no link can be for. */
export function guestTableOf(source: { at: 'lifeos'; table: 'docs' | 'sheets' | 'projects' } | { at: 'file'; path: string }): 'docs' | 'sheets' | 'projects' | null {
  if (source.at === 'lifeos') return source.table
  const name = source.path.toLowerCase()
  return name.endsWith('.tcdoc') ? 'docs' : name.endsWith('.tcsheet') ? 'sheets' : null
}

/**
 * The roles a link to this item can have: a project's views; a sheet's view or edit (sheets keep no comments); a
 * document's all three, kept in LifeOS or as a file (a `.tcdoc`'s comments are on the computer that has it, and the
 * Work service asks that computer's app for them: guests/comments.ts).
 */
export function guestRolesOf(source: Parameters<typeof guestTableOf>[0]): readonly GuestRole[] {
  const table = guestTableOf(source)
  if (table === 'projects') return ['view']
  if (table === 'sheets') return ['view', 'edit']
  return GUEST_ROLES
}

/**
 * Why a document or sheet is not shared by link, in the one line its Share sheet shows in place of the form: the
 * host's refusals of a file, and the window's own for what is not ours. Each says what to do instead.
 */
export const SHARE_REFUSALS = {
  word: 'Guest links open TempCode documents. Save As a TempCode document to share this one.',
  excel: 'Guest links open TempCode sheets. Save As a TempCode sheet to share this one.',
  teams: 'This file lives in Teams. Share it from Teams.',
  teamsCopy: 'This document is a Teams file opened here. Share it from Teams.',
  google: 'This file lives in Google Drive. Share it from Google.',
  shared: 'This file is in a place others open. Share it from there.',
  gone: 'That file is not there any more.',
  linkedOut: 'This document is saved to another file as it changes, so a guest can view it but not edit it.',
  moved: 'That file is not the one the thread asked to share any more. Nothing was made.',
  noPage: 'Guests reach files on the box only. Keep this file in a workspace on the box to share it.',
  other: 'Guest links open TempCode documents and sheets only.'
} as const

/** Whether words a host answered are one of the refusals above: said as the sheet's line, not as a failure. */
export const isShareRefusal = (text: string): boolean => (Object.values(SHARE_REFUSALS) as string[]).some((line) => text.includes(line))
