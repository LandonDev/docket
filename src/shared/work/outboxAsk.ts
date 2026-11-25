import type { ActKind } from './acts'
import { CHIP_NOUN } from './canvas'

/**
 * When a Work thread may ask for his press (docs/agents/work-outbox.md "A thread asks for his press"): the words of
 * one of his own recent messages in that thread must tell it to, in so many words, about exactly the items it lists.
 * Pure, and held to a table of cases (outboxAsk.test.ts). A refusal is in words an agent can act on. These rules only
 * keep a thread from raising cards he did not ask for: nothing goes without his press on the card.
 */

export type AskAction = 'send' | 'discard' | 'later'

/** One of his messages as the host read it: its seq, the server's time, and its text as sent. */
export interface OwnerMessage {
  seq: number
  at: number
  text: string
}

/** A waiting item the asking thread may name, as it stood at his message. */
export interface AskItem {
  /** the opaque ref the tool lists */
  ref: string
  /** this host's number, when it has one */
  n: number | null
  kind: ActKind
  /** what names it exactly: people, addresses, a channel, a file's name, a title */
  names: readonly string[]
  /** made in the asking thread's own tree */
  own: boolean
  /** when it was held: an item held after his message is not one he meant */
  heldAt: number
  /** a held chip's ref Ask puts in a message for it (`Work outbox <id>`) */
  chipId?: string
  /** a calendar act's own answer (`accept`, `decline`, `tentative`, `create`): "accept" never names a decline */
  op?: string
}

export interface AskedItem {
  ref: string
  do: AskAction
  at?: number
}

export interface AskInput {
  /** his words as the thread quotes them */
  quote: string
  /** his newest messages in this thread, newest first (at most three, each within a day) */
  messages: readonly OwnerMessage[]
  /** every waiting item in the thread's reach */
  items: readonly AskItem[]
  asked: readonly AskedItem[]
  /** his recorded IANA zone, for a time he names */
  zone: string
  /** how many of the asking tree's items, waiting at that time, were decided since: an "all" then covers no exact set */
  decidedSince?(at: number): number
}

export type AskVerdict = { ok: true; source: OwnerMessage; clause: string } | { ok: false; refusal: string }

export const NOT_HIS =
  "Refused: none of the owner's recent messages in this thread tells you to do this. Do not ask again until he writes it; tell him the items wait in his Outbox."
export const NOT_A_COMMAND = 'Refused: his words there do not tell you to do it (a question, a "don\'t", a quote or an "if"). Ask him in words; the items wait in his Outbox.'
export const TOO_SHORT = 'Refused: quote the whole clause of his that tells you, not a word or two.'
export const NO_TIME = 'Refused: for a later send his words must name a day and a time, and your time must be that one.'
export const VERB_MISSING = (action: AskAction): string =>
  `Refused: his words do not say to ${action === 'discard' ? 'discard' : action === 'later' ? 'send it later' : 'send'} it. Ask only for what he said.`
export const NOT_NAMED = (n: string): string => `Refused: his words do not name item ${n}. Ask only for what he named.`
export const COUNT_OFF = (said: number, listed: number): string => `Refused: his words say ${NUMBER_WORDS[said] ?? said}, and you listed ${listed}.`
export const NOT_ALL = (left: number): string => `Refused: his words say all of them, and you left out ${left}. List every one, or ask him which.`
export const UNCLEAR_COUNT = 'Refused: his words give two different counts. Ask him which.'
export const NOTHING_ASKED = 'Refused: list at least one item.'
export const SAYS_LATER = 'Refused: his words give a time. Ask for a later send at exactly that time, or ask him.'
export const DECIDED_SINCE = 'Refused: some of the items his words cover were decided since he wrote them. Ask him again in words.'
export const HELD_AFTER = (n: string): string => `Refused: item ${n} was held after he wrote those words, so they cannot mean it.`

const NUMBER_WORDS: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve' }
const COUNT_OF: Record<string, number> = Object.fromEntries(Object.entries(NUMBER_WORDS).map(([n, w]) => [w, Number(n)]))

const plain = (text: string): string =>
  text
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

const CHIP_HEAD = new RegExp(`^About this (${[...new Set(Object.values(CHIP_NOUN))].map((n) => n.replace(/ /g, '\\s')).join('|')}): `)

