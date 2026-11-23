import { describe, expect, it } from 'vitest'
import { foldTitle, lastOf, linksIn, personKey, seriesOf, subjectWords, type SeriesPage } from './series'

/** The pure rules of a meeting's page (docs/agents/work-prep.md): the series, last time, the subject's words and the links in play. */

describe('the series of an event', () => {
  it('is the uid with the worker’s stamp cut, for both feeds', () => {
    // Google: the event id, then the original start
    expect(seriesOf({ uid: '4c2q1s0jv9h3k@20261110T140000Z' })).toBe('4c2q1s0jv9h3k')
    // an all-day occurrence
    expect(seriesOf({ uid: '4c2q1s0jv9h3k@20261110' })).toBe('4c2q1s0jv9h3k')
    // ICS: the iCal UID often holds an @ of its own; only the last stamp is cut
    expect(seriesOf({ uid: '040000008200E00074C5B7101A82E008@purdue.edu@20261116T190000Z' })).toBe('040000008200E00074C5B7101A82E008@purdue.edu')
  })

  it('is null for an event that repeats nothing', () => {
    expect(seriesOf({ uid: '4c2q1s0jv9h3k' })).toBeNull()
    // an iCal UID with an @ and no stamp is one event, not a series
    expect(seriesOf({ uid: 'abc123@google.com' })).toBeNull()
    expect(seriesOf({ uid: 'event@2026' })).toBeNull()
    expect(seriesOf({ uid: '@20261110' })).toBeNull()
    expect(seriesOf({})).toBeNull()
    expect(seriesOf({ uid: null })).toBeNull()
  })
})

const page = (over: Partial<SeriesPage> & { eventId: string; startsAt: number }): SeriesPage => ({ series: null, title: 'Staff sync', peopleKeys: [], ...over })

describe('last time', () => {
  it('is the newest earlier page of the same series', () => {
    const earlier = [
      page({ eventId: 'e1', series: 's', startsAt: 100 }),
      page({ eventId: 'e2', series: 's', startsAt: 200 }),
      page({ eventId: 'other', series: 't', startsAt: 250 }),
      page({ eventId: 'e4', series: 's', startsAt: 400 })
    ]
    expect(lastOf(page({ eventId: 'e3', series: 's', startsAt: 300 }), earlier)?.eventId).toBe('e2')
    // never itself, and never a later one
    expect(lastOf(page({ eventId: 'e1', series: 's', startsAt: 100 }), earlier)).toBeNull()
  })

  it('with no series, is the newest earlier page with the same title that shares a person', () => {
    const earlier = [
      page({ eventId: 'a', title: 'Budget review', startsAt: 100, peopleKeys: ['dana@x.test'] }),
      page({ eventId: 'b', title: 'budget  REVIEW!', startsAt: 200, peopleKeys: ['dana@x.test', 'tom@x.test'] }),
      page({ eventId: 'c', title: 'Budget review', startsAt: 250, peopleKeys: ['maya@x.test'] }),
      page({ eventId: 'd', title: 'Budget review', series: 's', startsAt: 260, peopleKeys: ['dana@x.test'] })
    ]
    expect(lastOf(page({ eventId: 'now', title: 'Budget Review', startsAt: 300, peopleKeys: ['dana@x.test'] }), earlier)?.eventId).toBe('b')
    // the same title with nobody shared is another meeting
    expect(lastOf(page({ eventId: 'now', title: 'Budget review', startsAt: 300, peopleKeys: ['zed@x.test'] }), earlier)).toBeNull()
    // and a meeting with nobody on it shares nobody
    expect(lastOf(page({ eventId: 'now', title: 'Budget review', startsAt: 300 }), earlier)).toBeNull()
  })

  it('knows a person by address, or by name when the page has no address', () => {
    expect(personKey({ address: ' Dana@X.test ', name: 'Dana' })).toBe('dana@x.test')
    expect(personKey({ name: 'Dána  Reyes' })).toBe('~dana reyes')
    expect(foldTitle('  Scrim vs. Illinois (week 3) ')).toBe('scrim vs illinois week 3')
  })
})

describe('the words of a subject', () => {
  it('drops the words every meeting has', () => {
    expect(subjectWords('Weekly budget review with Dana')).toBe('budget dana')
    expect(subjectWords('Scrim vs. Illinois')).toBe('scrim illinois')
    expect(subjectWords('Arena refresh: kickoff call')).toBe('arena refresh')
  })

  it('answers nothing for a title with no subject, so no search runs', () => {
    for (const title of ['Meeting', 'Weekly sync', '1:1', 'Check-in', 'Stand-up', 'Catch up call', '']) expect(subjectWords(title), title).toBe('')
    expect(subjectWords('Staff meeting')).toBe('staff')
  })
})

describe('the links in an event', () => {
  it('finds http and https links once each, and names the call’s link Join the call', () => {
    const description = 'Agenda: https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit\nJoin: https://purdue.zoom.us/j/99887766?pwd=abc. Slides at https://example.com/decks/Q3-budget_review.pdf, and again https://example.com/decks/Q3-budget_review.pdf'
    expect(linksIn(description, 'https://teams.microsoft.com/l/meetup-join/xyz')).toEqual([
      { title: 'docs.google.com', url: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit' },
      { title: 'Join the call', url: 'https://purdue.zoom.us/j/99887766?pwd=abc' },
      { title: 'Q3 budget review.pdf', url: 'https://example.com/decks/Q3-budget_review.pdf' }
    ])
  })

  it('takes no other scheme and nothing from empty text', () => {
    expect(linksIn('mailto:dana@x.test ftp://files.test/a file:///etc/passwd javascript:alert(1)', undefined, null)).toEqual([])
    expect(linksIn('RecWell 204')).toEqual([])
  })
})
