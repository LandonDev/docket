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

/**
 * Every open interrupt in one line, so a banner that replaced another still
 * says everything: the one title alone, else "2 things need you: Budget
 * review starts in 10 min; Sign-in to Frame.io ends today".
 */
export function nowLine(titles: readonly string[], max = 200): string {
  if (titles.length <= 1) return titles[0] ?? ''
  const line = `${titles.length} things need you: ${titles.join('; ')}`
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A sector key as a job's name where no workspace name is at hand: "purdue" reads "Purdue". */
export const sectorName = (sector: string): string => sector.charAt(0).toUpperCase() + sector.slice(1)
