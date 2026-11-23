/**
 * Which meetings are the same meeting on another day (docs/agents/work-prep.md
 * "Last time"). LifeOS keeps one row per occurrence of a repeating event and
 * stores no series: its worker names an occurrence `<series>@<original start>`,
 * so the series is that uid with the stamp cut. Pure, so the page, the tools
 * and the tests read one rule.
 */

/** The worker's stamp of an occurrence's original start: `20261110T090000Z`, or `20261110` for an all-day one (lifeos apps/worker calendar/expand.ts `stamp`). */
const STAMP = /^\d{8}(T\d{6}Z)?$/

/**
 * The series an event belongs to, or null when it repeats nothing. Only the
 * last `@<stamp>` is cut and only in the worker's two shapes, so an iCal UID
 * that holds an `@` of its own (`abc@google.com`) is never taken for one.
 */
export function seriesOf(event: { uid?: string | null }): string | null {
  const uid = event.uid ?? ''
  const at = uid.lastIndexOf('@')
  if (at <= 0 || !STAMP.test(uid.slice(at + 1))) return null
  return uid.slice(0, at)
}

/** A title as two meetings share it: case, accents and punctuation aside. */
export const foldTitle = (title: string): string =>
  title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Letters and digits of any script: two names in Chinese are two names, not the same empty key.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** A person as two pages share them: their address, or their folded name when the page has none. */
export const personKey = (person: { address?: string | null; name?: string | null }): string => {
  const address = person.address?.trim().toLowerCase()
  return address ? address : `~${foldTitle(person.name ?? '')}`
}

export interface SeriesPage {
  eventId: string
  series: string | null
  title: string
  startsAt: number
  /** `personKey` of everyone on it when it was last written */
  peopleKeys: readonly string[]
}

/**
 * The page before this meeting's: the newest earlier page of the same
 * series; with no series, the newest earlier page with the same folded title
 * that shares a person. `earlier` is one workspace's pages.
 */
export function lastOf<P extends SeriesPage>(event: SeriesPage, earlier: readonly P[]): P | null {
  const before = earlier.filter((p) => p.eventId !== event.eventId && p.startsAt < event.startsAt).sort((a, b) => b.startsAt - a.startsAt)
  if (event.series) return before.find((p) => p.series === event.series) ?? null
  const title = foldTitle(event.title)
  if (!title || !event.peopleKeys.length) return null
  const mine = new Set(event.peopleKeys)
  return before.find((p) => !p.series && foldTitle(p.title) === title && p.peopleKeys.some((k) => mine.has(k))) ?? null
}

/** Words every meeting's title has: they say nothing about its subject. */
const MEETING_WORDS = new Set([
  'meeting', 'meet', 'sync', 'call', 'weekly', 'biweekly', 'monthly', 'daily', 'quarterly', 'review', 'check', 'checkin', 'in', 'catch', 'catchup', 'up',
  'standup', 'stand', '1', '1on1', 'one', 'on', 'touch', 'base', 'touchbase', 'chat', 'huddle', 'session', 'discussion', 'discuss', 'update', 'updates',
  'follow', 'followup', 'kickoff', 'kick', 'off', 'intro', 'zoom', 'teams', 'webex', 'hangout', 'the', 'a', 'an', 'and', 'with', 'for', 'of', 'to', 'at',
  're', 'fw', 'fwd', 'vs', 'w'
])

/**
 * The words of a title that name its subject, for a task search: "Weekly
 * budget review with Dana" gives "budget dana". Empty when nothing is left,
 * in which case no search runs.
 */
export function subjectWords(title: string): string {
  const words = foldTitle(title)
    .split(' ')
    .filter((w) => w.length > 1 && !MEETING_WORDS.has(w) && !/^\d+$/.test(w))
  return [...new Set(words)].slice(0, 6).join(' ')
}

/** A link that joins a call rather than opens a file. */
const JOIN = /(^|\.)(zoom\.us|zoomgov\.com|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com|gotomeeting\.com|whereby\.com)$/i
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/gi

export interface FoundLink {
  title: string
  url: string
}

/**
 * The links in an event's description and place, http and https only, each
 * once, in the order written. A meeting's join link is named "Join the call"; any
 * other is named by its last path word, or its site when it has none.
 */
export function linksIn(...texts: (string | null | undefined)[]): FoundLink[] {
  const found = new Map<string, FoundLink>()
  let joined = false
  for (const text of texts) {
    for (const raw of text?.match(URL_IN_TEXT) ?? []) {
      const trimmed = raw.replace(/[.,;:!?]+$/, '')
      let url: URL
      try {
        url = new URL(trimmed)
      } catch {
        continue
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      if (found.has(url.href)) continue
      if (JOIN.test(url.hostname)) {
        // One way in is enough: a description often repeats the call's link in three forms.
        if (joined) continue
        joined = true
        found.set(url.href, { title: 'Join the call', url: url.href })
        continue
      }
      const tail = url.pathname.split('/').filter(Boolean).pop()
      let name = ''
      try {
        name = tail ? decodeURIComponent(tail).replace(/[-_+]+/g, ' ').trim() : ''
      } catch {
        name = ''
      }
      // An id in the path's place (a Google document's) names nothing: the site does.
      const title = name && name.length <= 60 && !/^[A-Za-z0-9]{16,}$/.test(name.replace(/ /g, '')) && !/^(edit|view|preview)$/i.test(name) ? name : url.hostname.replace(/^www\./, '')
      found.set(url.href, { title, url: url.href })
    }
  }
  return [...found.values()].slice(0, 12)
}
