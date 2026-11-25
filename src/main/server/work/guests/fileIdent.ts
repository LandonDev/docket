import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { readText, readZip, writeZip } from '../sheets/patch/zip'

/**
 * Which file a guest link is for (docs/agents/work-guests.md "A file's link is for one file"). A link names its
 * file by path, and a path can come to hold another file: one moved or saved over it, a folder link pointed
 * elsewhere. So a `.tcdoc` and a `.tcsheet` each carry an id of their own inside the file, which every save of
 * ours keeps (a `.tcdoc`'s store keeps every entry it does not write; a `.tcsheet`'s meta goes back as it was
 * read), and a link remembers the id its file had when he shared it. Main reads it before each list it sends the
 * service, and the service before it opens the file for a guest: another id, or none, is another file, and the
 * link shows nothing of it. A copy of the file carries the same id: it is the same document.
 *
 * Reached by the Work service too, so by relative paths alone.
 */

/** A `.tcdoc`'s own entry for it; a `.tcsheet` keeps its id in `meta.json`. */
export const TCDOC_IDENT = 'ident.json'

const isSheet = (path: string): boolean => path.toLowerCase().endsWith('.tcsheet')
const stampOf = (path: string): string => {
  const st = statSync(path)
  return `${st.ino}:${st.size}:${st.mtimeMs}`
}

/** By path, with the file's inode, size and time it was read at: a file nothing wrote since is not read again. */
const read = new Map<string, { stamp: string; uid: string | null }>()

/** The id inside a `.tcdoc` or `.tcsheet`; null for a file that has none yet, is not there, or cannot be read. */
export function fileUid(path: string): string | null {
  let stamp: string
  try {
    stamp = stampOf(path)
  } catch {
    read.delete(path)
    return null
  }
  const held = read.get(path)
  if (held?.stamp === stamp) return held.uid
  let uid: string | null = null
  try {
    const z = readZip(new Uint8Array(readFileSync(path)))
    const entry = isSheet(path) ? 'meta.json' : TCDOC_IDENT
    const id = z.byName.has(entry) ? (JSON.parse(readText(z, entry)) as { id?: unknown }).id : undefined
    uid = typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null
  } catch {
    uid = null
  }
  if (read.size > 500) read.clear()
  read.set(path, { stamp, uid })
  return uid
}

/**
 * A `.tcdoc`'s id, made when it has none. Only the Work service calls it: it is the file's one writer, and this
 * read and write run in one turn of its loop, as its store's do, so neither sees half of the other's.
 */
export function ensureDocUid(path: string): string {
  const held = fileUid(path)
  if (held) return held
  const z = readZip(new Uint8Array(readFileSync(path)))
  const uid = randomUUID()
  const bytes = new TextEncoder().encode(`${JSON.stringify({ id: uid })}\n`)
  const temp = `${path}.${process.pid}.ident`
  writeFileSync(temp, writeZip(z, z.byName.has(TCDOC_IDENT) ? new Map([[TCDOC_IDENT, bytes]]) : new Map(), new Set(), z.byName.has(TCDOC_IDENT) ? new Map() : new Map([[TCDOC_IDENT, bytes]])))
  renameSync(temp, path)
  return uid
}
