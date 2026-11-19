import { diffWords } from 'work-kit/formats/diff'
import type { EditOp } from '@shared/contract-work-rules'

/**
 * What the owner did to a draft before he sent it, read as habits
 * (docs/agents/work-rules.md "Proposals"). Each habit has a key: the same
 * key in two sent drafts of one workspace is a proposal. The reading is
 * plain and deterministic on purpose: a proposal names only what his edits
 * show, and he rewords it before it becomes a rule if the words are wrong.
 */

export interface Habit {
  /** the same key in two drafts is the same habit */
  key: string
  /** the rule it would be */
  rule: string
  /** what he did, as the line under the sent mail says it */
  line: string
  /**
   * Where a phrase cut or swapped sat in the draft. A proposal for the
   * greeting (`opening`) or the closing is not offered while a phrase
   * proposal there holds every one of its edits, and `shorter` not while a
   * cut does (store.ts `covers`).
   */
  region?: 'opening' | 'closing' | 'body'
}

/** A phrase cut or swapped counts up to this many words. */
const PHRASE_WORDS = 12
/** A region counts as cut when this many of its words went. */
const REGION_WORDS = 5
/** The opening and the closing are at most this many words of their paragraph. */
const REGION_SPAN = 40
/** A last paragraph this short is the sign-off. */
const SIGNOFF_WORDS = 6
const QUOTE_MAX = 80

const words = (text: string): number => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’:.,-]*/gu) ?? []).length
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()
/** A phrase's key: case, spacing, edge punctuation and the digits themselves do not matter ("4:00 PM" and "3:00 PM" are one habit). */
const keyOf = (text: string): string =>
  squash(text)
    .toLowerCase()
    .replace(/^[\s.,;:!?'"“”‘’()-]+|[\s.,;:!?'"“”‘’()-]+$/g, '')
    .replace(/\d/g, '#')
const quote = (text: string): string => {
  const s = squash(text).replace(/^[\s,;:'"“”‘’()-]+|[\s.,;:!?'"“”‘’()-]+$/g, '')
  return s.length > QUOTE_MAX ? `${s.slice(0, QUOTE_MAX - 1).trimEnd()}…` : s
}

/** Paragraphs of a mail's text with their character ranges. */
function paragraphs(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = []
  const re = /\S[\s\S]*?(?=\n\s*\n|\s*$)/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
    if (m[0].length === 0) re.lastIndex++
  }
  return out
}

/** Where the first `n` words of a span end. */
function afterWords(text: string, start: number, end: number, n: number): number {
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’:.,-]*/gu
  re.lastIndex = start
  let seen = 0
  for (let m = re.exec(text); m && m.index < end; m = re.exec(text)) if (++seen === n) return m.index + m[0].length
  return end
}

/** Where the last `n` words of a span start. */
function beforeWords(text: string, start: number, end: number, n: number): number {
  const all = [...text.slice(start, end).matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’:.,-]*/gu)]
  return all.length <= n ? start : start + all[all.length - n]!.index!
}

interface Regions {
  opening: [number, number]
  closing: [number, number]
  /** the sign-off paragraph, or null */
  signoff: [number, number] | null
}

function regionsOf(text: string): Regions {
  const paras = paragraphs(text)
  if (paras.length === 0) return { opening: [0, 0], closing: [0, 0], signoff: null }
  const last = paras.at(-1)!
  // A short last paragraph that ends no sentence ("Best,\nLandon", "Thanks!") is the sign-off; "See you then." is body.
  const sign = paras.length > 1 && words(last.text) <= SIGNOFF_WORDS && !/[.?]\s*$/.test(last.text) ? last : null
  const body = sign ? paras.slice(0, -1) : paras
  const first = body[0]!
  const end = body.at(-1)!
  const opening: [number, number] = [first.start, afterWords(text, first.start, first.end, REGION_SPAN)]
  // A one-paragraph mail has no closing of its own apart from its opening.
  const closing: [number, number] = body.length > 1 ? [beforeWords(text, end.start, end.end, REGION_SPAN), end.end] : [end.end, end.end]
  return { opening, closing, signoff: sign ? [sign.start, sign.end] : null }
}

const inside = (at: number, [a, b]: [number, number]): boolean => at >= a && at < b
/** Whether a change reaches into a range: what it cuts overlaps it, or what it puts in lands in it or at its end. */
const touches = (c: { at: number; cut: string }, [a, b]: [number, number]): boolean => (c.cut ? c.at < b && c.at + c.cut.length > a : c.at >= a && c.at <= b)

interface Change {
  /** where it starts in the draft */
  at: number
  cut: string
  put: string
}

/** The changes of a diff, each a cut, an insert or a swap, with its place in the draft. */
function changesOf(ops: readonly EditOp[]): Change[] {
  const out: Change[] = []
  let at = 0
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (op.op === '=') {
      at += op.text.length
      continue
    }
    if (op.op === '-') {
      const next = ops[i + 1]
      let put = next?.op === '+' ? next.text : ''
      let cut = op.text
      // A figure reads with the word after it: "3:00" to "3" is "3:00 PM" to "3 PM".
      const after = ops[i + (put ? 2 : 1)]
      const word = after?.op === '=' ? (after.text.match(/^\s*[\p{L}]+/u)?.[0] ?? '') : ''
      if (put && /\d/.test(cut) && !/\p{L}/u.test(cut) && !/\p{L}/u.test(put) && word) {
        cut += word
        put += word
      }
      out.push({ at, cut, put })
      at += op.text.length
      if (next?.op === '+') i++
      continue
    }
    out.push({ at, cut: '', put: op.text })
  }
  return out
}

