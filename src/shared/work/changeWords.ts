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
  if (looksAlike(find, replace)) return `${visible(cut(find))} to ${visible(cut(replace))}`
  if (x === y || !x || !y) return pair(find, replace, cut)
  return pair(x, y, cut)
}

/** Two sides in quotes; when their cuts would read the same, each is cut around where they first differ instead. */
function pair(x: string, y: string, cut: (s: string) => string): string {
  if (cut(x) !== cut(y)) return `"${cut(x)}" to "${cut(y)}"`
  let at = 0
  while (at < x.length && at < y.length && x[at] === y[at]) at++
  const from = Math.max(0, at - 20)
  const around = (s: string) => cut(`${from > 0 ? '…' : ''}${s.slice(from)}`)
  return `"${around(x)}" to "${around(y)}"`
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
