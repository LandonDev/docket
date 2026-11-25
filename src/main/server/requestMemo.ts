import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * What one request has already worked out about the disk, for the rest of that request alone: a path's real spelling
 * the fence resolved, asked again by the next check of the same request (docs/agents/work-files.md "The drive's list").
 * Never kept past the request: a link swapped between two requests is resolved anew by the next. Outside a request
 * (a timer, a test) nothing is kept.
 */
const memo = new AsyncLocalStorage<Map<string, unknown>>()

/** Runs one request with a memo of its own; inside one already, the same. */
export const withRequestMemo = <T>(fn: () => T): T => (memo.getStore() ? fn() : memo.run(new Map(), fn))

/** A value worked out ahead for this request (a path resolved off the loop): the request's own `inRequest` reads it. */
export function primeInRequest(key: string, value: unknown): void {
  memo.getStore()?.set(key, value)
}

/** `make`'s answer for `key`, once a request; a throw is thrown again each time, never kept. */
export function inRequest<T>(key: string, make: () => T): T {
  const m = memo.getStore()
  if (!m) return make()
  if (m.has(key)) return m.get(key) as T
  const value = make()
  m.set(key, value)
  return value
}
