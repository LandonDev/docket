import { createHash } from 'node:crypto'
import { everyBlock, plain, type Block, type Inline } from 'work-kit/formats'
import type { DocParagraph } from './mapper'

/**
 * His edits to a Google Doc's mirror, as one Docs API `batchUpdate`
 * (docs/agents/work-google.md "Writing to Google"). The mirror is compared
 * with what was last read from Google (`DocBase`), block by block; each
 * changed paragraph is found again in the Doc as Google has it now, by the
 * words it had, and only the words that differ are deleted and inserted.
 * Whatever a write from here does not carry is named in `refused` and left
 * in the mirror, still counted as his: a paragraph whose words changed in
 * Google since (or stand twice, so it cannot be told apart), one holding a
 * chip, a footnote or a waiting suggestion, a change of formatting only, a
 * table, a picture, a new paragraph after something that is not a plain
 * paragraph.
 *
 * Requests go from the end of the Doc to its start, so each index stands as
 * it was read; at one index a deletion goes before an insertion, and new
 * paragraphs before the words of the paragraph they follow. Paragraphs
 * removed side by side go as one range.
 */

export interface BaseParagraph {
  text: string
  exact: boolean
  ordinal: number
  tabId: string
  /** the hash of its kind, props and marks, words left out */
  fmt: string
}

/** What the mirror held when it last matched Google: each paragraph's words, and a hash of every other block. */
export interface DocBase {
  paragraphs: Record<string, BaseParagraph>
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
const textOf = (b: Block): string => (Array.isArray(b.content) ? plain(b.content) : '')

/** JSON with its keys in order, so one block always hashes alike. */
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v ?? null)
const hash = (v: unknown): string => createHash('sha256').update(stable(v)).digest('hex').slice(0, 24)
export const blockHash = (b: Block): string => hash({ t: b.type, p: b.props, c: b.content ?? null })
const marks = (c: Inline[]): unknown[] => c.map((r) => (r.type === 'text' ? r.styles : r.type === 'link' ? { link: r.href, s: r.content.map((x) => x.styles) } : 'footnote'))
/** A text block's form apart from its words: kind, props and marks. */
export const fmtOf = (b: Block): string => hash({ t: b.type, p: b.props, m: Array.isArray(b.content) ? marks(b.content) : null })

/**
 * The base a fresh import gives: every paragraph as the mapper placed it. `served` is the mirror's
 * blocks as the Work service reads them back (the editor adds its default props); the hashes are
 * taken from those where a block is there, so an untouched block compares equal.
 */
export function baseOf(blocks: readonly Block[], paragraphs: readonly DocParagraph[], served: readonly Block[] | null = null): DocBase {
  const base: DocBase = { paragraphs: {}, others: {} }
  const back = new Map([...everyBlock(served ?? [])].map((b) => [b.id, b]))
  const placed = new Set(paragraphs.map((p) => p.blockId))
  const mine = new Map([...everyBlock(blocks)].map((b) => [b.id, b]))
  paragraphs.forEach((p, ordinal) => {
    const b = back.get(p.blockId) ?? mine.get(p.blockId)
    base.paragraphs[p.blockId] = { text: p.text, exact: p.exact, ordinal, tabId: p.tabId, fmt: b ? fmtOf(b) : '' }
  })
  for (const b of everyBlock(blocks)) if (!placed.has(b.id)) base.others[b.id] = blockHash(back.get(b.id) ?? b)
  return base
}

/**
 * The base after a write: the mirror's blocks matched, in order, to the Doc's paragraphs as Google
 * now has them, by their words. `kept` are the paragraphs the write refused: they keep their old
 * base, so they still count as his and are never taken for Google's.
 */
export function rebase(blocks: readonly Block[], paragraphs: readonly DocParagraph[], kept: Record<string, BaseParagraph> = {}): DocBase {
  const base: DocBase = { paragraphs: {}, others: {} }
  let j = 0
  for (const b of everyBlock(blocks)) {
    if (kept[b.id]) {
      base.paragraphs[b.id] = kept[b.id]
      continue
    }
    const text = textOf(b)
    const at = TEXT_TYPES.has(b.type) ? paragraphs.findIndex((p, k) => k >= j && p.text === text) : -1
    if (at < 0) {
      base.others[b.id] = blockHash(b)
      continue
    }
    const p = paragraphs[at]
    base.paragraphs[b.id] = { text: p.text, exact: p.exact, ordinal: at, tabId: p.tabId, fmt: fmtOf(b) }
    j = at + 1
  }
  return base
}

