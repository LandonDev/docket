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
  const cut = (s: string) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
  const words = (t: string[]) => t.join('').trim()
  const x = words(from)
  const y = words(to)
  // Words that differ only in their spaces show whole, so the summary never reads "a" to "a".
  if (x === y || !x || !y) return `"${cut(find)}" to "${cut(replace)}"`
  return `"${cut(x)}" to "${cut(y)}"`
}
