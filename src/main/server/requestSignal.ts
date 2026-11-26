import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The abort signal of the bulk read being served, for a handler deep in the
 * call (search.ts) that can stop its work: the lane gate (lane.ts) aborts it
 * when every socket that asked cancelled the read (`request.cancel`).
 */
const scope = new AsyncLocalStorage<AbortSignal>()

export function withRequestSignal<T>(signal: AbortSignal, run: () => T): T {
  return scope.run(signal, run)
}

/** The signal of the request this code serves, or undefined outside the bulk lane. */
export function requestSignal(): AbortSignal | undefined {
  return scope.getStore()
}