/** The word diff of what the agent wrote against what he sent. */
export const editOps = (draft: string, sent: string): EditOp[] => diffWords(draft.replace(/\r\n/g, '\n'), sent.replace(/\r\n/g, '\n'))

/** The habits one edit shows. An unchanged draft shows none. */
export function habitsOf(draft: string, sent: string): Habit[] {
  const a = draft.replace(/\r\n/g, '\n')
  const b = sent.replace(/\r\n/g, '\n')
  if (squash(a) === squash(b)) return []
  const ops = editOps(a, b)
  const changes = changesOf(ops)
  const where = regionsOf(a)
  const out = new Map<string, Habit>()
  const add = (h: Habit): void => void (out.has(h.key) || out.set(h.key, h))

  // The sign-off: what the last short paragraph became, or that one was put in or taken out.
  const signOf = (text: string, r: [number, number] | null): string => (r ? squash(text.slice(r[0], r[1])) : '')
  const was = signOf(a, where.signoff)
  const now = signOf(b, regionsOf(b).signoff)
  const signRange: [number, number] = where.signoff ?? [a.trimEnd().length, a.length]
  const inSign = (c: Change): boolean => touches(c, signRange)
  if (keyOf(was) !== keyOf(now) && changes.some(inSign)) {
    if (now) add({ key: `signoff:${keyOf(now)}`, rule: `Sign off with “${quote(now)}”`, line: `You changed the sign-off to “${quote(now)}” again.` })
    else add({ key: 'signoff:none', rule: 'Leave off the sign-off', line: 'You took the sign-off out again.' })
  }
  const regionOf = (at: number): Habit['region'] => (inside(at, where.opening) ? 'opening' : inside(at, where.closing) ? 'closing' : 'body')

  for (const c of changes) {
    if (inSign(c)) continue
    const cutWords = words(c.cut)
    const putWords = words(c.put)
    if (c.cut.trim() && c.put.trim()) {
      if (cutWords <= PHRASE_WORDS && putWords <= PHRASE_WORDS && keyOf(c.cut) && keyOf(c.put) && keyOf(c.cut) !== keyOf(c.put))
        add({
          key: `swap:${keyOf(c.cut)}→${keyOf(c.put)}`,
          rule: `Write “${quote(c.put)}”, not “${quote(c.cut)}”`,
          line: `You changed “${quote(c.cut)}” to “${quote(c.put)}” again.`,
          region: regionOf(c.at)
        })
    } else if (c.cut.trim()) {
      if (cutWords >= 1 && cutWords <= PHRASE_WORDS && keyOf(c.cut)) add({ key: `cut:${keyOf(c.cut)}`, rule: `Leave out “${quote(c.cut)}”`, line: `You took out “${quote(c.cut)}” again.`, region: regionOf(c.at) })
    }
  }

  // An exclamation mark made a full stop or a comma: the words before it are still there, ending otherwise. One cut with
  // its sentence is the sentence's habit, not this one. Read from the words, not the diff, which may join it to a change beside it.
  const bangs = [...a.slice(0, where.signoff?.[0] ?? a.length).matchAll(/([\p{L}\p{N}'’]+(?:[ \t]+[\p{L}\p{N}'’]+){0,2})!/gu)].map((m) => m[1]!)
  if (bangs.some((w) => !b.includes(`${w}!`) && (b.includes(`${w}.`) || b.includes(`${w},`)))) add({ key: 'exclaim', rule: 'No exclamation marks', line: 'You took out the exclamation marks again.' })

  const cutIn = (region: [number, number]): number => changes.filter((c) => !inSign(c) && inside(c.at, region)).reduce((n, c) => n + Math.max(0, words(c.cut) - words(c.put)), 0)
  if (cutIn(where.opening) >= REGION_WORDS) add({ key: 'opening', rule: 'Keep the greeting to one line', line: 'You cut the greeting to one line again.' })
  if (where.closing[1] > where.closing[0] && cutIn(where.closing) >= REGION_WORDS)
    add({ key: 'closing', rule: 'End on the point, with no closing pleasantry', line: 'You cut the closing pleasantry again.' })

  const before = words(a)
  const after = words(b)
  if (before >= 40 && after <= before * 0.6) {
    const about = Math.max(10, Math.ceil(after / 10) * 10)
    add({ key: 'shorter', rule: `Keep mail to about ${about} words`, line: `You cut the mail to about ${about} words again.` })
  }
  return [...out.values()]
}

/**
 * The diff as the evidence shows it: kept stretches longer than a few words
 * are cut to their ends around `…`, so a long mail shows its changes and not
 * its whole body.
 */
export function evidenceOps(ops: readonly EditOp[], keep = 8): EditOp[] {
  return ops.map((op, i) => {
    if (op.op !== '=') return op
    const parts = op.text.split(/(\s+)/)
    const count = parts.filter((p) => p.trim()).length
    const first = i === 0
    const last = i === ops.length - 1
    if (count <= keep * (first || last ? 1 : 2)) return op
    const take = (n: number, from: 'start' | 'end'): string => {
      const out: string[] = []
      let seen = 0
      const list = from === 'start' ? parts : [...parts].reverse()
      for (const p of list) {
        if (p.trim() && seen === n) break
        if (p.trim()) seen++
        out.push(p)
      }
      return (from === 'start' ? out : out.reverse()).join('')
    }
    if (first) return { op: '=', text: `…${take(keep, 'end').replace(/^\s+/, ' ')}` }
    if (last) return { op: '=', text: `${take(keep, 'start').replace(/\s+$/, ' ')}…` }
    return { op: '=', text: `${take(keep, 'start').replace(/\s+$/, '')} … ${take(keep, 'end').replace(/^\s+/, '')}` }
  })
}
