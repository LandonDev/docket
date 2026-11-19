import { useEffect, useState } from 'react'
import type { WorkMentionResult, WorkMentionRow } from '../work/canvas/mentions'
import { workCanvasChunk } from '../surfaces/chunks'

/**
 * The Work half of the composer's `@` (docs/agents/work-canvas.md
 * "Mentions"): while the list is open on a host with Work on, the text is
 * asked a beat after the last key through the work-canvas chunk, which
 * decides whether the thread may mention Work's things at all and words the
 * rows. The last answer stays, cut to what still matches, until the next.
 */
export const WORK_MENTION_WAIT_MS = 120

export interface WorkMentions {
  rows: readonly WorkMentionRow[]
  /** a Work thread: its Work rows lead the list */
  lead: boolean
  /** one muted row: Loading… before the first answer, or what could not be searched */
  note: string | undefined
  /** the text the rows answer */
  answered: string | null
}

const NONE: WorkMentions = { rows: [], lead: false, note: undefined, answered: null }

export function useWorkMentions(open: boolean, query: string, env: string, sessionId: string | undefined, workOn: boolean): WorkMentions {
  const active = open && workOn && !!sessionId
  const [answer, setAnswer] = useState<{ key: string; query: string; result: WorkMentionResult | null } | null>(null)
  const key = `${env}:${sessionId}`
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const timer = setTimeout(
      () =>
        void workCanvasChunk
          .load()
          .then((m) => m.askWorkMentions(env, sessionId!, query))
          .then((result) => !cancelled && setAnswer({ key, query, result })),
      // The first ask goes at once; the rest wait for a pause in the typing.
      answer?.key === key ? WORK_MENTION_WAIT_MS : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `answer` only picks the wait; a new answer must not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, env, key, query, sessionId])
  if (!active) return NONE
  const mine = answer?.key === key ? answer : null
  if (!mine) return { ...NONE, note: 'Loading…' }
  if (!mine.result) return NONE
  const rows = mine.query === query ? mine.result.rows : (workCanvasChunk.loaded()?.rowsStillMatching(mine.result.rows, query) ?? [])
  return { rows, lead: mine.result.lead, note: mine.result.failed ?? undefined, answered: mine.query }
}
