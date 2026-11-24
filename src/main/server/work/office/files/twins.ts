import { teamsPlaceKey, type TeamsLibrary } from '@shared/contract-work-office'

/** The places a library holds, each by its key (`teamsPlaceKey`) and the folder in the library that is its top ('' for the library itself). */
export function placesOf(l: TeamsLibrary): { key: string; top: string }[] {
  if (l.kind === 'folder') return []
  if (l.kind === 'mine') return [{ key: 'mine', top: '' }]
  if (l.kind === 'channels' && l.channels.length) return l.channels.map((c) => ({ key: teamsPlaceKey(l.team, c), top: c }))
  return [{ key: teamsPlaceKey(l.team, l.library ?? ''), top: '' }]
}

/**
 * The same file on another machine: a Mac syncs one folder of a site's library as a library of its own
 * (`RecWell-TeamRecWell`), the VM the whole library with that folder at its top (`RecWell - Documents\Team
 * RecWell`). Null when no other library holds the place `file` lies in.
 */
export function twinOf(all: readonly TeamsLibrary[], library: TeamsLibrary, file: string): { library: TeamsLibrary; file: string } | null {
  const parts = file.split('/').filter(Boolean)
  for (const place of placesOf(library)) {
    const top = place.top ? [place.top] : []
    if (top.length && parts[0]?.toLowerCase() !== top[0]!.toLowerCase()) continue
    const rest = parts.slice(top.length)
    for (const other of all) {
      if (other.id === library.id) continue
      const there = placesOf(other).find((p) => p.key === place.key)
      if (there) return { library: other, file: [...(there.top ? [there.top] : []), ...rest].join('/') }
    }
  }
  return null
}
