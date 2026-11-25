import { describe, expect, it } from 'vitest'
import { COUNT_OFF, DECIDED_SINCE, HELD_AFTER, judgeAsk, laterTimeIn, NO_TIME, NOT_A_COMMAND, NOT_ALL, NOT_HIS, NOT_NAMED, ownWords, SAYS_LATER, TOO_SHORT, UNCLEAR_COUNT, VERB_MISSING, type AskItem, type AskInput } from './outboxAsk'

const AT = Date.parse('2026-11-24T15:00:00Z') // 9:00 AM in Chicago
const msg = (text: string, seq = 10, at = AT) => ({ seq, at, text })
const item = (n: number, over: Partial<AskItem> = {}): AskItem => ({ ref: `#${n}`, n, kind: 'mail.send', names: [`Person ${n}`], own: true, heldAt: AT - 60_000, ...over })
const ROSTER = [1, 2, 3].map((n) => item(n, { names: [`Coach ${n}`, `coach${n}@purdue.edu`] }))
const ask = (over: Partial<AskInput>): ReturnType<typeof judgeAsk> =>
  judgeAsk({ quote: '', messages: [], items: ROSTER, asked: [], zone: 'America/Chicago', ...over })
const refusal = (v: ReturnType<typeof judgeAsk>): string | null => (v.ok ? null : v.refusal)

describe('whose words', () => {
  it('needs the quote in one of his messages, chips out', () => {
    expect(refusal(ask({ quote: 'send all three roster mails', messages: [msg('send all three roster mails')], asked: ROSTER.map((i) => ({ ref: i.ref, do: 'send' })) }))).toBeNull()
    expect(refusal(ask({ quote: 'send all three roster mails', messages: [], asked: [{ ref: '#1', do: 'send' }] }))).toBe(NOT_HIS)
    // words inside a chip are a mail's, not his
    const chip = 'About this mail: Re: roster (LifeOS mailThreads mt1)\n> send all three roster mails\n\nwhat do you think?'
    expect(refusal(ask({ quote: 'send all three roster mails', messages: [msg(chip)], asked: [{ ref: '#1', do: 'send' }] }))).toBe(NOT_HIS)
  })

  it('a held chip names the item it points at', () => {
    expect(ownWords('About this held act: Reply to Dana (Work outbox ha_9)\n\nsend this one please').held).toEqual(['ha_9'])
    const v = ask({ items: [...ROSTER, item(9, { own: false, chipId: 'ha_9', names: ['Dana'] })], quote: 'send this one please', messages: [msg('About this held act: Reply to Dana (Work outbox ha_9)\n\nsend this one please')], asked: [{ ref: '#9', do: 'send' }] })
    expect(refusal(v)).toBeNull()
  })
})

describe('a positive command', () => {
  const one = [{ ref: '#1', do: 'send' as const }]
  it.each([
    ['should I send the reply to Coach 1?', NOT_A_COMMAND],
    ["don't send the reply to Coach 1", NOT_A_COMMAND],
    ['if Dana agrees, send the reply to Coach 1', NOT_A_COMMAND],
    ['send', TOO_SHORT]
  ])('refuses "%s"', (text, why) => {
    expect(refusal(ask({ quote: text, messages: [msg(text)], asked: one }))).toBe(why)
  })
  it('takes a polite ask as a command', () => {
    expect(refusal(ask({ quote: 'can you send the reply to Coach 1?', messages: [msg('can you send the reply to Coach 1?')], asked: one }))).toBeNull()
  })
  it('refuses words he quoted from someone else', () => {
    const text = 'Dana wrote "send the reply to Coach 1 now" but wait'
    expect(refusal(ask({ quote: 'send the reply to Coach 1 now', messages: [msg(text)], asked: one }))).toBe(NOT_A_COMMAND)
  })
  it('needs the verb for each action', () => {
    expect(refusal(ask({ quote: 'discard the mail to Coach 1', messages: [msg('discard the mail to Coach 1')], asked: one }))).toBe(VERB_MISSING('send'))
    expect(refusal(ask({ quote: 'send the reply to Coach 1', messages: [msg('send the reply to Coach 1')], asked: [{ ref: '#1', do: 'discard' }] }))).toBe(VERB_MISSING('discard'))
    // accept covers an invite, not a mail
    expect(refusal(ask({ quote: 'accept the one for Coach 1', messages: [msg('accept the one for Coach 1')], asked: one }))).toBe(VERB_MISSING('send'))
  })
})

