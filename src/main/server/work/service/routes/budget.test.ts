import { describe, expect, it } from 'vitest'
import { Bucket, Buckets, tooMuchWords, waitOf } from './budget'

const MIB = 1024 * 1024

describe("a link's budget of bytes", () => {
  // 4 MiB at once, 1 MiB back a minute: the numbers the service runs on.
  const bucket = (now = 0) => new Bucket(4 * MIB, MIB / 60_000, now)

  it('lets a full bucket go at once, then holds the link until what it asks for is back', () => {
    const b = bucket()
    expect(b.take(3 * MIB, 0)).toBe(0)
    expect(b.take(MIB, 0)).toBe(0)
    // Empty: half a megabyte more is half a minute away, and nothing is spent on asking.
    expect(b.take(MIB / 2, 0)).toBe(30_000)
    expect(b.held(0)).toBe(30_000)
    expect(b.held(29_999)).toBe(1)
    expect(b.held(30_000)).toBe(0)
    expect(b.take(MIB / 2, 30_000)).toBe(0)
  })

  it('fills at a megabyte a minute and never past four', () => {
    const b = bucket()
    expect(b.take(4 * MIB, 0)).toBe(0)
    expect(b.take(MIB, 60_000)).toBe(0)
    expect(b.take(1, 60_000)).toBeGreaterThan(0)
    // An hour idle is four megabytes, not sixty.
    expect(b.take(4 * MIB, 60 * 60_000)).toBe(0)
    expect(b.take(1, 60 * 60_000)).toBeGreaterThan(0)
  })

  it('answers a wait for a full bucket to more than it ever holds: the frame cap stops the rest', () => {
    const b = bucket()
    expect(b.take(MIB, 0)).toBe(0)
    expect(b.take(40 * MIB, 0)).toBe(60_000)
  })

  it('keeps one bucket a link, and lets the oldest go past its cap', () => {
    const made: number[] = []
    const all = new Buckets((now) => (made.push(now), new Bucket(10, 1, now)), 2)
    const a = all.of('a', 0)
    expect(all.of('a', 5)).toBe(a)
    all.of('b', 1)
    all.of('c', 2)
    expect(all.of('a', 9)).not.toBe(a)
    expect(made).toEqual([0, 1, 2, 9])
  })

  it('says the seconds to wait in the close, which the page reads back', () => {
    expect(tooMuchWords(41_200)).toBe('too much at once: wait 42 s')
    expect(waitOf(tooMuchWords(41_200))).toBe(42)
    expect(waitOf(tooMuchWords(1))).toBe(1)
    expect(waitOf('the link was revoked')).toBeNull()
  })
})
