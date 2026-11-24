import { describe, expect, it } from 'vitest'
import {
  compareWeeks,
  countedSpan,
  dayWords,
  deskBlocks,
  hoursOf,
  hoursWords,
  isWeek,
  jobKey,
  LEAD_MS,
  localDay,
  LEFT,
  madeWords,
  mergeKept,
  mergeReview,
  nothingWords,
  peopleWords,
  shippedWords,
  slippedDetail,
  splitOlder,
  standsWords,
  stepWeek,
  totalWords,
  waitKey,
  weekNamed,
  weekOf,
  weekOfDay,
  weekWords,
  type HourFacts,
  type JobHours,
  type Point,
  type ReviewBody,
  type ReviewEvent,
  type SlippedRow
} from './review'

const TZ = 'America/Chicago'
const MIN = 60_000
const HOUR = 60 * MIN
const at = (iso: string): number => new Date(iso).getTime()

/** Monday Nov 16 2026, 00:00 in Chicago (UTC-6). */
const MON = at('2026-11-16T06:00:00Z')
const WEEK = { from: MON, to: MON + 7 * 24 * HOUR }

const facts = (over: Partial<HourFacts>): HourFacts => ({ jobs: ['cosmic', 'purdue'], span: WEEK, events: [], points: [], ran: [], ...over })
const point = (minutes: number, job = 'cosmic', kind: Point['kind'] = 'said'): Point => ({ at: MON + 10 * HOUR + minutes * MIN, job, kind })
const hours = (job: string, calendarMs: number, deskMs = 0): JobHours => ({ job, calendarMs, deskMs, ranMs: 0, events: 0, stands: { said: 0, sent: 0, pressed: 0, edited: 0 } })

describe('the week', () => {
  it('runs Monday to Sunday on the wall clock of its zone', () => {
    const w = weekOf(at('2026-11-19T20:00:00Z'), TZ)
    expect(w).toEqual(WEEK)
    expect(weekOf(WEEK.from, TZ)).toEqual(WEEK)
    expect(weekOf(WEEK.to - 1, TZ)).toEqual(WEEK)
    expect(weekOf(WEEK.to, TZ).from).toBe(WEEK.to)
    // Sunday evening in Chicago is already Monday in UTC: the zone decides.
    expect(weekOf(at('2026-11-23T03:00:00Z'), TZ)).toEqual(WEEK)
    expect(weekWords(w, TZ)).toBe('Week of Nov 16')
  })

  it('keeps midnight across a clock change, so a week is 167 or 169 hours', () => {
    // The clocks go back on Sunday Nov 1 2026 and forward on Sunday Mar 8 2026.
    const fall = weekOf(at('2026-10-28T12:00:00Z'), TZ)
    expect(fall.from).toBe(at('2026-10-26T05:00:00Z'))
    expect(fall.to).toBe(at('2026-11-02T06:00:00Z'))
    expect((fall.to - fall.from) / HOUR).toBe(169)
    const spring = weekOf(at('2026-03-04T12:00:00Z'), TZ)
    expect((spring.to - spring.from) / HOUR).toBe(167)
    expect(stepWeek(fall, 1, TZ)).toEqual({ from: fall.to, to: fall.to + 7 * 24 * HOUR })
    expect(stepWeek(stepWeek(fall, 1, TZ), -1, TZ)).toEqual(fall)
  })

  it('names a local day as Money does', () => {
    expect(localDay(WEEK.from, TZ)).toBe('2026-11-16')
    expect(localDay(WEEK.to - 1, TZ)).toBe('2026-11-22')
    expect(localDay(WEEK.to, TZ)).toBe('2026-11-23')
    // Sunday evening in Chicago is Monday in UTC: the zone decides.
    expect(localDay(at('2026-11-23T03:00:00Z'), TZ)).toBe('2026-11-22')
  })

  it('knows a whole week from any other span', () => {
    expect(isWeek(WEEK.from, WEEK.to, TZ)).toBe(true)
    expect(isWeek(WEEK.from + HOUR, WEEK.to, TZ)).toBe(false)
    expect(isWeek(WEEK.from, WEEK.to, 'UTC')).toBe(false)
  })
})

describe('desk time is an estimate from sittings', () => {
  it('one point is five minutes', () => {
    const [cosmic] = hoursOf(facts({ points: [point(0)] }))
    expect(cosmic!.deskMs).toBe(LEAD_MS)
    expect(cosmic!.stands.said).toBe(1)
  })

  it('two points 19 minutes apart are one sitting, 21 minutes apart are two', () => {
    expect(hoursOf(facts({ points: [point(0), point(19)] }))[0]!.deskMs).toBe(24 * MIN)
    expect(hoursOf(facts({ points: [point(0), point(21)] }))[0]!.deskMs).toBe(10 * MIN)
    expect(hoursOf(facts({ points: [point(0), point(20)] }))[0]!.deskMs).toBe(10 * MIN)
  })

  it('a gap goes to the job of its later point, across jobs', () => {
    const blocks = deskBlocks([point(0, 'cosmic'), point(10, 'purdue'), point(15, 'cosmic')])
    expect(blocks.map((b) => [b.job, (b.to - b.from) / MIN])).toEqual([
      ['cosmic', 5],
      ['purdue', 10],
      ['cosmic', 5]
    ])
    const [cosmic, purdue] = hoursOf(facts({ points: [point(0, 'cosmic'), point(10, 'purdue'), point(15, 'cosmic')] }))
    expect(cosmic!.deskMs).toBe(10 * MIN)
    expect(purdue!.deskMs).toBe(10 * MIN)
  })

  it('drops desk time under a counted calendar event, of any job', () => {
    const event = { job: 'purdue', from: MON + 10 * HOUR, to: MON + 11 * HOUR }
    const [cosmic, purdue] = hoursOf(facts({ events: [event], points: [point(-10), point(5), point(20), point(55), point(65)] }))
    // Before the event: the lead and ten minutes of the first gap. Inside it: nothing. After it: the five minutes past its end.
    expect(cosmic!.deskMs).toBe(5 * MIN + 10 * MIN + 5 * MIN)
    expect(purdue!.calendarMs).toBe(HOUR)
    expect(cosmic!.stands.said).toBe(5)
  })

  it('counts only what falls in the span, and cuts a lead that starts before it', () => {
    const early: Point = { at: WEEK.from + 2 * MIN, job: 'cosmic', kind: 'sent' }
    const outside: Point = { at: WEEK.to + HOUR, job: 'cosmic', kind: 'said' }
    const [cosmic] = hoursOf(facts({ points: [early, outside] }))
    expect(cosmic!.deskMs).toBe(2 * MIN)
    expect(cosmic!.stands).toEqual({ said: 0, sent: 1, pressed: 0, edited: 0 })
  })

  it('lists a job with nothing, and never adds the threads’ run time to his hours', () => {
    const rows = hoursOf(facts({ ran: [{ job: 'purdue', ms: 3 * HOUR }] }))
    expect(rows.map((r) => r.job)).toEqual(['cosmic', 'purdue'])
    expect(rows[1]).toMatchObject({ calendarMs: 0, deskMs: 0, ranMs: 3 * HOUR })
    expect(totalWords(rows[1]!)).toBeNull()
  })
})

