/**
 * The line a new thread is first named by: his own first words. A message may open with what it is about, a
 * chip's line (`About this file: Budget.xlsx ({"at":"file",…})`) and the words quoted under it; a thread started
 * beside a file was once named by that line, its ref and all. Such a message with no words of his is named by the
 * thing itself.
 */
const CHIP = /^About this [a-z ]{1,24}: (.+ \(.+\))$/

/** A chip line's label: what stands before its ref, which is JSON for a file and plain words for a LifeOS row. */
function labelOf(rest: string): string {
  const json = rest.indexOf(' ({')
  return rest.slice(0, json >= 0 ? json : rest.lastIndexOf(' (')).trim()
}

export function titleSeed(text: string): string {
  let about = ''
  for (const raw of text.trim().split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('>')) continue
    const chip = CHIP.exec(line)
    if (!chip) return line
    about ||= labelOf(chip[1]!)
  }
  return about
}
