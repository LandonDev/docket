import { describe, expect, it } from 'vitest'
import { STAGING_X, placeAt } from './xwm'

describe('the window manager’s places on a display of more pixels than the page', () => {
  it('reads a window’s X position back as the place it was asked for in the page’s units', () => {
    expect(placeAt(2000, 1)).toBe(2000)
    // the browser puts a window asked for at 2000 at 4000 on a display at scale 2
    expect(placeAt(4000, 2)).toBe(2000)
    expect(placeAt(4002, 2)).toBe(2001)
  })

  it('tells every place from its neighbours at scale 1.5, however the browser rounds the half pixel', () => {
    for (let at = STAGING_X; at < STAGING_X + 400; at++) {
      const exact = at * 1.5
      for (const x of [Math.floor(exact), Math.round(exact), Math.ceil(exact)]) expect(placeAt(x, 1.5)).toBe(at)
    }
  })

  it('leaves every window on the screen short of the places: none of the screen’s 2560 pixels at scale 2 reads as one', () => {
    expect(placeAt(2559, 2)).toBeLessThan(STAGING_X)
  })
})
