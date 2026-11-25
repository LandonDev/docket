import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { DocStore } from 'work-kit/collab-server'
import { fileUid } from '../guests/fileIdent'

/**
 * A `.tcdoc`'s live document stores only over the file it was loaded from (docs/agents/work-docs.md "The socket"). A
 * rename or move takes the file from under a document still open at its old name: a window's late frames, or a
 * retry, would store it there again and make a second file of the old one, which a file put at that name since
 * (even one with the same bytes) would take as its own. So a document loaded from a file stores only while a file is
 * at its path and that file is the same document (its own id, guests/fileIdent.ts). Otherwise the store is refused
 * as "not found": work-kit keeps those edits in its journal and does not try again. Loaded by the service's entry:
 * node, work-kit and relative paths only (service/boundary.test.ts).
 */
export function boundToFile(store: DocStore): DocStore {
  /** By document name: the id of the file it was loaded from (null when it had none yet); absent, it came from no file. */
  const loaded = new Map<string, string | null>()
  const note = (name: string, path: string): void => {
    if (existsSync(path)) loaded.set(name, fileUid(path) ?? loaded.get(name) ?? null)
  }
  return {
    kind: store.kind,
    async load(name, file) {
      const got = await store.load(name, file)
      loaded.delete(name)
      if (file) note(name, file.path)
      return got
    },
    async store(name, state, text, file) {
      if (file && loaded.has(name)) {
        const was = loaded.get(name)!
        if (!existsSync(file.path)) throw new Error(`not found: ${basename(file.path)} moved or went, so its document is not made again there`)
        if (was !== null && fileUid(file.path) !== was) throw new Error(`not found: another file is at ${basename(file.path)} now, so this document is not stored over it`)
      }
      const result = await store.store(name, state, text, file)
      if (file) note(name, file.path)
      return result
    },
    forget(name) {
      loaded.delete(name)
      store.forget?.(name)
    }
  }
}
