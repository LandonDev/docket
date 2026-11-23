import { describe, expect, it } from 'vitest'
import { CHAT_ROUTES, CHAT_SOURCES, fileMarkers, firstWords, isChatSource, replyWhere, serviceState, staleOf, syncLine, syncWhen, type ChatSourceState } from './messages'

/** The messages pillar's pure rules: what is chat, when a source is stale, the sync line's words, and the folded file names. */

const now = new Date(2026, 10, 23, 15, 0).getTime()
const MIN = 60_000
const HOUR = 60 * MIN
const src = (kind: ChatSourceState['kind'], over: Partial<ChatSourceState> = {}): ChatSourceState => ({ kind, label: kind, status: 'ok', lastSyncAt: now - MIN, ...over })
const nov3 = new Date(2026, 10, 3, 9).getTime()
const nov16 = new Date(2026, 10, 16, 20).getTime()

describe('the names', () => {
  it('holds four chat sources, each with a way a reply leaves', () => {
    expect([...CHAT_SOURCES]).toEqual(['slack', 'discord', 'imessage', 'teams'])
    expect(CHAT_ROUTES).toEqual({ slack: 'lifeos', imessage: 'lifeos', discord: 'copy', teams: 'copy' })
    expect(isChatSource('slack')).toBe(true)
    expect(isChatSource('email')).toBe(false)
  })

  it('words a held reply and cuts first words at a word', () => {
    expect(replyWhere('slack', 'Dana Lee')).toBe('Reply in Slack to Dana Lee')
    expect(firstWords('On it')).toBe('On it')
    const long = 'The venue moved to Friday so the whole crew needs the new call sheet before Thursday noon'
    expect(firstWords(long)).toBe('The venue moved to Friday so the whole crew needs the new…')
    expect(firstWords('a\n\n  b   c')).toBe('a b c')
  })
})

describe('stale', () => {
  it('is an error, a silence past the source’s limit, or a source never heard from', () => {
    expect(staleOf(src('slack'), now)).toBe(false)
    expect(staleOf(src('slack', { status: 'error' }), now)).toBe(true)
    // The box's readers check in each minute: fifteen minutes of silence is stale.
    expect(staleOf(src('slack', { lastSyncAt: now - 14 * MIN }), now)).toBe(false)
    expect(staleOf(src('discord', { lastSyncAt: now - 16 * MIN }), now)).toBe(true)
    // A desktop sleeps at night: a day and a half.
    expect(staleOf(src('imessage', { lastSyncAt: now - 35 * HOUR }), now)).toBe(false)
    expect(staleOf(src('teams', { lastSyncAt: now - 37 * HOUR }), now)).toBe(true)
    expect(staleOf(src('slack', { lastSyncAt: undefined }), now)).toBe(true)
    // A check-in counts as being heard from, whether or not the watermark moved.
    expect(staleOf(src('slack', { lastSyncAt: now - HOUR, reportedAt: now - MIN }), now)).toBe(false)
  })

  it('judges a service by its freshest row, so a channel that never synced does not make a reading workspace stale', () => {
    const rows = [src('discord', { status: 'idle', lastSyncAt: undefined }), src('discord', { lastSyncAt: now - MIN })]
    expect(serviceState(rows, 'discord', now)).toEqual({ stale: false, heard: now - MIN })
    expect(serviceState([src('discord', { status: 'idle', lastSyncAt: undefined }), src('discord', { lastSyncAt: nov3 })], 'discord', now)).toEqual({ stale: true, heard: nov3 })
    expect(serviceState([src('discord'), src('discord', { status: 'error' })], 'discord', now)?.stale).toBe(true)
    expect(serviceState(rows, 'slack', now)).toBeNull()
  })
})

describe('the sync line', () => {
  it('says nothing while every service is fresh', () => {
    expect(syncLine([src('slack'), src('discord')], now)).toBeNull()
    expect(syncLine([], now)).toBeNull()
  })

  it('names each stale service once, the verb once', () => {
    expect(syncLine([src('slack'), src('discord', { lastSyncAt: nov3 })], now)).toBe('Discord last synced Nov 3')
    expect(syncLine([src('discord', { lastSyncAt: nov3 }), src('discord', { lastSyncAt: nov3 - HOUR }), src('imessage', { lastSyncAt: nov16 })], now)).toBe('Discord last synced Nov 3, iMessage Nov 16')
    expect(syncLine([src('teams', { status: 'idle', lastSyncAt: undefined })], now)).toBe('Teams has not synced')
  })

  it('says a time for today and a date for another day', () => {
    expect(syncWhen(now - 16 * MIN, now)).toBe('2:44 PM')
    expect(syncWhen(new Date(2026, 10, 23, 0, 5).getTime(), now)).toBe('12:05 AM')
    expect(syncWhen(nov3, now)).toBe('Nov 3')
    expect(syncLine([src('slack', { lastSyncAt: now - 16 * MIN })], now)).toBe('Slack last synced 2:44 PM')
  })
})

describe('folded file names', () => {
  it('leaves the words alone until the files are listed', () => {
    expect(fileMarkers('See this [file: venue.png]', [])).toBe('See this [file: venue.png]')
  })

  it('takes out what each reader folded in, and nothing anyone wrote', () => {
    expect(fileMarkers('See this [file: venue.png]', [{ name: 'venue.png' }])).toBe('See this')
    expect(fileMarkers('[file: a.png]\n[file: b (1).pdf]', [{ name: 'a.png' }, { name: 'b (1).pdf' }])).toBe('')
    // A name he typed himself, with no marker, stays.
    expect(fileMarkers('venue.png is the one\n[file: venue.png]', [{ name: 'venue.png' }])).toBe('venue.png is the one')
    // Discord folds the name and its address on a line of its own.
    expect(fileMarkers('New map\nmap.png https://cdn.example/1/map.png', [{ name: 'map.png' }])).toBe('New map')
    expect(fileMarkers('map.png https://cdn.example/1/map.png', [{ name: 'map.png' }])).toBe('')
    // A text that is only its attachment.
    expect(fileMarkers('Sent an attachment: IMG_2041.heic', [{ name: 'IMG_2041.heic' }])).toBe('')
    expect(fileMarkers('Sent an attachment: IMG_2041.heic, notes.pdf', [{ name: 'IMG_2041.heic' }])).toBe('Sent an attachment: IMG_2041.heic, notes.pdf')
  })
})
