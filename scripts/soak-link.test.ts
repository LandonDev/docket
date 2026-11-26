import { afterEach, describe, expect, it } from 'vitest'
import { LINK_PARTS, parseSoakLink } from './lib/soakLink'

describe('the soak --link', () => {
  afterEach(() => {
    delete LINK_PARTS.z
  })

  it('keeps the old KiB-a-second form', () => {
    expect(parseSoakLink('512')).toEqual({ form: 'kib', bytesPerSec: 512 * 1024, words: '512 KiB/s from the host' })
    expect(() => parseSoakLink('0')).toThrow('above 0')
  })

  it("reads the kit's form as half the round trip each way", () => {
    expect(parseSoakLink('60/10')).toEqual({ form: 'shape', delayMs: 30, rateMbit: 10, options: {}, words: '60 ms there and back at 10 Mbit/s' })
    expect(parseSoakLink('0/2.5')).toMatchObject({ delayMs: 0, rateMbit: 2.5 })
  })

  it('refuses a form it cannot read', () => {
    for (const bad of ['60/', '/10', '60/0', 'fast', '60/10x']) expect(() => parseSoakLink(bad)).toThrow('--link')
  })

  it('passes a known part through as options and refuses an unknown one', () => {
    expect(() => parseSoakLink('60/10/j8')).toThrow('no part "j8"')
    LINK_PARTS.z = (n) => ({ zed: { oneIn: n } })
    expect(parseSoakLink('60/10/z8')).toMatchObject({ options: { zed: { oneIn: 8 } }, words: '60 ms there and back at 10 Mbit/s (z8)' })
  })
})