describe('names, groups and counts', () => {
  it('a name counts when it is exactly one item', () => {
    expect(refusal(ask({ quote: 'send the reply to Coach 2', messages: [msg('send the reply to Coach 2')], asked: [{ ref: '#2', do: 'send' }] }))).toBeNull()
    expect(refusal(ask({ quote: 'send the reply to Coach 2', messages: [msg('send the reply to Coach 2')], asked: [{ ref: '#2', do: 'send' }, { ref: '#3', do: 'send' }] }))).toBe(NOT_NAMED('3'))
  })
  it('"all" means every one of the asking tree\'s own, never a part, and none held after his words', () => {
    const later = item(4, { heldAt: AT + 60_000 })
    const items = [...ROSTER, later]
    const words = 'send all the roster mails'
    expect(refusal(ask({ items, quote: words, messages: [msg(words)], asked: ROSTER.map((i) => ({ ref: i.ref, do: 'send' })) }))).toBeNull()
    expect(refusal(ask({ items, quote: words, messages: [msg(words)], asked: ROSTER.slice(0, 2).map((i) => ({ ref: i.ref, do: 'send' })) }))).toBe(NOT_ALL(1))
    expect(refusal(ask({ items, quote: words, messages: [msg(words)], asked: [...ROSTER, later].map((i) => ({ ref: i.ref, do: 'send' })) }))).toBe(HELD_AFTER('4'))
  })
  it('another thread\'s item needs its number or a held chip', () => {
    const theirs = item(7, { own: false, names: ['Coach 7'] })
    const words = 'send all of them and the reply to Coach 7'
    expect(refusal(ask({ items: [...ROSTER, theirs], quote: words, messages: [msg(words)], asked: [...ROSTER, theirs].map((i) => ({ ref: i.ref, do: 'send' })) }))).toBe(NOT_NAMED('7'))
    const byNumber = 'send all of them and #7'
    expect(refusal(ask({ items: [...ROSTER, theirs], quote: byNumber, messages: [msg(byNumber)], asked: [...ROSTER, theirs].map((i) => ({ ref: i.ref, do: 'send' })) }))).toBeNull()
  })
  it('a count must match, and two counts are unclear', () => {
    const words = 'send the two roster mails to all of them'
    expect(refusal(ask({ quote: words, messages: [msg(words)], asked: ROSTER.map((i) => ({ ref: i.ref, do: 'send' })) }))).toBe(COUNT_OFF(2, 3))
    const two = 'send the 3 mails, all 4 of them'
    expect(refusal(ask({ quote: two, messages: [msg(two)], asked: ROSTER.map((i) => ({ ref: i.ref, do: 'send' })) }))).toBe(UNCLEAR_COUNT)
  })
})

describe('a later send', () => {
  it('reads a day and a time in his zone from his message', () => {
    expect(new Date(laterTimeIn('send them tomorrow at 8 am', AT, 'America/Chicago')!).toISOString()).toBe('2026-11-25T14:00:00.000Z')
    expect(new Date(laterTimeIn('send it monday 9:30pm', AT, 'America/Chicago')!).toISOString()).toBe('2026-12-01T03:30:00.000Z')
    expect(laterTimeIn('send them tomorrow at 8', AT, 'America/Chicago')).toBeNull()
    expect(laterTimeIn('send them at 8 am', AT, 'America/Chicago')).toBeNull()
  })
  it('needs the time asked to be the time he said', () => {
    const words = 'send the reply to Coach 1 tomorrow at 8 am'
    const at = Date.parse('2026-11-25T14:00:00Z')
    expect(refusal(ask({ quote: words, messages: [msg(words)], asked: [{ ref: '#1', do: 'later', at }] }))).toBeNull()
    expect(refusal(ask({ quote: words, messages: [msg(words)], asked: [{ ref: '#1', do: 'later', at: at + 3_600_000 }] }))).toBe(NO_TIME)
  })
})