describe('calendar time is measured', () => {
  const event = (over: Partial<ReviewEvent>): ReviewEvent => ({ id: 'e', sector: 'purdue', title: 'Budget review', startsAt: MON + 14 * HOUR, endsAt: MON + 15 * HOUR, allDay: false, declined: false, hidden: false, people: [], others: 0, addresses: [], ...over })

  it('counts overlapping events of one job once', () => {
    const a = { job: 'purdue', from: MON + 14 * HOUR, to: MON + 15 * HOUR }
    const b = { job: 'purdue', from: MON + 14.5 * HOUR, to: MON + 16 * HOUR }
    const [, purdue] = hoursOf(facts({ events: [a, b] }))
    expect(purdue!.calendarMs).toBe(2 * HOUR)
    expect(purdue!.events).toBe(2)
  })

  it('counts nothing for an event he declined, hid, that lasts all day or has no end', () => {
    expect(countedSpan(event({}))).toEqual({ from: MON + 14 * HOUR, to: MON + 15 * HOUR })
    expect(countedSpan(event({ declined: true }))).toBeNull()
    expect(countedSpan(event({ allDay: true }))).toBeNull()
    expect(countedSpan(event({ hidden: true }))).toBeNull()
    expect(countedSpan(event({ endsAt: null }))).toBeNull()
  })

  it('cuts an event to the week and, while the week runs, to now', () => {
    const now = MON + 14.5 * HOUR
    const over = { job: 'purdue', from: WEEK.from - HOUR, to: WEEK.from + HOUR }
    const running = { job: 'purdue', from: MON + 14 * HOUR, to: MON + 15 * HOUR }
    const later = { job: 'purdue', from: MON + 20 * HOUR, to: MON + 21 * HOUR }
    const [, purdue] = hoursOf(facts({ span: { from: WEEK.from, to: now }, events: [over, running, later] }))
    expect(purdue!.calendarMs).toBe(HOUR + 0.5 * HOUR)
  })
})

describe('the words for hours', () => {
  it('an estimate always says "about" and a measure never does', () => {
    expect(hoursWords(6.5 * HOUR, 'measured')).toBe('6 h 30 m')
    expect(hoursWords(6 * HOUR, 'measured')).toBe('6 h')
    expect(hoursWords(42 * MIN, 'measured')).toBe('42 m')
    expect(hoursWords(4.5 * HOUR + 4 * MIN, 'estimate')).toBe('about 4 h 30 m')
    expect(hoursWords(5 * MIN, 'estimate')).toBe('about 15 m')
    for (const ms of [1, 5 * MIN, HOUR, 13.3 * HOUR]) {
      expect(hoursWords(ms, 'estimate').startsWith('about ')).toBe(true)
      expect(hoursWords(ms, 'measured')).not.toContain('about')
    }
  })

  it('a total is an estimate as soon as any of it is', () => {
    expect(totalWords(hours('ref', 6.5 * HOUR))).toBe('6 h 30 m')
    expect(totalWords(hours('cosmic', 5.5 * HOUR, 11.5 * HOUR))).toBe('about 17 h')
    expect(totalWords(hours('life', 0, 2.75 * HOUR))).toBe('about 2 h 45 m')
    expect(totalWords(hours('unify', 0))).toBeNull()
  })

  it('says what the estimate stands on', () => {
    expect(standsWords({ said: 28, sent: 9, pressed: 0, edited: 4 })).toBe('28 messages, 9 mails sent, 4 document edits')
    expect(standsWords({ said: 1, sent: 1, pressed: 1, edited: 1 })).toBe('1 message, 1 mail sent, 1 held item decided, 1 document edit')
    expect(standsWords({ said: 0, sent: 0, pressed: 0, edited: 0 })).toBeNull()
  })
})

describe('the week before', () => {
  it('shows only where the hours moved by a quarter and by two hours', () => {
    const now = [hours('a', 6 * HOUR), hours('b', 10 * HOUR), hours('c', 20 * HOUR), hours('d', 3 * HOUR, HOUR)]
    const before = [hours('a', 7.5 * HOUR), hours('b', 13 * HOUR), hours('c', 23 * HOUR), hours('d', 9 * HOUR)]
    // a: moved 1.5 h (under two hours). b: 3 h and 23%  (under a quarter). c: 3 h of 23 (13%). d: 5 h of 9.
    expect(compareWeeks(now, before, false)).toEqual([{ job: 'd', words: 'down from 9 h' }])
    expect(compareWeeks([hours('e', 12 * HOUR)], [hours('e', 4 * HOUR, 2 * HOUR)], false)).toEqual([{ job: 'e', words: 'up from about 6 h' }])
  })

  it('names a job with two hours or more the week before and nothing now, in words that hold for any week shown', () => {
    expect(compareWeeks([hours('unify', 0)], [hours('unify', 0, 6 * HOUR)], false)).toEqual([{ job: 'unify', words: 'about 6 h the week before' }])
    expect(compareWeeks([hours('unify', 0)], [hours('unify', 1.5 * HOUR)], false)).toEqual([])
    expect(compareWeeks([hours('new', 5 * HOUR)], [hours('new', 0)], false)).toEqual([{ job: 'new', words: 'nothing the week before' }])
  })

  it('says a running week is compared with the same span', () => {
    expect(compareWeeks([hours('d', 3 * HOUR)], [hours('d', 9 * HOUR)], true)).toEqual([{ job: 'd', words: 'down from 9 h by this point last week' }])
    expect(compareWeeks([hours('u', 0)], [hours('u', 4 * HOUR)], true)).toEqual([{ job: 'u', words: '4 h by this point last week' }])
  })
})