/**
 * His own words in a message, with every chip Ask put in it taken out (its head line and the `> ` lines under it are
 * a thing's words, not his), and the held items its held chips point at.
 */
export function ownWords(text: string): { words: string; held: string[] } {
  const kept: string[] = []
  const held: string[] = []
  let inChip = false
  for (const line of text.split('\n')) {
    if (CHIP_HEAD.test(line)) {
      inChip = true
      const ref = /\(Work outbox (\S+)\)$/.exec(line)
      if (line.startsWith('About this held act: ') && ref) held.push(ref[1]!)
      continue
    }
    // The chips sit together, a blank line from his words (chips.ts `withContextChips`): every line before that
    // blank line is a chip's, its quoted lines and any line its label ran onto.
    if (inChip && line.trim() !== '') continue
    inChip = false
    // A quoted block is someone else's words he pasted, never his command.
    if (/^\s*>/.test(line)) continue
    kept.push(line)
  }
  return { words: kept.join('\n'), held }
}

/** The sentences of his words: a quote must lie inside one. */
const sentences = (words: string): string[] =>
  words
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)

const has = (text: string, word: string): boolean => new RegExp(`(^|[^a-z0-9#])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(text)

const QUESTION_START = /^(should|shall|do|does|did|is|are|was|were|have|has|what|which|who|why|how|when|where|whether)\b/
const POLITE = /^(please\s+)?(can|could|would|will)\s+you\b/
const NEGATION = /\b(don't|dont|do not|never|no need|not|shouldn't|won't|hold off|wait on)\b/
const CONDITION = /\b(if|unless|once|after|when|until|in case)\b/

/** The verbs that tell each action, and the kinds each send verb can mean. */
const DISCARD_VERBS = ['discard', 'drop', 'delete', 'scrap', 'cancel', 'trash', 'throw away', 'get rid of']
const SEND_VERBS: Record<string, readonly ActKind[] | 'any'> = {
  send: 'any',
  approve: 'any',
  release: 'any',
  'go ahead': 'any',
  post: ['teams.post', 'chat.reply', 'frameio.post'],
  reply: ['mail.send', 'office.mail.send', 'chat.reply', 'teams.post'],
  forward: ['mail.send', 'office.mail.send'],
  accept: ['calendar.op', 'office.calendar.op'],
  decline: ['calendar.op', 'office.calendar.op'],
  invite: ['calendar.op', 'office.calendar.op'],
  share: ['share.guestLink', 'share.google'],
  publish: ['form.publish', 'msform.publish', 'msform.make'],
  submit: ['form.publish', 'portal.submit'],
  make: ['msform.make', 'share.guestLink']
}
const ALL_WORDS = ['all', 'every', 'everything', 'both', 'them', 'those', 'these', 'the rest']

/** A calendar verb names only the answer its act gives. */
const CALENDAR_OP: Record<string, readonly string[]> = { accept: ['accept'], decline: ['decline'], invite: ['create'] }

function tellsAction(clause: string, action: AskAction, kind: ActKind, op?: string): boolean {
  if (action === 'discard') return DISCARD_VERBS.some((v) => has(clause, v))
  return Object.entries(SEND_VERBS).some(([verb, kinds]) => has(clause, verb) && (kinds === 'any' || kinds.includes(kind)) && (!CALENDAR_OP[verb] || !op || CALENDAR_OP[verb]!.includes(op)))
}

/** The counts his clause gives ("the three replies", "all 10"); more than one distinct count is unclear. */
function countsIn(clause: string): number[] {
  const found = new Set<number>()
  for (const m of clause.matchAll(/(?<![#\d:])\b(\d{1,2})\b(?!\s*(?::|am\b|pm\b|a\.m\.|p\.m\.|o'clock))/g)) found.add(Number(m[1]))
  for (const [word, n] of Object.entries(COUNT_OF)) if (has(clause, word) && !new RegExp(`\\b${word}\\s*(am|pm|o'clock)\\b`).test(clause) && !(n === 1 && /\bone (by one|at a time)\b/.test(clause))) found.add(n)
  return [...found]
}

/** Words that put a send at a time: a day, a part of a day, a clock. */
function timeWords(clause: string): boolean {
  return ['today', 'tonight', 'tomorrow', 'this morning', 'this afternoon', 'this evening', 'noon', 'midnight', 'later', 'next week', ...WEEKDAYS].some((w) => has(clause, w)) || /\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.|o'clock)/.test(clause)
}

const FILLERS = /^(?:(?:please|ok|okay|yes|yeah|sure|now|then|and|so|just|alright|right|great|thanks|go ahead and|you can|feel free to|can you|could you|would you|will you)[\s,]+)*/

/** Whether his sentence starts with a command verb, after the words people put before one. */
function commandStart(clause: string): boolean {
  const rest = clause.replace(FILLERS, '')
  return [...Object.keys(SEND_VERBS), ...DISCARD_VERBS].some((verb) => rest.startsWith(`${verb} `) || rest === verb || rest.startsWith(`${verb},`))
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** The wall-clock parts of a moment in a zone. */
function partsIn(at: number, zone: string): { y: number; m: number; d: number; wd: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long' })
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]))
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), wd: WEEKDAYS.indexOf(String(p.weekday).toLowerCase()) }
}

