import { describe, expect, it } from 'vitest'
import { GUEST_CAPS, guestSizeFor, sizeAskDue } from './guestSize'

const ASUS = { width: 3200, height: 1800 }
const MACBOOK = { width: 1728, height: 1117 }
const LG = { width: 3840, height: 1620 }

describe('guestSizeFor', () => {
  it('his three screens, Sharp', () => {
    // 200% would be 6400×3600: past every cap, so the scale steps down to the first that fits
    // 4000×2250 at 125% would pass the cap of 3456×2234's pixels: the scale steps down to 100%
    expect(guestSizeFor(ASUS, 2, 'sharp')).toEqual({ width: 3200, height: 1800, scale: 100 })
    expect(guestSizeFor(ASUS, 2, 'sharp', { ...GUEST_CAPS, maxPixels: 9_216_000 })).toEqual({ width: 4000, height: 2250, scale: 125 })
    expect(guestSizeFor(MACBOOK, 2, 'sharp')).toEqual({ width: 3456, height: 2234, scale: 200 })
    expect(guestSizeFor(LG, 1, 'sharp')).toEqual({ width: 3840, height: 1620, scale: 100 })
    expect(guestSizeFor(LG, 2, 'sharp')).toEqual({ width: 3840, height: 1620, scale: 100 })
  })

  it('Faster is one guest pixel a point, at 100%', () => {
    expect(guestSizeFor(MACBOOK, 2, 'faster')).toEqual({ width: 1728, height: 1116, scale: 100 })
    expect(guestSizeFor(ASUS, 2, 'faster')).toEqual({ width: 3200, height: 1800, scale: 100 })
  })

  it('Sharp takes the screen’s own density up to 2, on Windows’ steps', () => {
    expect(guestSizeFor({ width: 1600, height: 1000 }, 1, 'sharp')).toEqual({ width: 1600, height: 1000, scale: 100 })
    expect(guestSizeFor({ width: 1600, height: 1000 }, 1.5, 'sharp')).toEqual({ width: 2400, height: 1500, scale: 150 })
    expect(guestSizeFor({ width: 1600, height: 1000 }, 3, 'sharp')).toEqual({ width: 3200, height: 2000, scale: 200 })
    // between steps: the step below
    expect(guestSizeFor({ width: 1600, height: 1000 }, 1.6, 'sharp').scale).toBe(150)
  })

  it('answers even numbers', () => {
    const size = guestSizeFor({ width: 1301.5, height: 813.25 }, 1, 'sharp')
    expect(size.width % 2).toBe(0)
    expect(size.height % 2).toBe(0)
  })

  it('never goes under 1024×640 points: a small room grows in its shape', () => {
    expect(guestSizeFor({ width: 800, height: 500 }, 1, 'faster')).toEqual({ width: 1024, height: 640, scale: 100 })
    expect(guestSizeFor({ width: 800, height: 600 }, 1, 'faster')).toEqual({ width: 1024, height: 768, scale: 100 })
    expect(guestSizeFor({ width: 800, height: 500 }, 2, 'sharp')).toEqual({ width: 2048, height: 1280, scale: 200 })
  })

  it('holds the shape between 5:4 and 32:9', () => {
    expect(guestSizeFor({ width: 1200, height: 1600 }, 1, 'faster')).toEqual({ width: 1200, height: 960, scale: 100 })
    expect(guestSizeFor({ width: 4000, height: 1000 }, 1, 'faster')).toEqual({ width: 3554, height: 1000, scale: 100 })
  })

  it('never passes a cap: past 100% the size steps down in its shape', () => {
    const size = guestSizeFor({ width: 4800, height: 2700 }, 1, 'faster')
    expect(size.scale).toBe(100)
    expect(size.width).toBeLessThanOrEqual(GUEST_CAPS.maxWidth)
    expect(size.height).toBeLessThanOrEqual(GUEST_CAPS.maxHeight)
    expect(size.width * size.height).toBeLessThanOrEqual(GUEST_CAPS.maxPixels)
    expect(size).toEqual({ width: 3704, height: 2082, scale: 100 })
    // a host's own lower cap
    expect(guestSizeFor(MACBOOK, 2, 'sharp', { ...GUEST_CAPS, maxPixels: 5_000_000 })).toEqual({ width: 2592, height: 1674, scale: 150 })
    expect(guestSizeFor({ width: 5000, height: 2000 }, 1, 'faster')).toEqual({ width: 4096, height: 1638, scale: 100 })
  })
})

describe('sizeAskDue', () => {
  it('asks once the room has rested 400 ms', () => {
    expect(sizeAskDue(null, MACBOOK, 399)).toBe(false)
    expect(sizeAskDue(null, MACBOOK, 400)).toBe(true)
  })
  it('and moved 16 points or more from the last ask', () => {
    expect(sizeAskDue(MACBOOK, { width: 1743, height: 1117 }, 1_000)).toBe(false)
    expect(sizeAskDue(MACBOOK, { width: 1744, height: 1117 }, 1_000)).toBe(true)
    expect(sizeAskDue(MACBOOK, { width: 1728, height: 1101 }, 1_000)).toBe(true)
    expect(sizeAskDue(MACBOOK, { width: 1800, height: 1117 }, 100)).toBe(false)
  })
})