const slip = (key: string, over: Partial<SlippedRow> = {}): SlippedRow => ({ key, ref: { kind: 'task', id: key, dueAt: MON + HOUR }, sector: 'purdue', workspaceId: null, title: key, at: MON + HOUR, people: [], others: 0, open: true, ...over })
const body = (over: Partial<ReviewBody> = {}): ReviewBody => ({
  host: 'box',
  from: WEEK.from,
  to: WEEK.to,
  tz: TZ,
  madeAt: WEEK.from + 4 * 24 * HOUR,
  by: 'owner',
  over: false,
  jobs: [],
  lifeos: null,
  points: [],
  ran: [],
  slipped: { at: WEEK.from + 4 * 24 * HOUR, rows: [] },
  shipped: [],
  before: null,
  left: [],
  ...over
})

describe('what is kept', () => {
  it('a week that is not over is made again: the fresh body stands', () => {
    const kept = body({ slipped: { at: WEEK.from + HOUR, rows: [slip('task:old')] } })
    const fresh = body({ madeAt: WEEK.from + 5 * 24 * HOUR, slipped: { at: WEEK.from + 5 * 24 * HOUR, rows: [slip('task:new')] } })
    expect(mergeKept(kept, fresh, WEEK.to - 1)).toEqual(fresh)
  })

  it('once over, what slipped stays as it stood at the last make inside the week; the rest is fresh', () => {
    const friday = WEEK.from + 4 * 24 * HOUR + 16 * HOUR
    const kept = body({ by: 'routine', madeAt: friday, slipped: { at: friday, rows: [slip('task:a'), slip('task:b')] }, ran: [[0, HOUR]] })
    const later = WEEK.to + 3 * 24 * HOUR
    const fresh = body({ over: true, madeAt: later, lifeos: { events: [], sent: [], done: [], answered: [], answeredSince: MON }, slipped: { at: later, rows: [slip('task:b'), slip('task:c')] }, ran: [[0, 2 * HOUR]] })
    const got = mergeKept(kept, fresh, later)
    expect(got.slipped.at).toBe(friday)
    // a was dealt with since; c slipped after the make and is not this week's news.
    expect(got.slipped.rows.map((r) => [r.key, r.open])).toEqual([
      ['task:a', false],
      ['task:b', true]
    ])
    expect(got.ran).toEqual([[0, 2 * HOUR]])
    expect(got.madeAt).toBe(later)
    expect(got.by).toBe('routine')
  })

  it('made again inside the week, a read that failed does not wipe the rows the last make knew', () => {
    const friday = WEEK.from + 4 * 24 * HOUR + 16 * HOUR
    const sunday = WEEK.to - 2 * HOUR
    const heldRow = slip('held:host:h1', { ref: { kind: 'held', ref: { at: 'host', id: 'h1' } } })
    const kept = body({ by: 'routine', madeAt: friday, slipped: { at: friday, rows: [slip('task:a'), slip('mail:t1', { ref: { kind: 'mail', threadId: 't1', since: MON } }), heldRow] } })
    // LifeOS is out on Sunday: the held item, which the host itself read, is fresh; the task and the mail ride along.
    const dark = body({ madeAt: sunday, slipped: { at: sunday, rows: [heldRow] }, left: [LEFT.lifeos] })
    const got = mergeKept(kept, dark, sunday)
    expect(got.slipped.at).toBe(sunday)
    expect(got.slipped.rows.map((r) => r.key)).toEqual(['held:host:h1', 'task:a', 'mail:t1'])
    // A whole read stands as it is: what it no longer lists is gone.
    const whole = body({ madeAt: sunday, lifeos: { events: [], sent: [], done: [], answered: [], answeredSince: MON }, slipped: { at: sunday, rows: [heldRow] } })
    expect(mergeKept(kept, whole, sunday)).toEqual(whole)
    // Only the source that failed is carried: with tasks unread, the mail's row is the fresh read's to say.
    const noTasks = body({ madeAt: sunday, lifeos: { events: [], sent: [], done: [], answered: [], answeredSince: MON }, slipped: { at: sunday, rows: [] }, left: [LEFT.tasks] })
    expect(mergeKept(kept, noTasks, sunday).slipped.rows.map((r) => r.key)).toEqual(['task:a'])
  })

  it('a kept row whose source did not answer this time keeps what was last known of it', () => {
    const friday = WEEK.from + 4 * 24 * HOUR + 16 * HOUR
    const later = WEEK.to + 3 * 24 * HOUR
    const heldRow = slip('held:host:h1', { ref: { kind: 'held', ref: { at: 'host', id: 'h1' } } })
    const mail = slip('mail:t1', { ref: { kind: 'mail', threadId: 't1', since: MON } })
    const meeting = slip('meeting:e1', { ref: { kind: 'meeting', eventId: 'e1' } })
    const lifeos = { events: [], sent: [], done: [], answered: [], answeredSince: MON }
    const kept = body({ by: 'routine', madeAt: friday, slipped: { at: friday, rows: [slip('task:a'), mail, meeting, heldRow] } })
    const open = (left: string[], over: Partial<ReviewBody> = {}): [string, boolean][] =>
      mergeKept(kept, body({ over: true, madeAt: later, lifeos, slipped: { at: later, rows: [] }, left, ...over }), later).slipped.rows.map((r) => [r.key, r.open])
    // Every source answered and lists none of them: all four were dealt with.
    expect(open([]).every(([, o]) => !o)).toBe(true)
    // A read that failed never makes a thing look dealt with.
    expect(open([LEFT.tasks]).filter(([, o]) => o).map(([k]) => k)).toEqual(['task:a'])
    expect(open([LEFT.mail]).filter(([, o]) => o).map(([k]) => k)).toEqual(['mail:t1', 'meeting:e1'])
    expect(open([LEFT.calendar]).filter(([, o]) => o).map(([k]) => k)).toEqual(['meeting:e1'])
    expect(open([LEFT.held]).filter(([, o]) => o).map(([k]) => k)).toEqual(['held:host:h1'])
    // LifeOS out: only the held item, which the host itself read, is known.
    expect(open([LEFT.lifeos], { lifeos: null }).filter(([, o]) => o).map(([k]) => k)).toEqual(['task:a', 'mail:t1', 'meeting:e1'])
  })

  it('a look back that reads less never lowers what Friday counted', () => {
    const friday = WEEK.from + 4 * 24 * HOUR + 16 * HOUR
    const later = WEEK.to + 30 * 24 * HOUR
    const jobs = [{ workspaceId: 'w-purdue', sector: 'purdue' as const, name: 'Purdue' }]
    const shippedRow = { key: 'held:host:h7', kind: 'approved' as const, sector: 'purdue' as const, workspaceId: 'w-purdue', title: 'Post the bracket', who: null, at: MON + 3 * HOUR, open: null }
    const sent = { id: 'm1', threadId: 't1', subject: 'Roster', to: [], addresses: [], at: MON + 5 * HOUR, sector: 'purdue' as const }
    const kept = body({
      by: 'routine',
      madeAt: friday,
      jobs,
      lifeos: { events: [], sent: [sent], done: [], answered: [], answeredSince: MON },
      points: [
        [MON + 3 * HOUR, 0, 'pressed'],
        [MON + 4 * HOUR, 0, 'edited']
      ],
      ran: [[0, 2 * HOUR]],
      shipped: [shippedRow],
      slipped: { at: friday, rows: [slip('held:host:h1', { ref: { kind: 'held', ref: { at: 'host', id: 'h1' } } })] }
    })
    // A month on: the Outbox's newest 500 no longer reach the week, a document was closed, a thread deleted. The jobs
    // come back in another order, and the read says what it could not read whole.
    const fresh = body({
      over: true,
      madeAt: later,
      jobs: [{ workspaceId: 'w-new', sector: 'cosmic', name: 'Cosmic' }, ...jobs],
      lifeos: { events: [], sent: [], done: [], answered: [], answeredSince: MON },
      points: [[MON + 4 * HOUR, 1, 'edited']],
      ran: [[1, HOUR]],
      slipped: { at: later, rows: [] },
      left: [LEFT.heldPart]
    })
    const got = mergeKept(kept, fresh, later)
    expect(got.points).toEqual([
      [MON + 3 * HOUR, 1, 'pressed'],
      [MON + 4 * HOUR, 1, 'edited']
    ])
    expect(got.ran).toEqual([[1, 2 * HOUR]])
    expect(got.shipped.map((r) => r.key)).toEqual(['held:host:h7'])
    expect(got.lifeos!.sent.map((m) => m.id)).toEqual(['m1'])
    // The held list was cut: its kept row is not called dealt with, and the line still says the read was partial.
    expect(got.slipped.rows.map((r) => [r.key, r.open])).toEqual([['held:host:h1', true]])
    expect(got.left).toEqual([LEFT.heldPart])
  })

  it('a kept calendar stands in for one that failed, cut to the moment it was read', () => {
    const friday = WEEK.from + 4 * 24 * HOUR + 16 * HOUR
    const event = (id: string, startsAt: number, endsAt: number) => ({ id, sector: 'purdue' as const, title: id, startsAt, endsAt, allDay: false, declined: false, hidden: false, people: [], others: 0, addresses: [] })
    const kept = body({ madeAt: friday, lifeos: { events: [event('thu', MON + 3 * 24 * HOUR, MON + 3 * 24 * HOUR + HOUR), event('fri', friday - HOUR, friday + HOUR), event('sat', friday + 20 * HOUR, friday + 22 * HOUR)], sent: [], done: [], answered: [], answeredSince: MON } })
    const fresh = body({ over: true, madeAt: WEEK.to + HOUR, lifeos: { events: [], sent: [], done: [], answered: [], answeredSince: MON }, left: [LEFT.calendar] })
    const events = mergeKept(kept, fresh, WEEK.to + HOUR).lifeos!.events
    expect(events.map((e) => [e.id, e.endsAt])).toEqual([
      ['thu', MON + 3 * 24 * HOUR + HOUR],
      ['fri', friday]
    ])
  })

  it('matches a kept waiting mail to its own wait alone, a week kept before waits had their own key too', () => {
    const friday = WEEK.from + 4 * 24 * HOUR + 16 * HOUR
    const later = WEEK.to + 3 * 24 * HOUR
    const lifeos = { events: [], sent: [], done: [], answered: [], answeredSince: MON }
    const ref = { kind: 'mail' as const, threadId: 't1', since: MON }
    const kept = body({ madeAt: friday, slipped: { at: friday, rows: [slip('mail:t1', { ref })] } })
    const still = slip(waitKey('t1', MON), { ref })
    const newer = slip(waitKey('t1', MON + 2 * 24 * HOUR), { ref: { ...ref, since: MON + 2 * 24 * HOUR } })
    const open = (rows: SlippedRow[]) => mergeKept(kept, body({ over: true, madeAt: later, lifeos, slipped: { at: later, rows } }), later).slipped.rows[0]!.open
    expect(open([still])).toBe(true)
    // He wrote again: the old wait was dealt with, whatever the newer one does.
    expect(open([newer])).toBe(false)
    expect(open([])).toBe(false)
    // A cut read of the waits says nothing of it.
    expect(mergeKept(kept, body({ over: true, madeAt: later, lifeos, slipped: { at: later, rows: [] }, left: [LEFT.mailPart] }), later).slipped.rows[0]!.open).toBe(true)
  })

  it('a week first asked for after it ended shows what is still open from it, as of now', () => {
    const later = WEEK.to + 3 * 24 * HOUR
    const fresh = body({ over: true, madeAt: later, slipped: { at: later, rows: [slip('task:b')] } })
    expect(mergeKept(null, fresh, later)).toBe(fresh)
    // A kept row that was itself first made after the week ended is no record of the week: it is read again.
    const kept = body({ over: true, slipped: { at: WEEK.to + HOUR, rows: [slip('task:a')] } })
    expect(mergeKept(kept, fresh, later).slipped).toEqual(fresh.slipped)
  })
})