/** The moment a wall-clock time in a zone names (the zone's offset found by asking it). */
function instantIn(y: number, m: number, d: number, h: number, min: number, zone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min)
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
  const read = (at: number): number => {
    const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]))
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute))
  }
  const first = guess - (read(guess) - guess)
  return first - (read(first) - guess)
}

/**
 * The time a later clause names, from his message's own time in his zone: a day (today, tonight, tomorrow, a
 * weekday) and a clock time with its half of the day ("8 am", "8:30pm", "noon"); null when either is missing or
 * the time could be morning or evening.
 */
export function laterTimeIn(clause: string, from: number, zone: string): number | null {
  const today = partsIn(from, zone)
  let addDays: number | null = null
  if (has(clause, 'tomorrow')) addDays = 1
  else if (has(clause, 'today') || has(clause, 'tonight') || has(clause, 'this afternoon') || has(clause, 'this evening') || has(clause, 'this morning')) addDays = 0
  else {
    const wd = WEEKDAYS.findIndex((w) => has(clause, w))
    if (wd >= 0) addDays = ((wd - today.wd + 7) % 7) || 7
  }
  if (addDays === null) return null
  let h: number
  let min = 0
  const all = [...clause.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/g)]
  // Two clock times, noon beside another, or midnight, are no one time.
  if (has(clause, 'midnight') || all.length + (has(clause, 'noon') ? 1 : 0) !== 1) return null
  if (has(clause, 'noon')) h = 12
  else {
    const t = all[0]!
    h = Number(t[1]) % 12 + (t[3]!.startsWith('p') ? 12 : 0)
    min = Number(t[2] ?? 0)
    if (Number(t[1]) > 12 || min > 59) return null
  }
  const base = new Date(Date.UTC(today.y, today.m - 1, today.d + addDays))
  const at = instantIn(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, min, zone)
  // A wall time the zone skips, or has twice, at a clock change is no one moment.
  const wall = (x: number): string => new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).format(x)
  const read = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).formatToParts(at)
  const hh = Number(read.find((p) => p.type === 'hour')?.value) % 24
  const mm = Number(read.find((p) => p.type === 'minute')?.value)
  if (hh !== h || mm !== min) return null
  if (wall(at - 3_600_000) === wall(at) || wall(at + 3_600_000) === wall(at)) return null
  return at
}

