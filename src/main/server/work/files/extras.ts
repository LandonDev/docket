import type { FileEntry } from '@shared/work/files'
import type { FolderExtra } from './hooks'

/**
 * A pillar's rows in one page of a library folder (hooks.ts `registerFolderExtras`): each goes just before the file
 * it names, on the page that holds that file, and the file takes its `answersTo`; one that names no file of the
 * folder (`inFolder` false), or none, goes at the head of the folder's files on the first page. A page of folders
 * alone takes none.
 */
export function placeExtras(entries: readonly FileEntry[], extras: readonly FolderExtra[], o: { first: boolean; inFolder(name: string): boolean }): FileEntry[] {
  if (!extras.length) return [...entries]
  const index = new Map(entries.flatMap((e, i) => (e.folder ? [] : [[e.name.toLowerCase(), i] as const])))
  const before = new Map<number, FolderExtra[]>()
  const head: FolderExtra[] = []
  for (const x of extras) {
    const at = x.before ? index.get(x.before.toLowerCase()) : undefined
    if (at !== undefined) before.set(at, [...(before.get(at) ?? []), x])
    else if (o.first && (!x.before || !o.inFolder(x.before))) head.push(x)
  }
  const out: FileEntry[] = []
  const firstFile = entries.findIndex((e) => !e.folder)
  entries.forEach((e, i) => {
    if (i === firstFile) out.push(...head.map((x) => x.entry))
    const xs = before.get(i)
    if (!xs) return void out.push(e)
    out.push(...xs.map((x) => x.entry))
    const answersTo = xs.find((x) => x.answersTo)?.answersTo
    out.push(answersTo ? { ...e, answersTo } : e)
  })
  // A folder of folders alone (or an empty one): the head goes after them.
  if (firstFile < 0) out.push(...head.map((x) => x.entry))
  return out
}
