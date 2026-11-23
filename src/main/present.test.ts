import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))

const { createShows, planShow, showDisplays, DISPLAY_GONE_GRACE_MS } = await import('./present')
/** The frame names a show whose nonce is `n1` gets. */
const SHOW_FRAMES = { audience: 'tc-show-n1', presenter: 'tc-show-n1-presenter' }
type DisplayLike = import('./present').DisplayLike
type ShowWindow = import('./present').ShowWindow

const laptop: DisplayLike = { id: 1, label: 'Built-in', bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } }
const projector: DisplayLike = { id: 2, label: 'Projector', bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }
const third: DisplayLike = { id: 3, label: '', bounds: { x: -1280, y: 0, width: 1280, height: 720 }, workArea: { x: -1280, y: 0, width: 1280, height: 720 } }

function fakeWindow(log: string[], name: string): ShowWindow & { closed: boolean; fire(): void } {
  let onClosed = (): void => {}
  const w = {
    closed: false,
    isDestroyed: () => w.closed,
    setMenuBarVisibility: (on: boolean) => void log.push(`${name} menu ${on}`),
    show: () => void log.push(`${name} show`),
    setFullScreen: (on: boolean) => void log.push(`${name} full ${on}`),
    setSimpleFullScreen: (on: boolean) => void log.push(`${name} simple full ${on}`),
    close: () => {
      log.push(`${name} close`)
      w.fire()
    },
    on: (_event: 'closed', listener: () => void) => void (onClosed = listener),
    fire: () => {
      w.closed = true
      onClosed()
    }
  }
  return w
}

function shows(displays: DisplayLike[], own = 1, platform: NodeJS.Platform = 'linux') {
  const log: string[] = []
  const waits: Array<{ fn: () => void; ms: number }> = []
  let made = 0
  const live = createShows({
    platform,
    nonce: () => `n${++made}`,
    displays: () => displays,
    ownDisplay: () => own,
    keepAwake: () => {
      log.push('awake')
      return () => void log.push('sleep')
    },
    keepLive: (sender) => {
      log.push(`live ${sender}`)
      return () => void log.push(`throttled ${sender}`)
    },
    tell: (sender, channel) => void log.push(`tell ${sender} ${channel}`),
    later: (fn, ms) => void waits.push({ fn, ms })
  })
  return { live, log, waits }
}