/** Whether his words ask for this, as rules 9 to 11 of the plan's contract read them. */
export function judgeAsk(input: AskInput): AskVerdict {
  if (!input.asked.length) return { ok: false, refusal: NOTHING_ASKED }
  const want = plain(input.quote)
  // His message that holds the quote, in his own words (chips out), inside one sentence.
  let source: OwnerMessage | null = null
  let clause = ''
  let heldChips: string[] = []
  for (const msg of input.messages) {
    const own = ownWords(msg.text)
    const hit = sentences(own.words).find((s) => want.length > 0 && plain(s).includes(want))
    if (hit) {
      source = msg
      clause = plain(hit)
      heldChips = own.held
      // A quote inside quotation marks in his message is someone else's words he passed on.
      const at = plain(own.words).indexOf(want)
      const before = plain(own.words).slice(0, at)
      if ((before.match(/"/g)?.length ?? 0) % 2 === 1) return { ok: false, refusal: NOT_A_COMMAND }
      break
    }
  }
  if (!source) return { ok: false, refusal: NOT_HIS }
  // A quote that takes in a quotation mark reaches into words he passed on.
  if (want.includes('"')) return { ok: false, refusal: NOT_A_COMMAND }
  const byRef = new Map(input.items.map((i) => [i.ref, i]))
  const tag = (i: AskItem): string => (i.n !== null ? String(i.n) : i.ref)
  const namesN = (i: AskItem): boolean => (i.n !== null && has(clause, `#${i.n}`)) || has(clause, plain(i.ref)) || (!!i.chipId && heldChips.includes(i.chipId))
  // A short clause tells only when it names its item exactly ("send #12").
  if (want.length < 12 && !input.asked.some((a) => byRef.get(a.ref) && namesN(byRef.get(a.ref)!))) return { ok: false, refusal: TOO_SHORT }
  if (clause.endsWith('?') && !POLITE.test(clause)) return { ok: false, refusal: NOT_A_COMMAND }
  // A command begins his sentence: "send …", "please discard …", "can you post …". A sentence that mentions a send
  // somewhere in it ("Dana plans to send them") tells nobody to do anything.
  if (!commandStart(clause)) return { ok: false, refusal: NOT_A_COMMAND }
  if (QUESTION_START.test(clause) || NEGATION.test(clause) || CONDITION.test(clause)) return { ok: false, refusal: NOT_A_COMMAND }
  const heldBy = source.at
  const all = ALL_WORDS.some((w) => has(clause, w))
  // A number inside a name ("Coach 2", "Room 5") is no count.
  const unnamed = input.items.flatMap((i) => i.names.map(plain)).filter((n) => n.length >= 3).sort((a, b) => b.length - a.length).reduce((text, name) => text.split(name).join(' '), clause)
  const counts = countsIn(unnamed)
  if (counts.length > 1) return { ok: false, refusal: UNCLEAR_COUNT }
  const byAction = new Map<AskAction, AskedItem[]>()
  for (const a of input.asked) byAction.set(a.do, [...(byAction.get(a.do) ?? []), a])
  for (const a of input.asked) {
    const item = byRef.get(a.ref)
    if (!item) return { ok: false, refusal: NOT_NAMED(a.ref) }
    if (!tellsAction(clause, a.do, item.kind, item.op)) return { ok: false, refusal: VERB_MISSING(a.do) }
    const timed = laterTimeIn(clause, source.at, input.zone)
    if (a.do === 'later' && (timed === null || a.at !== timed)) return { ok: false, refusal: NO_TIME }
    // Any time in his words, even one that reads as no single moment, makes it a later send: never a send now.
    if (a.do === 'send' && (timed !== null || timeWords(clause))) return { ok: false, refusal: SAYS_LATER }
    if (item.heldAt > heldBy) return { ok: false, refusal: HELD_AFTER(tag(item)) }
    // Named exactly, or one of the asking tree's own items an "all" word covers.
    const unique = item.names.some((name) => {
      const p = plain(name)
      return p.length >= 3 && has(clause, p) && input.items.filter((o) => o.names.some((n) => plain(n) === p)).length === 1
    })
    const named = namesN(item) || (item.own && unique)
    const covered = all && item.own && item.heldAt <= heldBy
    if (!named && !covered) return { ok: false, refusal: NOT_NAMED(tag(item)) }
  }
  // "All" means the whole of the asking tree's waiting set for that action, as it stood at his message: never a part.
  if (all && (input.decidedSince?.(heldBy) ?? 0) > 0) return { ok: false, refusal: DECIDED_SINCE }
  if (all)
    for (const [action, list] of byAction) {
      const set = input.items.filter((i) => i.own && i.heldAt <= heldBy && tellsAction(clause, action, i.kind, i.op))
      const left = set.filter((i) => !list.some((a) => a.ref === i.ref)).length
      if (left) return { ok: false, refusal: NOT_ALL(left) }
    }
  if (counts.length === 1 && counts[0] !== input.asked.length) return { ok: false, refusal: COUNT_OFF(counts[0]!, input.asked.length) }
  return { ok: true, source, clause }
}
