import type { DocStore } from 'work-kit/collab-server'

/**
 * What each live document's last store came to, as the service's own stores answered it (docs/agents/work-docs.md
 * "The socket"). work-kit's collab server keeps a failed store in its journal and tries again later, telling no
 * caller; `/internal/docs/stored` reads the answer here, so a tab's close is told the document is on disk only when
 * it is. Loaded by the service's entry: work-kit types only.
 */
export type StoreOutcome = { ok: true } | { merged: true } | { failed: string }

export interface StoreBook {
  /** The same store, its every `store` call's outcome written down by the document's name. */
  wrap<S extends DocStore>(store: S): DocStore
  /** The outcome written since the last `take` of this name, and forgets it. */
  take(name: string): StoreOutcome | undefined
}

export function storeBook(): StoreBook {
  const last = new Map<string, StoreOutcome>()
  return {
    wrap: (store) => ({
      kind: store.kind,
      load: (name, file) => store.load(name, file),
      async store(name, state, text, file) {
        try {
          const result = await store.store(name, state, text, file)
          last.set(name, result && 'merge' in result ? { merged: true } : { ok: true })
          return result
        } catch (err) {
          last.set(name, { failed: err instanceof Error ? err.message : String(err) })
          throw err
        }
      },
      ...(store.forget ? { forget: (name: string) => store.forget!(name) } : {})
    }),
    take(name) {
      const got = last.get(name)
      last.delete(name)
      return got
    }
  }
}
