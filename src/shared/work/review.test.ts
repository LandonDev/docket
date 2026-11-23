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
  LEFT,
  madeWords,
  mergeKept,
  mergeReview,
  peopleWords,
  shippedWords,
  slippedDetail,
  splitOlder,
  standsWords,
  stepWeek,
  totalWords,
  weekOf,
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

  it('names a job with two hours or more last week and nothing now', () => {
    expect(compareWeeks([hours('unify', 0)], [hours('unify', 0, 6 * HOUR)], false)).toEqual([{ job: 'unify', words: 'about 6 h last week' }])
    expect(compareWeeks([hours('unify', 0)], [hours('unify', 1.5 * HOUR)], false)).toEqual([])
    expect(compareWeeks([hours('new', 5 * HOUR)], [hours('new', 0)], false)).toEqual([{ job: 'new', words: 'nothing last week' }])
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
    expect(mergeKept(kept, fresh, WEEK.to - 1)).toBe(fresh)
  })

  it('once over, what slipped stays as it stood at the last make inside the week; the rest is fresh', () => {
    const friday = WEEK.from + 4 * 24 * HOUR + 16 * HOUR
    const kept = body({ by: 'routine', madeAt: friday, slipped: { at: friday, rows: [slip('task:a'), slip('task:b')] }, ran: [[0, HOUR]] })
    const later = WEEK.to + 3 * 24 * HOUR
    const fresh = body({ over: true, madeAt: later, slipped: { at: later, rows: [slip('task:b'), slip('task:c')] }, ran: [[0, 2 * HOUR]] })
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
    const r = mergeReview([{ environmentId: 'env-box', body: { ...box, before } }], now)!
    expect(r.compare).toEqual([{ job: 'purdue', words: 'down from 8 h' }])
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

  it('folds tasks due before the week behind the rest', () => {
    const rows = [slip('task:new', { at: MON + HOUR }), slip('task:old', { at: MON - HOUR }), slip('mail:t', { ref: { kind: 'mail', threadId: 't', since: MON - HOUR }, at: MON - HOUR })]
    const { lead, older } = splitOlder(rows, WEEK)
    expect(lead.map((r) => r.key)).toEqual(['task:new', 'mail:t'])
    expect(older.map((r) => r.key)).toEqual(['task:old'])
  })
})