describe('where a show goes', () => {
  it('one display: the slideshow fills it and there is no presenter\'s view', () => {
    const plan = planShow([laptop], 1, { mode: 'full' })
    expect(plan.audience).toMatchObject({ x: 0, y: 0, width: 1440, height: 900, frame: false, fullscreenable: true, show: false, backgroundColor: '#000000' })
    expect(plan.presenter).toBeNull()
    expect(plan.display).toBe(1)
  })

  it('one display, presenter view: the presenter\'s view alone, in his work area', () => {
    const plan = planShow([laptop], 1, { mode: 'presenter' })
    expect(plan.audience).toBeNull()
    expect(plan.presenter).toMatchObject({ x: 0, y: 25, width: 1440, height: 875 })
    expect(plan.presenter!.fullscreen).toBeUndefined()
  })

  it('two displays: the slideshow full screen on the other, the presenter\'s view on his own', () => {
    for (const mode of ['full', 'presenter'] as const) {
      const plan = planShow([laptop, projector], 1, { mode })
      expect(plan.audience).toMatchObject({ x: 1440, y: 0, width: 1920, height: 1080, frame: false })
      expect(plan.presenter).toMatchObject({ x: 0, y: 25, width: 1440, height: 875 })
      expect(plan.display).toBe(2)
    }
  })

  it('the display he picks takes the slideshow; picking his own sends the presenter\'s view to the other', () => {
    expect(planShow([laptop, projector, third], 1, { mode: 'full', display: 3 })).toMatchObject({ display: 3, audience: { x: -1280 }, presenter: { x: 0 } })
    expect(planShow([laptop, projector], 1, { mode: 'full', display: 1 })).toMatchObject({ display: 1, audience: { x: 0, frame: false }, presenter: { x: 1440 } })
    // a display that is gone since the menu was drawn: the other one, as by default
    expect(planShow([laptop, projector], 1, { mode: 'full', display: 9 }).display).toBe(2)
  })

  it('in a window: the slideshow and the presenter\'s view side by side on his own display, shrunk to fit a small one', () => {
    const plan = planShow([laptop, projector], 1, { mode: 'windowed' })
    expect(plan.display).toBeNull()
    expect(plan.audience).toMatchObject({ x: 20, y: 172, width: 640, height: 360 })
    expect(plan.presenter).toMatchObject({ x: 676, y: 172, width: 744, height: 582 })
    expect(plan.audience!.frame).toBeUndefined()
    const small = planShow([{ id: 1, bounds: { x: 0, y: 0, width: 1024, height: 600 }, workArea: { x: 0, y: 0, width: 1024, height: 600 } }], 1, { mode: 'windowed' })
    const a = small.audience as { x: number; width: number; height: number }
    const p = small.presenter as { x: number; width: number; height: number }
    expect(a.width + p.width + 16).toBeLessThanOrEqual(1024)
    expect(p.height).toBeLessThanOrEqual(600)
    expect(a.width / a.height).toBeCloseTo(16 / 9, 1)
  })

  it('a child window has none of the main window\'s preload or slot, and is never throttled', () => {
    const plan = planShow([laptop, projector], 1, { mode: 'full' })
    for (const options of [plan.audience!, plan.presenter!]) expect(options.webPreferences).toEqual({ preload: undefined, additionalArguments: [], backgroundThrottling: false })
  })

  it('lists the displays for the menu, his own first, an unnamed one by its number', () => {
    expect(showDisplays([third, laptop, projector], 1)).toEqual([
      { id: 1, label: 'Built-in', own: true },
      { id: 3, label: 'Display 1', own: false },
      { id: 2, label: 'Projector', own: false }
    ])
  })
})

