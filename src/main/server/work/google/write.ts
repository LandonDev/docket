import { everyBlock, plain, type Block } from 'work-kit/formats'
import type { DocParagraph } from './mapper'

/**
 * His edits to a Google Doc's mirror, as one Docs API `batchUpdate`
 * (docs/agents/work-google.md "Writing to Google"). The mirror is compared
 * with what was last read from Google (`DocBase`), block by block; each
 * changed paragraph is found again in the Doc as Google has it now, by the
 * words it had, and only the words that differ are deleted and inserted.
 * A paragraph whose words changed in Google since is not touched: it is named
 * in `refused`, and so is anything a write from here does not carry (a
 * table, an image, a paragraph holding a chip or a waiting suggestion).
 *
 * Requests go from the end of the Doc to its start, so each index stands as
 * it was read; at one index a deletion goes before an insertion, and new
 * paragraphs before the words of the paragraph they follow.
 */

/** What the mirror held when it last matched Google: each paragraph's words, and a hash of every other block. */
export interface DocBase {
  paragraphs: Record<string, { text: string; exact: boolean; ordinal: number; tabId: string }>
  others: Record<string, string>
}

export interface WritePlan {
  requests: Record<string, unknown>[]
  changed: number
  added: number
  removed: number
  refused: { blockId: string; why: string }[]
}

const TEXT_TYPES = new Set(['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem'])
const STYLE: Record<number, string> = { 1: 'HEADING_1', 2: 'HEADING_2', 3: 'HEADING_3', 4: 'HEADING_4', 5: 'HEADING_5', 6: 'HEADING_6' }
const styleOf = (b: Block): string => (b.type === 'heading' ? (STYLE[Number(b.props.level)] ?? 'HEADING_1') : 'NORMAL_TEXT')
/** A line break inside a block is a soft break in Docs. */
const docsText = (s: string): string => s.replace(/\n/g, '\u000b')
export const blockHash = (b: Block): string => JSON.stringify({ t: b.type, p: b.props, c: b.content ?? null })
const textOf = (b: Block): string => (Array.isArray(b.content) ? plain(b.content) : '')

/** The base a fresh import gives: every paragraph as the mapper placed it. */
export function baseOf(blocks: readonly Block[], paragraphs: readonly DocParagraph[]): DocBase {
  const base: DocBase = { paragraphs: {}, others: {} }
  const placed = new Set(paragraphs.map((p) => p.blockId))
  paragraphs.forEach((p, ordinal) => (base.paragraphs[p.blockId] = { text: p.text, exact: p.exact, ordinal, tabId: p.tabId }))
  for (const b of everyBlock(blocks)) if (!placed.has(b.id)) base.others[b.id] = blockHash(b)
  return base
}

/**
 * The base after a write: the mirror's blocks matched, in order, to the Doc's paragraphs as Google
 * now has them, by their words. A block left unmatched keeps no place: it is counted as Google's,
 * never written again as new.
 */
export function rebase(blocks: readonly Block[], paragraphs: readonly DocParagraph[]): DocBase {
  const base: DocBase = { paragraphs: {}, others: {} }
  let j = 0
  for (const b of everyBlock(blocks)) {
    const text = textOf(b)
    const at = TEXT_TYPES.has(b.type) ? paragraphs.findIndex((p, k) => k >= j && p.text === text) : -1
    if (at < 0) {
      base.others[b.id] = blockHash(b)
      continue
    }
    const p = paragraphs[at]
    base.paragraphs[b.id] = { text: p.text, exact: p.exact, ordinal: at, tabId: p.tabId }
    j = at + 1
  }
  return base
}

