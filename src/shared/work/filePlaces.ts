import type { TeamsLibrary } from '../contract-work-office'
import { placeKey, type FilePlace, type PlaceState } from './files'

/**
 * A Teams or OneDrive library as places of the Files place (docs/agents/work-files.md "The model"). A place is
 * one thing he would name: a team's channel, a site's library, his own OneDrive, a folder he added; a team's
 * Documents is therefore several places, one per channel. Pure, and shared: the host builds its places with it,
 * and the window builds the same places from a host a release behind, which answers only the old wire
 * (`work.office.filesLibraries`).
 */

/** A place and where it lies: the library and the folder in it that is the place's top. */
export interface LibraryPlace {
  place: FilePlace
  library: TeamsLibrary
  top: string
}

const sepOf = (path: string): string => (path.includes('\\') && !path.includes('/') ? '\\' : '/')
const joinIn = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}${name}`

/**
 * The verbs a library's adapter carries out on this host's own disk. A delete goes to the computer's own bin (the
 * Trash on a Mac, the Recycle Bin on a PC), never for good, and OneDrive takes it to the library's own recycle bin
 * (docs/agents/work-files.md "A delete in a library").
 */
export const LIBRARY_CAN: FilePlace['can'] = ['make', 'rename', 'move', 'copy', 'edit', 'trash']

/**
 * The verbs a library in the Windows VM carries out, by what its helper says it has (`guest.status`'s `verbs`): New
 * needs a folder and a file made, an edit a file written by its version, a delete the Recycle Bin. A helper that lists
 * none (one built before F8) leaves the place's `can` empty, and every change is refused in the grammar's sentence.
 */
export function vmCanOf(verbs: readonly string[] | null | undefined): FilePlace['can'] {
  const has = new Set(verbs ?? [])
  // Without a way to ask what a change did after a lost answer, nothing is offered.
  if (!has.has('files.outcome')) return []
  const can: FilePlace['can'] = []
  if (has.has('files.mkdir') && has.has('files.write')) can.push('make')
  if (has.has('files.rename')) can.push('rename')
  if (has.has('files.move')) can.push('move')
  if (has.has('files.write')) can.push('edit')
  if (has.has('files.recycle')) can.push('trash')
  return can
}

/** The places one library holds: a team's channels, else the library as one place. `vmVerbs`: what the VM's helper says it has, for a library there. */
export function placesIn(library: TeamsLibrary, state: PlaceState, vmVerbs?: readonly string[] | null): LibraryPlace[] {
  const base = { host: library.vm ? 'Windows VM' : '', env: library.host, shared: true, can: library.vm ? vmCanOf(vmVerbs) : [...LIBRARY_CAN], state, web: library.web, ...(library.vm ? { vm: true } : {}) }
  const one = (id: string, kind: FilePlace['kind'], name: string, top: string, key: string, group?: string): LibraryPlace => ({
    place: { ...base, id, kind, name, root: { at: 'file', host: library.host, path: top }, key, ...(group ? { group } : {}) },
    library,
    top
  })
  if (library.kind === 'mine') return [one(library.id, 'onedrive', 'My OneDrive', library.path, 'mine')]
  if (library.kind === 'folder') return [one(library.id, 'teams', library.library ? `${library.team} ${library.library}` : library.team, library.path, `folder:${library.id}`)]
  if (library.kind === 'channels' && library.channels.length) return library.channels.map((channel) => one(`${library.id}/${channel}`, 'teams', channel, joinIn(library.path, channel), placeKey(library.team, channel), library.team))
  // A team's Documents is named so; a library OneDrive named only as one word (its newer layout on a Mac) keeps that name.
  return [one(library.id, 'teams', library.library ?? (library.kind === 'channels' ? 'Documents' : library.team), library.path, placeKey(library.team, library.library ?? ''), library.team)]
}
