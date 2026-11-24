import type { ChipKind, ContextChip } from './canvas'
import type { SectorKey } from './ids'

/**
 * What the composer's `@` offers beside files and threads (docs/agents/work-canvas.md
 * "Mentions"): anything a thread may use as context, found by the host in
 * what the thread's scope may read, and put in the message as a chip.
 */

/**
 * What one thread may be offered. A Work thread: its workspace's sector, its
 * workspace's items, acts and routines (a Work Chat: every sector, its own
 * pane's items and the acts outside every workspace). A code thread in a
 * workspace linked to a sector: that sector's LifeOS things and nothing of
 * Work's own. Any other thread is offered nothing (no reach at all).
 */
export interface MentionReach {
  /** a Work thread; false: a code thread of a linked workspace, offered LifeOS kinds only */
  work: boolean
  /** null: a Work Chat */
  workspaceId: string | null
  /** the sectors its LifeOS things may come from */
  sectors: 'all' | readonly SectorKey[]
  /** the thread, once it exists (a draft has none yet) */
  sessionId: string | null
}

/** One thing `@` can put in the message: the chip it becomes, and a muted line for its row. */
export interface MentionHit {
  chip: ContextChip
  /** the row's muted fact: a sender, a place, the canvas kind */
  detail?: string
  /** the row's time (a due date, the last message, an event's start), which the row words itself */
  at?: number
}

/** What `work.canvas.mentions` answers: hits in kind order, and the kinds that could not be searched (LifeOS unreachable). */
export interface MentionAnswer {
  hits: MentionHit[]
  failed: ChipKind[]
}

/** The order the kinds' groups read in; a kind not named here follows them. */
export const MENTION_ORDER: readonly ChipKind[] = ['task', 'mail', 'event', 'project', 'card', 'person', 'doc', 'file', 'item', 'held', 'routine']

/** A kind gives at most this many rows: the list is a few of each, not an index. */
export const MENTION_PER_KIND = 5
/** The excerpt a hit carries, cut to a few lines' worth of words. */
export const MENTION_EXCERPT = 280

/** Whether every word typed is in one of the fields, case and accents aside. Nothing typed matches everything. */
export function mentionMatches(text: string, ...fields: readonly (string | null | undefined)[]): boolean {
  const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const words = fold(text).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = fold(fields.filter(Boolean).join(' '))
  return words.every((word) => hay.includes(word))
}

/** A few words of a longer text, on one line, for a chip's excerpt. */
export function mentionExcerpt(text: string | null | undefined, max = MENTION_EXCERPT): string | undefined {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/**
 * Where the words typed stand in a text, case and accents aside (as `mentionMatches` reads them): the first place
 * of each word, as `[start, end)` in the text's own characters, in order and never overlapping. The text is
 * folded letter by letter, so a place in the folded text is the same place in the text shown.
 */
export function mentionRanges(text: string, typed: string): [number, number][] {
  const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const starts: number[] = []
  let hay = ''
  for (let i = 0; i < text.length; i++) {
    const folded = fold(text[i]!)
    for (let j = 0; j < folded.length; j++) starts.push(i)
    hay += folded
  }
  const out: [number, number][] = []
  for (const word of fold(typed).split(/\s+/).filter(Boolean)) {
    const at = hay.indexOf(word)
    if (at >= 0) out.push([starts[at]!, starts[at + word.length - 1]! + 1])
  }
  out.sort((a, b) => a[0] - b[0])
  return out.filter((range, i) => i === 0 || range[0] >= out[i - 1]![1])
}

/**
 * The excerpt of a text found by words typed: cut round the first of them it holds, so the line shows why the
 * thing was found. A match the plain excerpt already shows, or no match, gives the plain excerpt (the start).
 */
export function mentionExcerptAt(text: string | null | undefined, typed: string, max = MENTION_EXCERPT): string | undefined {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat || undefined
  const found = mentionRanges(flat, typed)[0]
  if (!found || found[1] <= max - 1) return mentionExcerpt(flat, max)
  // A third of the line before the word, begun at a word's start where one is near; the rest after it.
  let from = Math.max(0, found[0] - Math.floor(max / 3))
  const space = flat.indexOf(' ', from)
  if (space >= 0 && space < found[0]) from = space + 1
  const body = flat.slice(from, from + max - 2)
  return `…${body.trimEnd()}${from + body.length < flat.length ? '…' : ''}`
}
