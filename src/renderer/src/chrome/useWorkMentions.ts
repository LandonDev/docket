import { useEffect, useRef, useState } from 'react'
import type { MentionDraft, WorkMentionResult } from '../work/canvas/mentions'
import { workCanvasChunk } from '../surfaces/chunks'

/**
 * The Work half of the composer's `@` (docs/agents/work-canvas.md
 * "Mentions"): while the list is open in a thread that may mention Work
 * things, the text typed is asked of the thread's host a beat after the
 * last key, through the work-canvas chunk (loaded here, the first time).
 * The last answer stays on screen until the next lands, so the list never
 * empties under the typing; `loading` is true only before the first one.
 */

/** A beat after the last key: one ask per pause, not per letter. */
export const WORK_MENTION_WAIT_MS = 120

export interface WorkMentions {
  result: WorkMentionResult | null
  loading: boolean
}

const NONE: WorkMentions = { result: null, loading: false }

export function useWorkMentions(o: { open: boolean; query: string; env: string; sessionId: string | undefined; draft: MentionDraft | undefined; enabled: boolean }): WorkMentions {
  const { open, query, env, sessionId, enabled } = o
  const active = open && enabled && !!sessionId
  const [answer, setAnswer] = useState<{ key: string; query: string; result: WorkMentionResult } | null>(null)
  const draftRef = useRef(o.draft)
  draftRef.current = o.draft
  const key = `${env}:${sessionId ?? ''}`
  useEffect(() => {
    if (!active || !sessionId) return
    let cancelled = false
    const ask = (): void => {
      workCanvasChunk
        .load()
        .then((m) => m.searchWorkMentions(env, sessionId, query, draftRef.current))
        .catch((): WorkMentionResult => ({ rows: [], failed: "Couldn't search Work" }))
        .then((result) => {
          if (!cancelled) setAnswer({ key, query, result })
        })
    }
    // The first ask goes at once; the rest wait for a pause in the typing.
    const timer = setTimeout(ask, answer?.key === key ? WORK_MENTION_WAIT_MS : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `answer` is read only to pick the wait; a new answer must not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, env, key, query, sessionId])
  if (!active) return NONE
  const mine = answer?.key === key ? answer : null
  return { result: mine?.result ?? null, loading: !mine }
}