export function planWrite(base: DocBase, current: readonly Block[], fresh: readonly DocParagraph[]): WritePlan {
  const plan: WritePlan = { requests: [], changed: 0, added: 0, removed: 0, refused: [] }
  const ops: { at: number; rank: number; requests: Record<string, unknown>[] }[] = []
  const used = new Set<number>()
  /** The paragraph in the Doc now that holds what the base held: by its words, nearest its old place. */
  const locate = (e: DocBase['paragraphs'][string]): number | null => {
    let best: number | null = null
    fresh.forEach((p, k) => {
      if (!p.exact || p.text !== e.text || p.tabId !== e.tabId || used.has(k)) return
      if (best === null || Math.abs(k - e.ordinal) < Math.abs(best - e.ordinal)) best = k
    })
    if (best !== null) used.add(best)
    return best
  }
  const loc = (p: DocParagraph, index: number) => ({ index, ...(p.tabId ? { tabId: p.tabId } : {}) })
  const range = (p: DocParagraph, startIndex: number, endIndex: number) => ({ startIndex, endIndex, ...(p.tabId ? { tabId: p.tabId } : {}) })
  const segmentEnd = (p: DocParagraph) => Math.max(...fresh.filter((x) => x.tabId === p.tabId).map((x) => x.end))

  const blocks = [...everyBlock(current)]
  const present = new Set(blocks.map((b) => b.id))
  // The paragraph new blocks follow, as each block is walked; null before the first.
  let anchor: DocParagraph | null = null
  let pending: Block[] = []
  const flush = () => {
    if (!pending.length) return
    const p = anchor ?? fresh.find((x) => x.exact) ?? fresh[0]
    if (!p) {
      for (const b of pending) plan.refused.push({ blockId: b.id, why: 'the Doc has no paragraph to add it after' })
      pending = []
      return
    }
    // After a paragraph: before its newline, "\nA\nB". Before the first: at its start, "A\nB\n".
    const at = anchor ? p.end - 1 : p.start
    const texts = pending.map((b) => docsText(textOf(b)))
    const text = anchor ? texts.map((t) => `\n${t}`).join('') : texts.map((t) => `${t}\n`).join('')
    const requests: Record<string, unknown>[] = [{ insertText: { text, location: loc(p, at) } }]
    let start = anchor ? at + 1 : at
    pending.forEach((b, i) => {
      requests.push({ updateParagraphStyle: { range: range(p, start, start + texts[i].length + 1), paragraphStyle: { namedStyleType: styleOf(b) }, fields: 'namedStyleType' } })
      start += texts[i].length + 1
    })
    ops.push({ at, rank: 1, requests })
    plan.added += pending.length
    pending = []
  }

  for (const b of blocks) {
    const e = base.paragraphs[b.id]
    if (e) {
      flush()
      const now = textOf(b)
      const k = locate(e)
      if (now === e.text) {
        if (k !== null) anchor = fresh[k]
        continue
      }
      if (!e.exact) plan.refused.push({ blockId: b.id, why: 'it holds a chip, a footnote or a suggestion waiting in Google: change it there' })
      else if (k === null) plan.refused.push({ blockId: b.id, why: 'its words changed in Google since it was read' })
      else {
        const p = fresh[k]
        anchor = p
        const was = e.text
        const next = docsText(now)
        let pre = 0
        while (pre < was.length && pre < next.length && was[pre] === next[pre]) pre++
        let suf = 0
        while (suf < was.length - pre && suf < next.length - pre && was[was.length - 1 - suf] === next[next.length - 1 - suf]) suf++
        const from = p.start + pre
        const to = p.start + was.length - suf
        if (to > from) ops.push({ at: from, rank: 0, requests: [{ deleteContentRange: { range: range(p, from, to) } }] })
        const mid = next.slice(pre, next.length - suf)
        if (mid) ops.push({ at: from, rank: 2, requests: [{ insertText: { text: mid, location: loc(p, from) } }] })
        plan.changed++
      }
      continue
    }
    if (b.id in base.others) {
      flush()
      if (base.others[b.id] !== blockHash(b)) plan.refused.push({ blockId: b.id, why: `a ${b.type === 'table' ? 'table' : b.type === 'image' ? 'picture' : 'block like this'} is changed in Google, not from here` })
      continue
    }
    if (TEXT_TYPES.has(b.type)) pending.push(b)
    else plan.refused.push({ blockId: b.id, why: `a new ${b.type === 'table' ? 'table' : b.type === 'image' ? 'picture' : 'block of this kind'} is added in Google, not from here` })
  }
  flush()

  for (const [id, e] of Object.entries(base.paragraphs)) {
    if (present.has(id)) continue
    if (!e.exact) {
      plan.refused.push({ blockId: id, why: 'it holds a chip, a footnote or a suggestion waiting in Google: remove it there' })
      continue
    }
    const k = locate(e)
    // Gone here and changed in Google: his deletion would take someone else's words with it.
    if (k === null) {
      plan.refused.push({ blockId: id, why: 'its words changed in Google since it was read' })
      continue
    }
    const p = fresh[k]
    // The last newline of a body cannot go: the newline before the paragraph goes with it instead.
    const last = p.end === segmentEnd(p)
    const [from, to] = last ? (p.start > 1 ? [p.start - 1, p.end - 1] : [p.start, p.end - 1]) : [p.start, p.end]
    if (to > from) ops.push({ at: from, rank: 0, requests: [{ deleteContentRange: { range: range(p, from, to) } }] })
    plan.removed++
  }

  ops.sort((a, b) => b.at - a.at || a.rank - b.rank)
  plan.requests = ops.flatMap((o) => o.requests)
  return plan
}

/** An agent's edits as Google suggestions: each `find` must stand once, inside one paragraph Google holds as plain words. */
export function planSuggest(fresh: readonly DocParagraph[], edits: readonly { find: string; replace: string }[]): { requests: Record<string, unknown>[] } | { error: string } {
  const ops: { at: number; rank: number; request: Record<string, unknown> }[] = []
  const taken: [number, number][] = []
  for (const e of edits) {
    if (!e.find) return { error: 'Each edit names the words it replaces in `find`.' }
    const hits: { p: DocParagraph; at: number }[] = []
    for (const p of fresh) {
      for (let i = p.text.indexOf(e.find); i >= 0; i = p.text.indexOf(e.find, i + 1)) hits.push({ p, at: i })
    }
    if (hits.length !== 1) return { error: hits.length ? `"${e.find}" stands ${hits.length} times: quote more words so it stands once.` : `"${e.find}" is not in the Doc as Google has it now.` }
    const { p, at } = hits[0]
    if (!p.exact) return { error: `"${e.find}" is in a paragraph holding a chip or a waiting suggestion: leave a comment instead.` }
    const from = p.start + at
    const to = from + e.find.length
    if (taken.some(([a, b]) => from < b && to > a)) return { error: `Two edits touch "${e.find}".` }
    taken.push([from, to])
    const tab = p.tabId ? { tabId: p.tabId } : {}
    ops.push({ at: from, rank: 0, request: { deleteContentRange: { range: { startIndex: from, endIndex: to, ...tab } } } })
    // After the struck words, as a person suggesting a replacement types it.
    if (e.replace) ops.push({ at: to, rank: 1, request: { insertText: { text: docsText(e.replace), location: { index: to, ...tab } } } })
  }
  ops.sort((a, b) => b.at - a.at || a.rank - b.rank)
  return { requests: ops.map((o) => o.request) }
}