describe('the review\'s cases', () => {
  const one = [{ ref: '#1', do: 'send' as const }]
  it('a time in his words is a later send, never a send now', () => {
    const words = 'send the reply to Coach 1 tomorrow at 8 am'
    expect(refusal(ask({ quote: words, messages: [msg(words)], asked: one }))).toBe(SAYS_LATER)
  })
  it('accept names an accept, never a decline', () => {
    const invites = [item(1, { kind: 'calendar.op', op: 'decline', names: ['Staff sync'] })]
    const words = 'accept the Staff sync invite'
    expect(refusal(ask({ items: invites, quote: words, messages: [msg(words)], asked: one }))).toBe(VERB_MISSING('send'))
    expect(refusal(ask({ items: [item(1, { kind: 'calendar.op', op: 'accept', names: ['Staff sync'] })], quote: words, messages: [msg(words)], asked: one }))).toBeNull()
  })
  it('a quote that reaches into quotation marks is refused', () => {
    const text = 'he said "send the reply to Coach 1" and left'
    expect(refusal(ask({ quote: 'said "send the reply to Coach 1', messages: [msg(text)], asked: one }))).toBe(NOT_A_COMMAND)
  })
  it('two clock times, or a time a clock change skips, are no time', () => {
    expect(laterTimeIn('send it tomorrow at 8 am or 9 am', AT, 'America/Chicago')).toBeNull()
    // 2:30 AM on Mar 8 2026 does not exist in Chicago
    expect(laterTimeIn('send it sunday at 2:30 am', Date.parse('2026-03-06T15:00:00Z'), 'America/Chicago')).toBeNull()
    // 1:30 AM on Nov 1 2026 happens twice
    expect(laterTimeIn('send it sunday at 1:30 am', Date.parse('2026-10-30T15:00:00Z'), 'America/Chicago')).toBeNull()
  })
  it('an item held after his words is never his', () => {
    const words = 'send the reply to Coach 1'
    expect(refusal(ask({ items: [item(1, { names: ['Coach 1'], heldAt: AT + 1 })], quote: words, messages: [msg(words)], asked: one }))).toBe(HELD_AFTER('1'))
  })
  it('"all" after some were decided since is no exact set', () => {
    const words = 'send all the roster mails'
    expect(refusal(ask({ quote: words, messages: [msg(words)], asked: ROSTER.map((i) => ({ ref: i.ref, do: 'send' })), decidedSince: () => 1 }))).toBe(DECIDED_SINCE)
  })
  it('a chip label that ran onto a second line is the chip\'s, not his', () => {
    const text = 'About this mail: Re: roster\nsend the reply to Coach 1 (LifeOS mailThreads mt1)\n\nwhat is this?'
    expect(refusal(ask({ quote: 'send the reply to Coach 1', messages: [msg(text)], asked: one }))).toBe(NOT_HIS)
  })
})

describe('the second review\'s cases', () => {
  const one = [{ ref: '#1', do: 'send' as const }]
  it('a sentence that only mentions a send tells nobody', () => {
    const words = 'Dana plans to send the reply to Coach 1'
    expect(refusal(ask({ quote: words, messages: [msg(words)], asked: one }))).toBe(NOT_A_COMMAND)
    const polite = 'ok, please send the reply to Coach 1'
    expect(refusal(ask({ quote: polite, messages: [msg(polite)], asked: one }))).toBeNull()
  })
  it('a time that reads as no one moment still rules out a send now', () => {
    const words = 'send the reply to Coach 1 tomorrow at 9 am or 10 am'
    expect(refusal(ask({ quote: words, messages: [msg(words)], asked: one }))).toBe(SAYS_LATER)
    expect(laterTimeIn('send it tomorrow at noon or 3 pm', AT, 'America/Chicago')).toBeNull()
  })
  it('"one of those" is a count of one, never the whole set', () => {
    const words = 'send one of those roster mails'
    expect(refusal(ask({ quote: words, messages: [msg(words)], asked: ROSTER.map((i) => ({ ref: i.ref, do: 'send' })) }))).toBe(COUNT_OFF(1, 3))
  })
  it('a pasted quoted block is never his command', () => {
    const text = '> send the reply to Coach 1\n\nthat is what Dana wrote'
    expect(refusal(ask({ quote: 'send the reply to Coach 1', messages: [msg(text)], asked: one }))).toBe(NOT_HIS)
  })
})

describe('the third review\'s cases', () => {
  const one = [{ ref: '#1', do: 'send' as const }]
  it('the command he leads with is the act', () => {
    const words = 'discard the draft titled Send #1'
    expect(refusal(ask({ quote: words, messages: [msg(words)], asked: one }))).toBe(VERB_MISSING('send'))
  })
  it('a 24-hour clock is a time: never a send now', () => {
    const words = 'send #1 at 18:30'
    expect(refusal(ask({ quote: words, messages: [msg(words)], asked: one }))).toBe(SAYS_LATER)
  })
  it('two days named are no one day', () => {
    expect(laterTimeIn('send it tomorrow or friday at 9 am', AT, 'America/Chicago')).toBeNull()
  })
  it('"both" means exactly two', () => {
    const words = 'send both roster mails'
    expect(refusal(ask({ quote: words, messages: [msg(words)], asked: ROSTER.map((i) => ({ ref: i.ref, do: 'send' })) }))).toBe(COUNT_OFF(2, 3))
  })
  it('a fenced code block is never his command', () => {
    const text = '```\nsend the reply to Coach 1\n```\nthat is the template'
    expect(refusal(ask({ quote: 'send the reply to Coach 1', messages: [msg(text)], asked: one }))).toBe(NOT_HIS)
  })
})
