import type { History } from 'work-kit/collab-server'

/**
 * One turn at a time per document on this host, around work-kit's history (docs/agents/work-history.md "A decision
 * bound to what he read"). work-kit already runs its own acts on a document in order, but a check the host makes
 * before one (that a branch is still as his screen read it) is not inside that order: an agent's write asked just
 * before his Accept would land between the check and the take, and he would take words he never saw. Every write,
 * format, restore, accept and reject on the service's `history` goes through this queue, and `inTurn` runs a check
 * and its act together, after everything asked before it. Loaded by the service's entry: work-kit only.
 */
export type QueuedHistory = History & {
  /** Runs `fn` in the document's turn, with the history underneath (never this one: its acts would wait on themselves). */
  inTurn<T>(name: string, fn: (raw: History) => Promise<T>): Promise<T>
}

export function queuedHistory(raw: History): QueuedHistory {
  const queues = new Map<string, Promise<unknown>>()
  const inTurn = <T>(name: string, fn: (raw: History) => Promise<T>): Promise<T> => {
    const before = queues.get(name) ?? Promise.resolve()
    const next = before.then(
      () => fn(raw),
      () => fn(raw)
    )
    const tail = next.catch(() => {})
    queues.set(name, tail)
    void tail.then(() => {
      if (queues.get(name) === tail) queues.delete(name)
    })
    return next
  }
  return {
    ...raw,
    inTurn,
    write: (name, ...rest) => inTurn(name, (h) => h.write(name, ...rest)),
    format: (name, ...rest) => inTurn(name, (h) => h.format(name, ...rest)),
    restore: (name, ...rest) => inTurn(name, (h) => h.restore(name, ...rest)),
    accept: (name, ...rest) => inTurn(name, (h) => h.accept(name, ...rest)),
    reject: (name, ...rest) => inTurn(name, (h) => h.reject(name, ...rest))
  }
}
