import { z } from 'zod'
import type { MeetingAction, MeetingNote } from '@shared/contract-work-meetings'
import type { DocSegment } from './merge'
import { matchQuote, quoteIndex, tokensOf, type QuoteIndex } from './quotes'
import type { StoredNotes } from './store'

/**
 * A meeting's notes as a writer hands them over, and the check they pass
 * before they are kept (docs/agents/work-meetings.md, "Notes"). Every line
 * must rest on the record: on turns that exist, or on a quote the
 * transcript holds. A line that rests on neither is dropped and the writer
 * is told why; a quote is replaced by the transcript's own words.
 */

const line = z.object({
  text: z.string().trim().min(1).max(600),
  /** the turns it rests on, by segment id (`s12`) */
  refs: z.array(z.string().max(16)).max(24).optional(),
  /** words from the transcript that say it, verbatim */
  quote: z.string().trim().min(1).max(1200).optional()
})
export const NotesInputSchema = z.object({
  summary: z.array(line).max(40).optional(),
  decisions: z.array(line).max(80).optional(),
  questions: z.array(line).max(80).optional(),
  actions: z
    .array(
      line.extend({
        /** `YYYY-MM-DD`, or a full ISO time */
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/, 'a date as YYYY-MM-DD or a full ISO time').optional(),
        /** a LifeOS task that already covers it: shown as filed, never proposed */
        lifeosTaskId: z.string().min(1).max(128).optional()
      })
    )
    .max(80)
    .optional()
})
export type NotesInput = z.infer<typeof NotesInputSchema>
type LineInput = z.infer<typeof line>

export interface CheckedNotes {
  notes: StoredNotes
  /** What was left out or changed, one sentence each, for the writer. */
  dropped: string[]
}

const clip = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}…` : s)
const same = (a: string, b: string): boolean => tokensOf(a).join(' ') === tokensOf(b).join(' ')

/** One line against the transcript: its refs that exist, its quote as the transcript has it, the moment to play. Null: it rests on nothing. */
function check(input: LineInput, id: string, what: string, segments: readonly DocSegment[], index: QuoteIndex, dropped: string[]): MeetingNote | null {
  const known = new Map(segments.map((s) => [s.id, s]))
  const refs = [...new Set(input.refs ?? [])].filter((ref) => {
    if (known.has(ref)) return true
    dropped.push(`${what} "${clip(input.text)}": there is no segment ${ref}.`)
    return false
  })
  const hit = input.quote ? matchQuote(input.quote, index, { near: refs }) : null
  if (input.quote && !hit) dropped.push(`${what} "${clip(input.text)}": the quote "${clip(input.quote)}" is not in the transcript, so it was left off.`)
  if (refs.length === 0 && !hit) {
    dropped.push(`${what} "${clip(input.text)}" was not kept: it names no segment and quotes nothing the transcript holds.`)
    return null
  }
  const rests = refs.length ? refs : hit!.segIds
  return { id, text: input.text, ...(hit ? { quote: hit.text } : {}), refs: rests, at: hit ? hit.start : (known.get(rests[0])?.start ?? null) }
}

/**
 * Checks a writer's notes against the transcript. `prior` is what the
 * meeting holds now: a task the owner already accepted or rejected keeps
 * his word when the same task is written again, and a filed task is never
 * lost by a rewrite.
 */
export function checkNotes(input: NotesInput, segments: readonly DocSegment[], prior: StoredNotes | null, now = Date.now()): CheckedNotes {
  const dropped: string[] = []
  const index = quoteIndex(segments)
  const lines = (list: LineInput[] | undefined, prefix: string, what: string): MeetingNote[] => (list ?? []).flatMap((l, i) => check(l, `${prefix}${i + 1}`, what, segments, index, dropped) ?? [])
  const actions: MeetingAction[] = []
  for (const [i, a] of (input.actions ?? []).entries()) {
    const note = check(a, `a${i + 1}`, 'The task', segments, index, dropped)
    if (!note) continue
    const was = prior?.actions.find((p) => same(p.text, a.text))
    const lifeosTaskId = was?.lifeosTaskId ?? a.lifeosTaskId
    actions.push({ ...note, ...(a.due ? { due: a.due } : {}), state: lifeosTaskId ? 'filed' : was?.state === 'rejected' ? 'rejected' : 'proposed', ...(lifeosTaskId ? { lifeosTaskId } : {}) })
  }
  // A task he filed stays on the record whatever the writer leaves out.
  for (const p of prior?.actions ?? []) {
    if (p.state === 'filed' && !actions.some((a) => a.lifeosTaskId === p.lifeosTaskId)) actions.push({ ...p, id: `a${actions.length + 1}` })
  }
  // Ids are unique after the carry-over.
  actions.forEach((a, i) => (a.id = `a${i + 1}`))
  return {
    notes: { summary: lines(input.summary, 'm', 'The summary line'), decisions: lines(input.decisions, 'd', 'The decision'), questions: lines(input.questions, 'q', 'The question'), actions, writtenAt: now },
    dropped
  }
}

/** The notes after an Undo: what was there before the last write, with every task filed since kept. */
export function undoneNotes(current: StoredNotes | null, before: StoredNotes | null, now = Date.now()): StoredNotes | null {
  const filed = (current?.actions ?? []).filter((a) => a.state === 'filed' && !before?.actions.some((b) => b.lifeosTaskId === a.lifeosTaskId))
  if (!before && filed.length === 0) return null
  const actions = [...(before?.actions ?? []), ...filed].map((a, i) => ({ ...a, id: `a${i + 1}` }))
  return { summary: before?.summary ?? [], decisions: before?.decisions ?? [], questions: before?.questions ?? [], actions, writtenAt: before?.writtenAt ?? now }
}
