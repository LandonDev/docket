import type { ParsedAnswers } from './parse'

/**
 * The answers as last read, in this process's memory alone (docs/agents/work-msforms.md
 * "The data rule"): one entry a form, dropped 30 minutes after it was last shown or kept,
 * at the form's removal, and at restart (nothing here is written anywhere).
 */

export const ANSWERS_KEEP_MS = 30 * 60_000

export interface CachedAnswers {
  answers: ParsedAnswers
  /** when the rows were read from the workbook */
  at: number
  /** the last read could not finish: these are older rows */
  stale: boolean
  /** the workbook's Modified as that read saw it, so the next pull knows a move */
  modified: string | null
  shownAt: number
}

const entries = new Map<string, CachedAnswers>()
const keyOf = (workspaceId: string, formId: string): string => `${workspaceId}\u0000${formId}`

/** Drops every entry not shown or kept for `ANSWERS_KEEP_MS`. */
export function sweepAnswers(now = Date.now()): void {
  for (const [k, e] of entries) if (now - e.shownAt >= ANSWERS_KEEP_MS) entries.delete(k)
}

export function cachedAnswers(workspaceId: string, formId: string, now = Date.now()): CachedAnswers | null {
  sweepAnswers(now)
  return entries.get(keyOf(workspaceId, formId)) ?? null
}

/** The entry was shown to someone: its 30 minutes start again. */
export function shownAnswers(workspaceId: string, formId: string, now = Date.now()): void {
  const e = entries.get(keyOf(workspaceId, formId))
  if (e) e.shownAt = now
}

export function keepAnswers(workspaceId: string, formId: string, answers: ParsedAnswers, modified: string | null, now = Date.now()): CachedAnswers {
  const e: CachedAnswers = { answers, at: now, stale: false, modified, shownAt: now }
  entries.set(keyOf(workspaceId, formId), e)
  return e
}

export function markAnswersStale(workspaceId: string, formId: string): void {
  const e = entries.get(keyOf(workspaceId, formId))
  if (e) e.stale = true
}

export function forgetAnswers(workspaceId: string, formId: string): void {
  entries.delete(keyOf(workspaceId, formId))
}

export function forgetWorkspaceAnswers(workspaceId: string): void {
  for (const k of [...entries.keys()]) if (k.startsWith(`${workspaceId}\u0000`)) entries.delete(k)
}

/** Everything gone, as a restart leaves it. */
export function clearAnswers(): void {
  entries.clear()
}
