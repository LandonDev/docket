/**
 * The words a replace changes, as a held change's summary says them (the list's second line, the transcript's held
 * line): the words both sides share at their start and end are cut, so "The Spring LAN comes to $4,180" → "The Spring
 * LAN comes to $4,320, with $140 more" reads `"$4,180" to "$4,320, with $140 more"`. A side left empty keeps the word
 * beside it, so an insertion or a removal still names where it falls. Each side is cut to `max` characters.
 */
export function changeWords(find: string, replace: string, max = 60): string {
  const a = find.split(/(\s+)/)
  const b = replace.split(/(\s+)/)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  // Back to a whole word: a cut never starts or ends on the space between two.
  if (start % 2 === 1) start--
  if (end % 2 === 1) end--
  let from = a.slice(start, a.length - end)
  let to = b.slice(start, b.length - end)
  // An insertion or removal names the word beside it, the one before when there is one.
  if (!from.join('').trim() || !to.join('').trim()) {
    if (start >= 2) {
      from = a.slice(start - 2, a.length - end)
      to = b.slice(start - 2, b.length - end)
    } else if (end >= 2) {
      from = a.slice(start, a.length - end + 2)
      to = b.slice(start, b.length - end + 2)
    }
  }
  // One word for one word says little alone ("7" to "6:30"): the shared word after it, else before, goes with it.
  const one = (t: string[]) => t.length === 1
  if (one(from) && one(to) && (end >= 2 || start >= 2)) {
    if (end >= 2) {
      from = a.slice(start, a.length - end + 2)
      to = b.slice(start, b.length - end + 2)
    } else {
      from = a.slice(start - 2, a.length - end)
      to = b.slice(start - 2, b.length - end)
    }
  }
  const cut = (s: string) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
  const words = (t: string[]) => t.join('').trim()
  const x = words(from)
  const y = words(to)
  // Words that differ only in spaces or in characters that cannot be seen show whole, with those escaped, so the
  // summary never reads "a" to "a".
  if (looksAlike(find, replace)) {
    // every space shown as "·" and every unseen character by its escape, then cut where they differ: the line is one
    // line, where runs of spaces would fold together
    const inner = (v: string) => visible(v).slice(1, -1).replace(/ /g, '\u00b7')
    const [p, q] = sides(inner(find), inner(replace), cut)
    return `"${p}" to "${q}"`
  }
  const [p, q] = x === y || !x || !y ? sides(find, replace, cut) : sides(x, y, cut)
  // a side with nothing to see reads by its escapes, never as empty quotes or a bare cut: judged on the whole side
  const seen = (v: string) => v.replace(/[\p{Cf}]/gu, '').trim() !== ''
  const say = (cutV: string, whole: string) => (seen(whole) ? `"${cutV}"` : visible(cutV))
  return `${say(p, x === y || !x || !y ? find : x)} to ${say(q, x === y || !x || !y ? replace : y)}`
}

/** Two sides cut to their limit; when their cuts would read the same, each is cut around where they first differ. */
function sides(x: string, y: string, cut: (s: string) => string): [string, string] {
  if (cut(x) !== cut(y)) return [cut(x), cut(y)]
  let at = 0
  while (at < x.length && at < y.length && x[at] === y[at]) at++
  const from = Math.max(0, at - 20)
  const around = (s: string) => cut(`${from > 0 ? '…' : ''}${s.slice(from)}`)
  return [around(x), around(y)]
}

/** Two texts that read alike on screen: the same once spaces are squeezed and invisible characters dropped. */
export const looksAlike = (a: string, b: string): boolean => {
  const seen = (s: string) => s.replace(/[\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim()
  return a !== b && seen(a) === seen(b)
}

/** A text in quotes with every character that cannot be seen, and every space but U+0020, written as its escape. */
export const visible = (v: string): string =>
  JSON.stringify(v).replace(/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Zs}]/gu, (c) => {
    if (c === ' ') return c
    const code = c.codePointAt(0)!
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`
  })

/** One side for a line: in quotes and cut, or by its escapes when nothing of it can be seen. */
export function quoted(v: string, max = 60): string {
  const cut = v.length > max ? `${v.slice(0, max - 1)}…` : v
  return v.replace(/[\p{Cf}]/gu, '').trim() ? `"${cut}"` : visible(cut)
}

/** "1 place", "3 places", "1 box", "2 boxes". */
export const counted = (n: number, unit: 'place' | 'box'): string => `${n} ${n === 1 ? unit : unit === 'box' ? 'boxes' : 'places'}`

/** A stale press's reason when words reach another number of places or boxes than he was shown, in his words. */
export const reachWords = (words: string, now: number, shown: number, unit: 'place' | 'box'): string =>
  `${quoted(words)} stands in ${counted(now, unit)} now, not the ${counted(shown, unit)} shown`

/** A stale press's reason when the words are gone, in his words: ""Q1" is no longer in the deck". */
export const goneWords = (words: string, from: string): string => `${quoted(words)} is no longer in ${from}`

/** A stale press's reason when the words stand elsewhere than he was shown: other slides, or other boxes. */
export const elsewhereWords = (words: string, what: 'slides' | 'boxes'): string => `${quoted(words)} stands in other ${what} now than the ones shown`
