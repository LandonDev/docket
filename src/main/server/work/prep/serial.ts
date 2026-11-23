import type { WorkCtx } from '../modules'

const changing = new WeakMap<WorkCtx['db'], Map<string, Promise<unknown>>>()

/** Run one change at a time for this page or switch, even across windows. */
export function changeInOrder<T>(ctx: WorkCtx, key: string[], change: () => Promise<T>): Promise<T> {
  const id = JSON.stringify(key)
  const pending = changing.get(ctx.db) ?? new Map<string, Promise<unknown>>()
  changing.set(ctx.db, pending)
  const mine = (pending.get(id) ?? Promise.resolve()).then(change)
  const tail = mine.catch(() => undefined)
  pending.set(id, tail)
  void tail.then(() => {
    if (pending.get(id) === tail) pending.delete(id)
  })
  return mine
}