describe('one review from every host’s part', () => {
  const lifeos = {
    events: [{ id: 'e1', sector: 'purdue', title: 'Budget review', startsAt: MON + 14 * HOUR, endsAt: MON + 15 * HOUR, allDay: false, declined: false, hidden: false, people: ['Dana Reyes'], others: 1, addresses: ['dana@example.edu'] }],
    sent: [{ id: 'm1', threadId: 't1', subject: 'Spring travel roster', to: ['Dana Reyes'], addresses: ['dana@example.edu'], at: MON + 16 * HOUR, sector: 'purdue' }],
    done: [{ id: 'k1', title: 'Order the new jerseys', at: MON + 17 * HOUR, sector: 'purdue' }],
    answered: [{ threadId: 't2', subject: 'Field trip forms', by: 'Dana Reyes', at: MON + 18 * HOUR, sector: 'purdue' }],
    answeredSince: MON - HOUR
  }
  const held = (id: string): SlippedRow => slip(`held:host:${id}`, { ref: { kind: 'held', ref: { at: 'host', id } }, workspaceId: 'w-purdue', title: 'Reply to the facilities office' })
  const box = body({
    host: 'box',
    jobs: [
      { workspaceId: 'w-purdue', sector: 'purdue', name: 'Purdue' },
      { workspaceId: 'w-side', sector: null, name: 'Side work' }
    ],
    lifeos,
    points: [
      [MON + 9 * HOUR, 0, 'said'],
      [MON + 9 * HOUR + 10 * MIN, 1, 'said']
    ],
    ran: [[0, HOUR]],
    slipped: { at: MON + 5 * 24 * HOUR, rows: [slip('task:k9'), held('h1')] }
  })
  const mac = body({
    host: 'mac',
    jobs: [{ workspaceId: 'm-purdue', sector: 'purdue', name: 'Purdue' }],
    lifeos,
    points: [[MON + 9 * HOUR + 5 * MIN, 0, 'edited']],
    ran: [[0, 30 * MIN]],
    slipped: { at: MON + 5 * 24 * HOUR, rows: [slip('task:k9'), held('h1')] },
    shipped: [{ key: 'held:host:h7', kind: 'approved', sector: 'purdue', workspaceId: 'm-purdue', title: 'Post the bracket to #esports', who: null, at: MON + 19 * HOUR, open: { at: 'held', ref: { at: 'host', id: 'h7' } } }]
  })
  const parts = [
    { environmentId: 'env-box', body: box },
    { environmentId: 'env-mac', body: mac }
  ]
  const now = WEEK.to + HOUR

  it('merges jobs by sector, keeps a workspace with none under its own name, and takes LifeOS once', () => {
    const r = mergeReview(parts, now)!
    expect(r.jobs.map((j) => [j.key, j.name, j.at.length])).toEqual([
      ['purdue', 'Purdue', 2],
      [jobKey('box', { workspaceId: 'w-side', sector: null }), 'Side work', 1]
    ])
    expect(r.lifeosFrom).toBe('env-box')
    const purdue = r.hours[0]!
    // One event, one mail, though both hosts carry LifeOS's facts.
    expect(purdue.calendarMs).toBe(HOUR)
    expect(purdue.events).toBe(1)
    expect(purdue.stands).toEqual({ said: 1, sent: 1, pressed: 0, edited: 1 })
    // Run time adds across hosts; points join into one sitting across hosts and jobs.
    expect(purdue.ranMs).toBe(1.5 * HOUR)
    expect(r.hours[1]!.deskMs).toBe(5 * MIN)
    expect(r.shipped.map((s) => s.key)).toEqual(['env-mac:held:host:h7', 'answered:t2:' + (MON + 18 * HOUR), 'done:k1', 'sent:m1'])
    expect(r.answersKept).toBe(true)
  })

  it('lists a LifeOS row once and a held row once per host that holds one', () => {
    const r = mergeReview(parts, now)!
    expect(r.slipped.map((s) => [s.key, s.environmentId]).sort()).toEqual([
      ['env-box:held:host:h1', 'env-box'],
      ['env-mac:held:host:h1', 'env-mac'],
      ['task:k9', 'env-box']
    ])
  })

  it('takes LifeOS from the home host when it has it, and from another when it does not', () => {
    expect(mergeReview(parts, now, { home: 'env-mac' })!.lifeosFrom).toBe('env-mac')
    const down = { environmentId: 'env-box', body: { ...box, lifeos: null, left: [LEFT.lifeos, LEFT.held] } }
    const r = mergeReview([down, parts[1]!], now, { home: 'env-box' })!
    expect(r.lifeosFrom).toBe('env-mac')
    // The box could not reach LifeOS but the Mac could: only what is still missing is said.
    expect(r.left).toEqual([LEFT.held])
    expect(r.hours[0]!.calendarMs).toBe(HOUR)
  })

  it('takes LifeOS from the host whose read failed least, and calls nothing empty on an answer from before', () => {
    // The box's calendar failed; the Mac read everything. The box is home.
    const half = { environmentId: 'env-box', body: { ...box, lifeos: { ...lifeos, events: [] }, left: [LEFT.calendar] } }
    const r = mergeReview([half, parts[1]!], now, { home: 'env-box' })!
    expect(r.lifeosFrom).toBe('env-mac')
    expect(r.hours[0]!.calendarMs).toBe(HOUR)
    expect(r.left).toEqual([])
    expect(r.known.calendar).toBe(true)
    // Only the box has LifeOS, from an answer before this one timed out: its empty calendar is not "nothing".
    const old = mergeReview([{ environmentId: 'env-box', body: { ...box, lifeos: { ...lifeos, events: [] } }, stale: true }, { environmentId: 'env-mac', body: { ...mac, lifeos: null, left: [LEFT.lifeos] } }], now, { home: 'env-box', fresh: false })!
    expect(old.lifeosFrom).toBe('env-box')
    expect(old.known.calendar).toBe(false)
  })

  it('files a held row by its own sector when its workspace is another job’s', () => {
    const cosmicJob = { workspaceId: 'w-cosmic', sector: 'cosmic' as const, name: 'Cosmic' }
    const moved = slip('held:host:h3', { ref: { kind: 'held', ref: { at: 'host', id: 'h3' } }, workspaceId: 'w-purdue', sector: 'cosmic', title: 'Post the patch notes' })
    const shippedMoved = { key: 'held:host:h4', kind: 'approved' as const, sector: 'cosmic' as const, workspaceId: 'w-purdue', title: 'Post the trailer', who: null, at: MON + HOUR, open: null }
    const r = mergeReview([{ environmentId: 'env-box', body: { ...box, jobs: [...box.jobs, cosmicJob], slipped: { at: MON, rows: [moved] }, shipped: [shippedMoved] } }], now)!
    expect(r.slipped.map((x) => [x.key, x.job])).toEqual([['env-box:held:host:h3', 'cosmic']])
    expect(r.shipped.filter((x) => x.kind === 'approved').map((x) => x.job)).toEqual(['cosmic'])
  })

  it('takes a meeting followed up in Prep on any host off what slipped', () => {
    const meeting = slip('meeting:e1', { ref: { kind: 'meeting', eventId: 'e1' } })
    const box2 = { ...box, slipped: { at: MON + 4 * 24 * HOUR, rows: [meeting] } }
    // The job's Prep page is on the Mac; the box's rows are the ones listed.
    const mac2 = { ...mac, prepped: ['e1'] }
    const running = mergeReview([{ environmentId: 'env-box', body: box2 }, { environmentId: 'env-mac', body: mac2 }], MON + 4 * 24 * HOUR, { home: 'env-box' })!
    expect(running.slipped.filter((x) => x.ref.kind === 'meeting')).toEqual([])
    const looked = mergeReview([{ environmentId: 'env-box', body: box2 }, { environmentId: 'env-mac', body: mac2 }], now, { home: 'env-box' })!
    expect(looked.slipped.filter((x) => x.ref.kind === 'meeting').map((x) => x.open)).toEqual([false])
  })

  it('stands with one host off, and with LifeOS answering nobody', () => {
    const alone = mergeReview([parts[1]!], now)!
    expect(alone.jobs.map((j) => j.key)).toEqual(['purdue'])
    expect(alone.hours[0]!.ranMs).toBe(30 * MIN)
    const dark = mergeReview([{ environmentId: 'env-mac', body: { ...mac, lifeos: null, left: [LEFT.lifeos] } }], now)!
    expect(dark.lifeosFrom).toBeNull()
    expect(dark.left).toEqual([LEFT.lifeos])
    expect(dark.hours[0]!.calendarMs).toBe(0)
    expect(mergeReview([], now)).toBeNull()
  })

  it('names a sector with something to show and no workspace, in the order asked for', () => {
    const extra = { ...lifeos, done: [...lifeos.done, { id: 'k2', title: 'Renew the domain', at: MON + HOUR, sector: 'unify' }] }
    const r = mergeReview([{ environmentId: 'env-box', body: { ...box, lifeos: extra } }], now, { names: (s) => s.toUpperCase(), order: ['unify', 'purdue'] })!
    expect(r.jobs.map((j) => [j.key, j.name])).toEqual([
      ['unify', 'UNIFY'],
      ['purdue', 'Purdue'],
      [jobKey('box', { workspaceId: 'w-side', sector: null }), 'Side work']
    ])
  })

  it('compares with the same span of the week before, from the same parts', () => {
    const before = {
      from: WEEK.from - 7 * 24 * HOUR,
      to: WEEK.to - 7 * 24 * HOUR,
      lifeos: { events: [{ sector: 'purdue', from: MON - 7 * 24 * HOUR + 9 * HOUR, to: MON - 7 * 24 * HOUR + 17 * HOUR }], sent: [] },
      points: []
    }
    const done = { ...box, over: true }
    const r = mergeReview([{ environmentId: 'env-box', body: { ...done, before } }], now)!
    expect(r.compare).toEqual([{ job: 'purdue', words: 'down from 8 h' }])
    // With anything unread, in either week, a comparison would describe the failure: none is drawn. Sent mail, held
    // decisions and document edits feed desk time as threads do, and a list read in part is unread past its cut.
    for (const left of [LEFT.threads, LEFT.calendar, LEFT.mail, LEFT.held, LEFT.files, LEFT.heldPart, LEFT.filesPart, LEFT.mailPart]) expect(mergeReview([{ environmentId: 'env-box', body: { ...done, before, left: [left] } }], now)!.compare).toEqual([])
    expect(mergeReview([{ environmentId: 'env-box', body: { ...done, before: { ...before, lifeos: null } } }], now)!.compare).toEqual([])
    // Nor on a host's answer from before. A host that is off is out of both weeks alike, so the comparison holds.
    expect(mergeReview([{ environmentId: 'env-box', body: { ...done, before } }], now, { fresh: false })!.compare).toEqual([])
    expect(mergeReview([{ environmentId: 'env-box', body: { ...done, before } }], now, { whole: false })!.compare).toHaveLength(1)
    // A part made while the week ran is compared as of its own read, though the clock has passed the week's end.
    expect(mergeReview([{ environmentId: 'env-box', body: { ...box, before } }], now)!.compare[0]!.words).toMatch(/by this point last week$/)
  })

  it('keeps a kept week\'s LifeOS rows as they last stood while LifeOS answers nobody', () => {
    const rows = [slip('task:k9'), slip('task:k8', { open: false }), held('h1')]
    const dark = (host: string, over: Partial<ReviewBody> = {}): ReviewBody => ({ ...box, host, lifeos: null, left: [LEFT.lifeos], slipped: { at: MON + 4 * 24 * HOUR, rows }, ...over })
    const r = mergeReview(
      [
        { environmentId: 'env-mac', body: dark('mac', { jobs: [{ workspaceId: 'm-purdue', sector: 'purdue', name: 'Purdue' }] }) },
        { environmentId: 'env-box', body: dark('box') }
      ],
      now,
      { home: 'env-box' }
    )!
    // Once, from the home; each host's own held row beside them; the read that failed empties nothing.
    expect(r.slipped.map((s) => [s.key, s.environmentId, s.open]).sort()).toEqual([
      ['env-box:held:host:h1', 'env-box', true],
      ['env-mac:held:host:h1', 'env-mac', true],
      ['task:k8', 'env-box', false],
      ['task:k9', 'env-box', true]
    ])
    expect(r.lifeosFrom).toBeNull()
    expect(r.slippedAt).toBe(MON + 4 * 24 * HOUR)
  })

  it('takes LifeOS from a part that answered this time before one kept from an earlier answer', () => {
    const old = { ...box, lifeos: { ...lifeos, done: [] }, slipped: { at: MON + 5 * 24 * HOUR, rows: [slip('task:k9'), slip('task:gone')] } }
    const r = mergeReview(
      [
        { environmentId: 'env-box', body: old, stale: true },
        { environmentId: 'env-mac', body: { ...mac, lifeos, slipped: { at: MON + 5 * 24 * HOUR, rows: [slip('task:k9')] } } }
      ],
      now,
      { home: 'env-box', fresh: false }
    )!
    // The home timed out: the Mac's fresh facts stand, and a press on a LifeOS row goes to the host that answered.
    expect(r.lifeosFrom).toBe('env-mac')
    expect(r.slipped.filter((s) => s.ref.kind === 'task').map((s) => [s.key, s.environmentId])).toEqual([['task:k9', 'env-mac']])
    expect(r.shipped.some((s) => s.kind === 'finished')).toBe(true)
  })

  it('counts a running week to the moment its facts were read, whatever the clock says when it is merged again', () => {
    // A meeting 2:00 to 3:30 PM on Monday, read at 2:02 PM, merged again at 3:00 PM with the same answer still held.
    const meeting = { ...lifeos.events[0]!, startsAt: MON + 14 * HOUR, endsAt: MON + 15.5 * HOUR }
    const part = { environmentId: 'env-box', body: { ...box, madeAt: MON + 14 * HOUR + 2 * MIN, lifeos: { ...lifeos, events: [meeting] } } }
    const at = (t: number): number => mergeReview([part], t)!.hours.find((h) => h.job === 'purdue')!.calendarMs
    expect(at(MON + 14 * HOUR + 2 * MIN)).toBe(2 * MIN)
    expect(at(MON + 15 * HOUR)).toBe(2 * MIN)
    // The page's "So far, made" names that same moment, though another host's part was read later.
    const later = { environmentId: 'env-mac', body: { ...mac, lifeos: null, madeAt: MON + 14 * HOUR + 8 * MIN } }
    expect(mergeReview([part, later], MON + 15 * HOUR, { home: 'env-box' })!.madeAt).toBe(MON + 14 * HOUR + 2 * MIN)
    // Read back on Monday, before Monday's answer lands, the week's end is no new read: the meeting still counts
    // to 2:02 PM, and the weekend's plans are not measured time.
    expect(at(WEEK.to + HOUR)).toBe(2 * MIN)
    // A part made once the week was over counts the whole meeting, whenever it was read.
    expect(mergeReview([{ ...part, body: { ...part.body, over: true, madeAt: WEEK.to + HOUR } }], WEEK.to + 2 * HOUR)!.hours.find((h) => h.job === 'purdue')!.calendarMs).toBe(1.5 * HOUR)
  })

  it('marks a row that stands as last known: its source did not answer, or its host answered from before', () => {
    const rows = [slip('task:k9'), slip('mail:t9', { ref: { kind: 'mail', threadId: 't9', since: MON } }), held('h1')]
    const marked = (over: Partial<ReviewBody>, stale = false): string[] =>
      mergeReview([{ environmentId: 'env-box', body: { ...box, slipped: { at: MON + 5 * 24 * HOUR, rows }, ...over }, stale }], now, { fresh: !stale })!
        .slipped.filter((r) => r.unchecked)
        .map((r) => r.key)
    expect(marked({})).toEqual([])
    expect(marked({ left: [LEFT.tasks] })).toEqual(['task:k9'])
    expect(marked({ left: [LEFT.held] })).toEqual(['env-box:held:host:h1'])
    expect(marked({ lifeos: null, left: [LEFT.lifeos] }).sort()).toEqual(['mail:t9', 'task:k9'])
    expect(marked({}, true)).toHaveLength(3)
  })

  it('lists every job the window knows of, one whose host did not answer too', () => {
    const r = mergeReview([{ environmentId: 'env-box', body: box }], now, { jobs: [{ key: 'purdue', sector: 'purdue', name: 'Purdue' }, { key: 'unify', sector: 'unify', name: 'Unify' }], whole: false })!
    expect(r.jobs.map((j) => [j.key, j.at.length])).toEqual([
      ['purdue', 1],
      [jobKey('box', { workspaceId: 'w-side', sector: null }), 1],
      ['unify', 0]
    ])
    expect(r.hours.find((h) => h.job === 'unify')).toMatchObject({ calendarMs: 0, deskMs: 0 })
  })

  it('says where an empty list is known to be empty', () => {
    const known = (left: string[], over: Partial<ReviewBody> = {}, opts: { fresh?: boolean; whole?: boolean } = {}) => mergeReview([{ environmentId: 'env-box', body: { ...box, left, ...over } }], now, opts)!.known
    expect(known([])).toEqual({ calendar: true, desk: true, shipped: true, slipped: true })
    expect(known([LEFT.calendar])).toEqual({ calendar: false, desk: true, shipped: true, slipped: false })
    expect(known([LEFT.mail])).toEqual({ calendar: true, desk: false, shipped: false, slipped: false })
    expect(known([LEFT.tasks])).toEqual({ calendar: true, desk: true, shipped: false, slipped: false })
    // What he approved goes out through the held items, and deciding one is desk time.
    expect(known([LEFT.held])).toEqual({ calendar: true, desk: false, shipped: false, slipped: false })
    expect(known([LEFT.threads])).toEqual({ calendar: true, desk: false, shipped: true, slipped: true })
    expect(known([LEFT.files])).toEqual({ calendar: true, desk: false, shipped: true, slipped: true })
    // The mail he sent is desk time too: with LifeOS out neither is known.
    expect(known([LEFT.lifeos], { lifeos: null })).toEqual({ calendar: false, desk: false, shipped: false, slipped: false })
    // A host that is off, or did not answer this time, holds threads and held items nobody read.
    for (const gap of [{ whole: false }, { fresh: false }]) expect(known([], {}, gap)).toEqual({ calendar: true, desk: false, shipped: false, slipped: false })
  })

  it('says "nothing" of a job with no hours only as far as it was read', () => {
    expect(nothingWords({ calendar: true, desk: true })).toBe('Nothing seen')
    expect(nothingWords({ calendar: false, desk: true })).toBe('No desk time seen')
    expect(nothingWords({ calendar: true, desk: false })).toBe('Nothing on the calendar')
    expect(nothingWords({ calendar: false, desk: false })).toBe('Not known')
  })
})