/** How many blocks differ from the base: his edits not yet in Google. */
export function unsentCount(base: DocBase, current: readonly Block[]): number {
  const blocks = [...everyBlock(current)]
  const seen = new Set(blocks.map((b) => b.id))
  let n = 0
  for (const b of blocks) {
    const p = base.paragraphs[b.id]
    if (p) {
      if (p.text !== textOf(b) || (p.fmt && p.fmt !== fmtOf(b))) n++
    } else if (!(b.id in base.others) || base.others[b.id] !== blockHash(b)) n++
  }
  for (const id of [...Object.keys(base.paragraphs), ...Object.keys(base.others)]) if (!seen.has(id)) n++
  return n
}

/** Keeps a cut from falling between the two halves of a surrogate pair. */
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff

export function planWrite(base: DocBase, current: readonly Block[], fresh: readonly DocParagraph[]): WritePlan {
  const plan: WritePlan = { requests: [], changed: 0, added: 0, removed: 0, refused: [] }
  const ops: { at: number; rank: number; requests: Record<string, unknown>[] }[] = []
  const used = new Set<number>()
  /** The paragraph in the Doc now that holds what the base held: by its words, nearest its old place; none on a tie. */
  const locate = (e: BaseParagraph): number | null => {
    const near = fresh.map((p, k) => (p.exact && p.text === e.text && p.tabId === e.tabId && !used.has(k) ? k : -1)).filter((k) => k >= 0)
    if (!near.length) return null
    const d = (k: number) => Math.abs(k - e.ordinal)
    const best = Math.min(...near.map(d))
    const at = near.filter((k) => d(k) === best)
    if (at.length > 1) return null
    used.add(at[0])
    return at[0]
  }
  const loc = (p: DocParagraph, index: number) => ({ index, ...(p.tabId ? { tabId: p.tabId } : {}) })
  const range = (p: DocParagraph, startIndex: number, endIndex: number) => ({ startIndex, endIndex, ...(p.tabId ? { tabId: p.tabId } : {}) })
  const segmentEnd = (p: DocParagraph) => Math.max(...fresh.filter((x) => x.tabId === p.tabId).map((x) => x.end))
  const changedInGoogle = 'its words changed in Google since it was read, or stand twice there'

  const blocks = [...everyBlock(current)]
  const present = new Set(blocks.map((b) => b.id))
  // What new blocks follow, as each block is walked: a placed paragraph, the Doc's start, or something they cannot be placed after.
  let anchor: DocParagraph | 'start' | 'lost' = 'start'
  let pending: Block[] = []
  const flush = () => {
    if (!pending.length) return
    const p = anchor === 'start' ? fresh[0] : anchor
    if (p === 'lost' || !p) {
      for (const b of pending) plan.refused.push({ blockId: b.id, why: 'it follows a table, a picture or a paragraph that changed in Google: add it there' })
      pending = []
      return
    }
    // After a paragraph: before its newline, "\nA\nB". Before the first: at its start, "A\nB\n".
    const after = anchor !== 'start'
    const at = after ? p.end - 1 : p.start
    const texts = pending.map((b) => docsText(textOf(b)))
    const text = after ? texts.map((t) => `\n${t}`).join('') : texts.map((t) => `${t}\n`).join('')
    const requests: Record<string, unknown>[] = [{ insertText: { text, location: loc(p, at) } }]
    let start = after ? at + 1 : at
    pending.forEach((b, i) => {
      const r = range(p, start, start + texts[i].length + 1)
      requests.push({ updateParagraphStyle: { range: r, paragraphStyle: { namedStyleType: styleOf(b) }, fields: 'namedStyleType' } })
      // A new paragraph takes the bullet of the one it splits from: it is written as a plain paragraph.
      requests.push({ deleteParagraphBullets: { range: r } })
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
        anchor = k !== null ? fresh[k] : 'lost'
        if (e.fmt && e.fmt !== fmtOf(b)) plan.refused.push({ blockId: b.id, why: 'a change of formatting is made in Google, not from here' })
        continue
      }
      anchor = 'lost'
      if (!e.exact) plan.refused.push({ blockId: b.id, why: 'it holds a chip, a footnote or a suggestion waiting in Google: change it there' })
      else if (k === null) plan.refused.push({ blockId: b.id, why: changedInGoogle })
      else {
        const p = fresh[k]
        anchor = p
        const was = e.text
        const next = docsText(now)
        let pre = 0
        while (pre < was.length && pre < next.length && was[pre] === next[pre]) pre++
        if (pre > 0 && isHigh(was.charCodeAt(pre - 1))) pre--
        let suf = 0
        while (suf < was.length - pre && suf < next.length - pre && was[was.length - 1 - suf] === next[next.length - 1 - suf]) suf++
        if (suf > 0 && isHigh(was.charCodeAt(was.length - suf - 1)) && was.length - suf - 1 >= pre) suf--
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
      anchor = 'lost'
      if (base.others[b.id] !== blockHash(b)) plan.refused.push({ blockId: b.id, why: `a ${b.type === 'table' ? 'table' : b.type === 'image' ? 'picture' : 'block like this'} is changed in Google, not from here` })
      continue
    }
    if (TEXT_TYPES.has(b.type)) pending.push(b)
    else plan.refused.push({ blockId: b.id, why: `a new ${b.type === 'table' ? 'table' : b.type === 'image' ? 'picture' : 'block of this kind'} is added in Google, not from here` })
  }
  flush()

  for (const id of Object.keys(base.others)) if (!present.has(id)) plan.refused.push({ blockId: id, why: 'a table or picture is removed in Google, not from here' })

  // Removed paragraphs, found in the Doc, then joined into runs that stand side by side.
  const gone: DocParagraph[] = []
  for (const [id, e] of Object.entries(base.paragraphs)) {
    if (present.has(id)) continue
    if (!e.exact) {
      plan.refused.push({ blockId: id, why: 'it holds a chip, a footnote or a suggestion waiting in Google: remove it there' })
      continue
    }
    const k = locate(e)
    // Gone here and changed in Google: his deletion would take someone else's words with it.
    if (k === null) plan.refused.push({ blockId: id, why: changedInGoogle })
    else gone.push(fresh[k])
  }
  gone.sort((a, b) => (a.tabId === b.tabId ? a.start - b.start : a.tabId < b.tabId ? -1 : 1))
  const runs: DocParagraph[][] = []
  for (const p of gone) {
    const last = runs[runs.length - 1]
    if (last && last[last.length - 1].tabId === p.tabId && last[last.length - 1].end === p.start) last.push(p)
    else runs.push([p])
  }
  for (const run of runs) {
    const first = run[0]
    const start = first.start
    const end = run[run.length - 1].end
    plan.removed += run.length
    if (end !== segmentEnd(first)) {
      ops.push({ at: start, rank: 0, requests: [{ deleteContentRange: { range: range(first, start, end) } }] })
      continue
    }
    // The last newline of a body cannot go: the one before the run goes with it, and the paragraph
    // that then ends on the last newline is given back its own style.
    const prev = fresh.find((x) => x.tabId === first.tabId && x.end === start)
    if (!prev) {
      if (end - 1 > start) ops.push({ at: start, rank: 0, requests: [{ deleteContentRange: { range: range(first, start, end - 1) } }] })
      continue
    }
    ops.push({
      at: start - 1,
      rank: 0,
      requests: [
        { deleteContentRange: { range: range(first, start - 1, end - 1) } },
        { updateParagraphStyle: { range: range(first, prev.start, start), paragraphStyle: { namedStyleType: prev.style }, fields: 'namedStyleType' } }
      ]
    })
  }

  ops.sort((a, b) => b.at - a.at || a.rank - b.rank)
  plan.requests = ops.flatMap((o) => o.requests)
  return plan
}

/** An agent's edits as one `batchUpdate`, made on his press: each `find` must stand once, inside one paragraph Google holds as plain words. */
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
