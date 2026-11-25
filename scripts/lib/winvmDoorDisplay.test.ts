import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { BUTTON_RGB, colourCentre, exeRefusal, M3C_COMMIT, modeWord, pngSize, proofPage, summary } from './winvmDoorDisplay'

describe("the door proof's exe", () => {
  const stamp = { commit: 'abc', sha256: 'f'.repeat(64), builtAt: '2026-11-24T00:00:00Z' }
  const ok = { exe: '/t/tc-computer.exe', sha256: 'f'.repeat(64), stamp, holdsM3c: true }

  it('takes only a stamped build from a tree that holds M3c, unchanged since', () => {
    expect(exeRefusal(ok)).toBeNull()
    expect(exeRefusal({ ...ok, exe: null })).toMatch('build it with --build-exe')
    expect(exeRefusal({ ...ok, stamp: null })).toMatch('has no build stamp')
    expect(exeRefusal({ ...ok, sha256: '0'.repeat(64) })).toMatch('is not the file its stamp names')
    expect(exeRefusal({ ...ok, holdsM3c: false })).toMatch(`does not hold M3c (${M3C_COMMIT.slice(0, 9)})`)
  })
})

describe("the door proof's picture", () => {
  /** A picture of `w`×`h` grey with the button's colour over a rectangle, its edge softened as JPEG or scaling would. */
  const picture = (w: number, h: number, box: { x: number; y: number; w: number; h: number }) => {
    const rgba = new Uint8Array(w * h * 4).fill(200)
    for (let y = box.y; y < box.y + box.h; y++)
      for (let x = box.x; x < box.x + box.w; x++) {
        const i = (y * w + x) * 4
        const edge = x === box.x || y === box.y
        rgba.set(edge ? [240, 12, 236, 255] : [...BUTTON_RGB, 255], i)
      }
    return rgba
  }

  it("finds the button's centre in whole pixels of the picture", () => {
    expect(colourCentre(picture(1280, 827, { x: 100, y: 200, w: 211, h: 95 }), 1280, 827, BUTTON_RGB)).toEqual({ x: 205, y: 247, pixels: 211 * 95 })
  })

  it('finds no button where it is not drawn, or too few pixels of its colour', () => {
    expect(colourCentre(picture(640, 400, { x: 0, y: 0, w: 0, h: 0 }), 640, 400, BUTTON_RGB)).toBeNull()
    expect(colourCentre(picture(640, 400, { x: 10, y: 10, w: 5, h: 5 }), 640, 400, BUTTON_RGB)).toBeNull()
  })

  it("reads a PNG's size from its header, and nothing from another file", () => {
    const png = PNG.sync.write(Object.assign(new PNG({ width: 345, height: 223 }), {}))
    expect(pngSize(png)).toEqual({ width: 345, height: 223 })
    expect(pngSize(Buffer.from('not a png at all, not one bit'))).toBeNull()
  })

  it("serves one button in the colour the picture is searched for, and posts each click to the box", () => {
    const page = proofPage()
    expect(page).toContain('>Add one</button>')
    expect(page).toContain(`background:rgb(${BUTTON_RGB.join(',')})`)
    expect(page).toContain("fetch('/add',{method:'POST'})")
    expect(page).toContain('Count: <span id="count">0</span>')
  })
})

describe("the door proof's rows", () => {
  it('passes only when every row passed, and names the ones that did not', () => {
    expect(summary([{ step: 'a', ok: true, ms: 5 }]).ok).toBe(true)
    expect(summary([{ step: 'a', ok: true }, { step: 'b', ok: false }])).toMatchObject({ ok: false, failed: ['b'] })
    expect(modeWord({ width: 3456, height: 2234, scale: 200 })).toBe('3456x2234@200')
  })
})

describe('the door proof', () => {
  const script = readFileSync('scripts/e2e-winvm-door-display.ts', 'utf8')

  it('starts its machine only through the scratch machine, behind the guard, and stops itself at 25 minutes', () => {
    expect(script).toMatch(/scratchMachine\(\{/)
    expect(script).not.toMatch(/new StandingMachine|startQemu|startTpm/)
    expect(script).toMatch(/DEADLINE_MS = 25 \* 60_000/)
    expect(readFileSync('scripts/lib/winvmScratch.ts', 'utf8')).toMatch(/export function scratchMachine\([^\n]*\): Scratch \{\n\s*requireScratchMachine\(\)/)
  })

  it('refuses an exe before it starts anything', () => {
    expect(script.indexOf('exeRefusal({')).toBeLessThan(script.indexOf('scratchMachine({'))
  })
})