describe('the words for rows', () => {
  it('leads a shipped row with what happened', () => {
    expect(shippedWords({ kind: 'sent', title: 'Budget v2', who: 'Dana Reyes' })).toEqual({ lead: 'Sent ', title: 'Budget v2', tail: ' to Dana Reyes' })
    expect(shippedWords({ kind: 'finished', title: 'Order the new jerseys', who: null })).toEqual({ lead: 'Finished ', title: 'Order the new jerseys', tail: '' })
    expect(shippedWords({ kind: 'answered', title: 'Field trip forms', who: 'Dana Reyes' })).toEqual({ lead: 'Dana Reyes answered ', title: 'Field trip forms', tail: '' })
    expect(shippedWords({ kind: 'approved', title: 'Post the bracket to #esports', who: null }).lead).toBe('Approved ')
  })

  it('says one muted detail for a slipped row, by kind', () => {
    const tue = MON + 24 * HOUR + 9 * HOUR
    expect(slippedDetail({ ref: { kind: 'task', id: 'k', dueAt: tue }, at: tue, people: [], others: 0 }, WEEK, TZ)).toBe('due Tue')
    const nov12 = at('2026-11-12T18:00:00Z')
    expect(slippedDetail({ ref: { kind: 'mail', threadId: 't', since: nov12 }, at: nov12, people: ['Dana Reyes'], others: 1 }, WEEK, TZ)).toBe('sent Nov 12 to Dana Reyes')
    expect(slippedDetail({ ref: { kind: 'held', ref: { at: 'host', id: 'h' } }, at: tue, people: [], others: 0 }, WEEK, TZ)).toBe('held since Tue')
    const thu = MON + 3 * 24 * HOUR + 14 * HOUR
    expect(slippedDetail({ ref: { kind: 'meeting', eventId: 'e' }, at: thu, people: ['Dana Reyes'], others: 4 }, WEEK, TZ)).toBe('Thu 2:00 PM with Dana Reyes and 3 others, nothing sent after')
  })

  it('names people, days and when the page was made', () => {
    expect(peopleWords([], 0)).toBeNull()
    expect(peopleWords(['Dana Reyes'], 1)).toBe('Dana Reyes')
    expect(peopleWords(['Dana Reyes', 'Sam Park'], 2)).toBe('Dana Reyes and Sam Park')
    expect(peopleWords(['Dana Reyes', 'Sam Park'], 3)).toBe('Dana Reyes and 2 others')
    expect(dayWords(MON + 3 * 24 * HOUR, WEEK, TZ)).toBe('Thu')
    expect(dayWords(MON - 24 * HOUR, WEEK, TZ)).toBe('Nov 15')
    const friday4 = MON + 4 * 24 * HOUR + 16 * HOUR
    const made = { madeAt: friday4, slippedAt: friday4, to: WEEK.to }
    expect(madeWords({ ...made, over: false }, TZ, friday4 + HOUR)).toBe('So far, made 4:00 PM')
    // Once over, the page was made when what slipped was last read inside the week, whenever it is read again.
    expect(madeWords({ ...made, madeAt: friday4 + 3 * 24 * HOUR, over: true }, TZ, friday4 + 3 * 24 * HOUR)).toBe('Made Fri 4:00 PM')
    expect(madeWords({ ...made, over: true }, TZ, friday4 + 20 * 24 * HOUR)).toBe('Made Nov 20, 4:00 PM')
    expect(madeWords({ ...made, slippedAt: WEEK.to + HOUR, over: true }, TZ, WEEK.to + HOUR)).toBe('Not made in its week. What slipped is as of today.')
  })

  it('reads a named day in the zone weeks are cut in, and finds a week another zone named', () => {
    // Sunday Nov 22 at noon in UTC is Monday in Auckland in November: the day asked for is still Sunday there.
    const auckland = 'Pacific/Auckland'
    expect(weekOfDay('2026-11-22', auckland)).toEqual(weekOf(Date.parse('2026-11-22T00:00:00+13:00'), auckland))
    expect(weekOfDay('2026-11-23', auckland)!.from).toBeGreaterThan(weekOfDay('2026-11-22', auckland)!.from)
    expect(weekOfDay('2026-02-30', TZ)).toBeNull()
    // A Tokyo host's Monday midnight is Sunday in New York: the week it names is still found.
    const tokyo = weekOf(Date.parse('2026-11-18T12:00:00Z'), 'Asia/Tokyo')
    const ny = 'America/New_York'
    expect(weekOf(tokyo.from, ny).from).toBeLessThan(weekNamed(tokyo.from, ny).from)
    expect(weekNamed(tokyo.from, ny)).toEqual(weekOf(Date.parse('2026-11-18T12:00:00Z'), ny))
    expect(weekNamed(WEEK.from, TZ)).toEqual(WEEK)
  })

  it('folds tasks due before the week behind the rest', () => {
    const rows = [slip('task:new', { at: MON + HOUR }), slip('task:old', { at: MON - HOUR }), slip('mail:t', { ref: { kind: 'mail', threadId: 't', since: MON - HOUR }, at: MON - HOUR })]
    const { lead, older } = splitOlder(rows, WEEK)
    expect(lead.map((r) => r.key)).toEqual(['task:new', 'mail:t'])
    expect(older.map((r) => r.key)).toEqual(['task:old'])
  })
})
