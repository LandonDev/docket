import type { WorkCtx } from '../modules'

/**
 * The digest's `ctx.tell`, as SEAMS.md "digest" gives it, held here until
 * the digest lands it on `WorkCtx` (src/shared/work/tell.ts). Until then a
 * host has no `tell`, and this pillar tells nothing and records nothing, so
 * every clash is told once the digest is there.
 */

export type TellOpen = { view: string; workspaceId: string; at?: string }
export interface TellNote {
  kind: string
  workspaceId: string | null
  title: string
  detail?: string
  open?: TellOpen
  by?: number
  key?: string
}
export interface Tell {
  (t: TellNote): void
  done?(key: string): void
}
export interface TellKind {
  kind: string
  group: 'clashes'
  name: string
}

/** The context's `tell`, when this build's frame has one. */
export const tellOf = (ctx: WorkCtx): Tell | null => {
  const tell = (ctx as unknown as { tell?: Tell }).tell
  return typeof tell === 'function' ? tell : null
}