describe('a show\'s windows', () => {
  it('opens each frame once, only while a show runs, and only as an empty page', () => {
    const { live } = shows([laptop, projector])
    const open = (frameName: string, url = 'about:blank') => live.opens(7, { url, frameName })
    expect(open(SHOW_FRAMES.audience)).toBeNull()
    // The names are made for this one show: nothing else in the page can know them beforehand.
    expect(live.begin(7, { mode: 'full' })).toEqual(SHOW_FRAMES)
    expect(open('tc-show')).toBeNull()
    expect(open(SHOW_FRAMES.audience, 'https://example.test/')).toBeNull()
    expect(open('other')).toBeNull()
    expect(live.opens(8, { url: 'about:blank', frameName: SHOW_FRAMES.audience })).toBeNull()
    expect(open(SHOW_FRAMES.audience)).toMatchObject({ frame: false })
    expect(open(SHOW_FRAMES.presenter)).toMatchObject({ x: 0 })
    const log: string[] = []
    live.created(7, SHOW_FRAMES.audience, fakeWindow(log, 'audience'))
    // shown first, then taken full screen: a window is never made full screen while hidden
    expect(log).toEqual(['audience menu false', 'audience show', 'audience full true'])
    // the frame is taken: a second window under its name is refused
    expect(open(SHOW_FRAMES.audience)).toBeNull()
  })

  it('keeps the display awake and the asking page drawing for the show\'s life, and lets go and closes its windows at the end', () => {
    const { live, log } = shows([laptop, projector])
    live.begin(7, { mode: 'full' })
    expect(log).toEqual(['awake', 'live 7'])
    const audience = fakeWindow(log, 'audience')
    const presenter = fakeWindow(log, 'presenter')
    live.created(7, SHOW_FRAMES.audience, audience)
    live.created(7, SHOW_FRAMES.presenter, presenter)
    log.length = 0
    live.end(7)
    expect(log).toEqual(['sleep', 'throttled 7', 'audience close', 'presenter close'])
    expect(live.running(7)).toBe(false)
    live.end(7)
    expect(log).toHaveLength(4)
  })

  it('a second show from the same page ends the first, and the first show\'s frame names open nothing more', () => {
    const { live, log } = shows([laptop])
    expect(live.begin(7, { mode: 'full' })).toEqual({ audience: 'tc-show-n1', presenter: null })
    expect(live.begin(7, { mode: 'presenter' })).toEqual({ audience: null, presenter: 'tc-show-n2-presenter' })
    expect(log).toEqual(['awake', 'live 7', 'sleep', 'throttled 7', 'awake', 'live 7'])
    expect(live.opens(7, { url: 'about:blank', frameName: 'tc-show-n1' })).toBeNull()
    expect(live.opens(7, { url: 'about:blank', frameName: 'tc-show-n2' })).toBeNull()
    expect(live.opens(7, { url: 'about:blank', frameName: 'tc-show-n2-presenter' })).not.toBeNull()
  })

  it('on a Mac the slideshow is laid over its display with no Space of its own', () => {
    const { live, log } = shows([laptop, projector], 1, 'darwin')
    live.begin(7, { mode: 'full' })
    log.length = 0
    live.created(7, SHOW_FRAMES.audience, fakeWindow(log, 'audience'))
    live.created(7, SHOW_FRAMES.presenter, fakeWindow(log, 'presenter'))
    expect(log).toEqual(['audience menu false', 'audience show', 'audience simple full true', 'presenter menu false', 'presenter show'])
  })

  it('a display removed mid-show closes the slideshow on it and keeps the presenter\'s view', () => {
    const { live, log, waits } = shows([laptop, projector])
    live.begin(7, { mode: 'full' })
    const audience = fakeWindow(log, 'audience')
    const presenter = fakeWindow(log, 'presenter')
    live.created(7, SHOW_FRAMES.audience, audience)
    live.created(7, SHOW_FRAMES.presenter, presenter)
    log.length = 0
    live.displayRemoved(1)
    expect(log).toEqual([])
    live.displayRemoved(2)
    expect(log).toEqual(['tell 7 show:display-gone'])
    expect(waits.map((w) => w.ms)).toEqual([DISPLAY_GONE_GRACE_MS])
    // the page did not close it in time: main does, and only that window
    waits[0].fn()
    expect(log).toEqual(['tell 7 show:display-gone', 'audience close'])
    expect(presenter.closed).toBe(false)
    expect(live.running(7)).toBe(true)
    // a window the page already closed is left alone
    live.displayRemoved(2)
    expect(log).toHaveLength(2)
  })

  it('the window a display took with it is the one closed, though the page has started another show by then', () => {
    const { live, log, waits } = shows([laptop, projector])
    live.begin(7, { mode: 'full' })
    const first = fakeWindow(log, 'first')
    live.created(7, SHOW_FRAMES.audience, first)
    live.displayRemoved(2)
    live.begin(7, { mode: 'full' })
    const second = fakeWindow(log, 'second')
    live.created(7, 'tc-show-n2', second)
    first.closed = true
    log.length = 0
    waits[0].fn()
    expect(log).toEqual([])
    expect(second.closed).toBe(false)
  })

  it('in a window, neither window is taken full screen', () => {
    const { live, log } = shows([laptop, projector])
    live.begin(7, { mode: 'windowed' })
    log.length = 0
    live.created(7, SHOW_FRAMES.audience, fakeWindow(log, 'audience'))
    live.created(7, SHOW_FRAMES.presenter, fakeWindow(log, 'presenter'))
    expect(log).toEqual(['audience menu false', 'audience show', 'presenter menu false', 'presenter show'])
  })

  it('a window he closes leaves the show\'s list, so the frame can open again', () => {
    const { live, log } = shows([laptop, projector])
    live.begin(7, { mode: 'windowed' })
    const audience = fakeWindow(log, 'audience')
    live.created(7, SHOW_FRAMES.audience, audience)
    audience.fire()
    expect(live.opens(7, { url: 'about:blank', frameName: SHOW_FRAMES.audience })).not.toBeNull()
  })
})
