import type { TellGroup, TellLevel } from './tell'

/**
 * The digest's words, shared by the host's notices, the desktop and the
 * list (docs/agents/work-digest.md). Plain strings: no zod, so the first
 * paint may read it.
 */

/** What Settings and the list call each group. */
export const GROUP_NAMES: Record<TellGroup, string> = {
  held: 'Held items',
  ending: 'Sign-ins and licences',
  meetings: 'Meetings',
  clashes: 'Clashes',
  results: 'Routine results',
  people: 'Messages and mail',
  review: 'Weekly review',
  system: 'Work'
}

/** The three levels in his words, quietest first. */
export const LEVEL_NAMES: Record<TellLevel, string> = {
  digest: 'In the digest',
  clock: "When it can't wait",
  now: 'Right away'
}

/** Every group starts here. */
export const DEFAULT_LEVEL: TellLevel = 'clock'
export const DEFAULT_AT = '08:00'

const things = (n: number): string => `${n} ${n === 1 ? 'thing' : 'things'}`

/** "Cosmic, Purdue and Ref", in one order whoever counts; past three names, "4 jobs". */
export function jobsLine(jobs: readonly string[]): string {
  const names = [...new Set(jobs.filter(Boolean))].sort((a, b) => a.localeCompare(b))
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]!
  if (names.length > 3) return `${names.length} jobs`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The day's one notice: "Digest: 9 things in Cosmic, Purdue and Ref". */
export function digestLine(count: number, jobs: readonly string[]): string {
  const where = jobsLine(jobs)
  return `Digest: ${where ? `${things(count)} in ${where}` : things(count)}`
}

/** A title in a line of several is cut here, so one long title cannot crowd the others out. */
const NOW_TITLE_MAX = 60
const short = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

/**
 * Every open interrupt in one line, so a banner that replaced another still
 * says everything: the one title alone, else "2 things need you: Budget
 * review starts in 10 min; Sign-in to Frame.io ends today". Each title is
 * cut short before they are joined, and what still does not fit is counted
 * ("and 2 more"): no open thing is left out without a word.
 */
export function nowLine(titles: readonly string[], max = 200): string {
  if (titles.length <= 1) return titles[0] ?? ''
  const head = `${titles.length} things need you: `
  const said: string[] = []
  for (const [i, title] of titles.entries()) {
    const left = titles.length - i - 1
    const next = [...said, short(title, NOW_TITLE_MAX)].join('; ')
    // Room is kept for the count of what would be left out after this one.
    const tail = left > 0 ? `; and ${left} more` : ''
    if (said.length > 0 && head.length + next.length + tail.length > max) break
    said.push(short(title, NOW_TITLE_MAX))
  }
  const left = titles.length - said.length
  return short(`${head}${said.join('; ')}${left > 0 ? `; and ${left} more` : ''}`, max)
}

/** A sector key as a job's name where no workspace name is at hand: "purdue" reads "Purdue". */
export const sectorName = (sector: string): string => sector.charAt(0).toUpperCase() + sector.slice(1)
