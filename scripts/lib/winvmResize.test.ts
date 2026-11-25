import { describe, expect, it } from 'vitest'
import { fitAsk, fitMeans, RESIZE_SIZES, resizeRow } from './winvmResize'

describe("the resize proof's asks", () => {
  it('asks each size by a Fit room that means it', () => {
    for (const size of RESIZE_SIZES) expect(fitMeans(size), `${size.width}x${size.height}`).toBe(true)
    expect(fitAsk({ width: 3456, height: 2234 })).toEqual({ width: 1728, height: 1117, scale: 2 })
    // half of 1920×1200 is under the 1024×640 floor: asked at 1×
    expect(fitAsk({ width: 1920, height: 1200 })).toEqual({ width: 1920, height: 1200, scale: 1 })
  })
})

describe("the resize proof's row", () => {
  const asked = { width: 2560, height: 1600 }

  it('times the ask to the first frame at the asked size, and counts the frames at it and at any other', () => {
    const frames = [
      { us: 900, w: 2560, h: 1600 },
      { us: 1_200, w: 1280, h: 800 },
      { us: 151_000, w: 2560, h: 1600 },
      { us: 168_000, w: 2560, h: 1600 }
    ]
    expect(resizeRow({ asked, took: '2560x1600 at 200%', askUs: 1_000, closed: 4108, frames })).toEqual({
      asked: '2560x1600',
      took: '2560x1600 at 200%',
      closed: 4108,
      firstFrameMs: 150,
      atSize: 3,
      otherSize: 1
    })
  })

  it('has no time when no frame came at the size', () => {
    expect(resizeRow({ asked, took: 'error', askUs: 0, closed: null, frames: [{ us: 5, w: 1280, h: 800 }] })).toMatchObject({ firstFrameMs: null, atSize: 0, otherSize: 1 })
  })
})

describe('the resize proof', () => {
  it('starts its machine only through the scratch machine, behind the guard', async () => {
    const { readFileSync } = await import('node:fs')
    const script = readFileSync('scripts/e2e-winvm-resize.ts', 'utf8')
    expect(script).toMatch(/scratchMachine\(\{/)
    expect(script).not.toMatch(/new StandingMachine|startQemu|startTpm/)
    expect(readFileSync('scripts/lib/winvmScratch.ts', 'utf8')).toMatch(/export function scratchMachine\([^\n]*\): Scratch \{\n\s*requireScratchMachine\(\)/)
  })
})
