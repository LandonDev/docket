import { describe, expect, it } from 'vitest'
import { TELL_GROUPS } from '@shared/work/tell'
import { decide, defaultOpen, DIGEST_TELLS, groupsByKind, groupsListed, KEEP_MS, retold } from './rule'

/** The whole rule as a table: a level, a clock, and whether he hears now or in the digest. */

const NEXT = Date.parse('2026-11-24T08:00:00-05:00')
const HOUR = 3_600_000

describe('decide', () => {
  it.each([
    // level, by (relative to the next digest), verdict
    ['clock', undefined, 'wait'],
    ['clock', -12 * HOUR, 'now'],
    ['clock', -1, 'now'],
    ['clock', 0, 'now'],
    ['clock', KEEP_MS - 1, 'now'],
    ['clock', KEEP_MS, 'wait'],
    ['clock', 3 * 24 * HOUR, 'wait'],
    ['now', undefined, 'now'],
    ['now', 3 * 24 * HOUR, 'now'],
    ['digest', undefined, 'wait'],
    ['digest', -12 * HOUR, 'wait']
  ] as const)('at level %s with a clock %s from the next digest: %s', (level, off, verdict) => {
    expect(decide({ by: off === undefined ? undefined : NEXT + off }, level, NEXT)).toBe(verdict)
  })
  it('a thing due at 9:30 is not first heard of at 8:00: the margin is two hours', () => {
    expect(KEEP_MS).toBe(2 * HOUR)
    expect(decide({ by: Date.parse('2026-11-24T09:30:00-05:00') }, 'clock', NEXT)).toBe('now')
    expect(decide({ by: Date.parse('2026-11-24T10:00:00-05:00') }, 'clock', NEXT)).toBe('wait')
  })
  it('a clock that already passed interrupts: he believes it went', () => {
    expect(decide({ by: NEXT - 30 * HOUR }, 'clock', NEXT)).toBe('now')
  })
})

describe('a replaced key', () => {
  it('is told again only when its clock moved earlier', () => {
    expect(retold({ by: 2000 }, { by: 1000 })).toBe(true)
    expect(retold({ by: 1000 }, { by: 1000 })).toBe(false)
    expect(retold({ by: 1000 }, { by: 2000 })).toBe(false)
    expect(retold({ by: 1000 }, {})).toBe(false)
    expect(retold({}, { by: 1000 })).toBe(true)
    expect(retold({}, {})).toBe(false)
  })
})

describe('the kinds', () => {
  it("gives each of the digest's own kinds one of the closed groups", () => {
    for (const t of DIGEST_TELLS) expect(TELL_GROUPS).toContain(t.group)
    expect(new Set(DIGEST_TELLS.map((t) => t.kind)).size).toBe(DIGEST_TELLS.length)
    for (const t of DIGEST_TELLS) expect(t.kind).toMatch(/^[a-z]+\.[a-z]+$/)
  })
  it('reads a kind from whichever module lists it, the first one winning, and lists the groups in order', () => {
    const modules = [{ tells: [{ kind: 'clashes.new', group: 'clashes' as const, name: 'A clash' }] }, { tells: [{ kind: 'clashes.new', group: 'system' as const, name: 'again' }, { kind: 'outbox.held', group: 'held' as const, name: 'Held' }] }, {}]
    expect(groupsByKind(modules).get('clashes.new')).toBe('clashes')
    expect(groupsByKind(modules).get('nobody.listed')).toBeUndefined()
    expect(groupsListed(modules)).toEqual(['held', 'clashes'])
  })
})

describe('a kind whose teller names no target', () => {
  it("the weekly review opens its page on the week its key names; a sibling's own listing of the kind wins over the digest's", () => {
    expect(defaultOpen({ kind: 'review.ready', key: 'review:2026-11-16' })).toEqual({ place: 'review', at: '2026-11-16' })
    expect(defaultOpen({ kind: 'review.ready' })).toEqual({ place: 'review' })
    expect(defaultOpen({ kind: 'routines.done', key: 'thread:t1' })).toBeUndefined()
    expect(groupsByKind([{ tells: DIGEST_TELLS }]).get('review.ready')).toBe('review')
    expect(groupsByKind([{ tells: [{ kind: 'review.ready', group: 'system', name: 'its own' }] }, { tells: DIGEST_TELLS }]).get('review.ready')).toBe('system')
  })
})
