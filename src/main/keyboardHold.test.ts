import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { KeyInput } from './fullScreen'
import { followHold, HELD_KEY_CHANNEL, KeyboardHold, type HoldContents } from './keyboardHold'

function setup(platform: NodeJS.Platform = 'darwin') {
  const said: string[] = []
  const page = {
    ignoring: false,
    destroyed: false,
    isDestroyed: () => page.destroyed,
    setIgnoreMenuShortcuts: (ignore: boolean) => void (page.ignoring = ignore),
    send: (channel: string, what: unknown) => void said.push(`${channel} ${what}`)
  }
  const contents: HoldContents = page
  const state = { full: true, focused: true }
  const hold = new KeyboardHold(contents, () => state.full && state.focused, platform)
  return { page, state, hold, said }
}

const key = (over: Partial<KeyInput>): KeyInput => ({ type: 'keyDown', key: 'a', control: false, meta: false, alt: false, shift: false, ...over })
const cmdQ = key({ key: 'q', meta: true })

/** What ⌘Q does: the menu's Quit runs when the key reaches it (the page's way) and the menu's shortcuts are on. */
function quits(s: ReturnType<typeof setup>): boolean {
  return s.hold.heard(cmdQ) === 'page' && !s.page.ignoring
}

/** ⌃⌥ pressed with nothing else and let go. */
function ctrlOption(hold: KeyboardHold): void {
  hold.heard(key({ key: 'Control', code: 'ControlLeft', control: true }))
  hold.heard(key({ key: 'Alt', code: 'AltLeft', control: true, alt: true }))
  hold.heard(key({ type: 'keyUp', key: 'Alt', code: 'AltLeft', control: true }))
}

describe('the keyboard hold in full screen', () => {
  it('holds the keyboard only while the window is full screen and focused, and stands the menu down', () => {
    const s = setup()
    expect(s.hold.ask(true)).toBe(true)
    expect(s.page.ignoring).toBe(true)
    s.hold.letGo(false)
    s.state.full = false
    expect(s.hold.ask(true)).toBe(false)
    expect(s.page.ignoring).toBe(false)
    s.state.full = true
    s.state.focused = false
    expect(s.hold.ask(true)).toBe(false)
    expect(s.page.ignoring).toBe(false)
  })

  it('makes ⌘Q Alt+F4 while it holds the keyboard, and never quits', () => {
    const s = setup()
    s.hold.ask(true)
    expect(s.hold.heard(cmdQ)).toBe('closeWindow')
    expect(s.said).toEqual([`${HELD_KEY_CHANNEL} closeWindow`])
    expect(s.page.ignoring).toBe(true)
    // held down, it closes no second window
    expect(s.hold.heard({ ...cmdQ, isAutoRepeat: true })).toBe('drop')
    expect(s.said).toHaveLength(1)
  })

  it('lets ⌘Q quit whenever it does not hold the keyboard', () => {
    const s = setup()
    expect(quits(s)).toBe(true)
    // asked while the window is not full screen
    s.state.full = false
    s.hold.ask(true)
    expect(quits(s)).toBe(true)
    // held, then each way of letting go
    s.state.full = true
    for (const loseIt of [() => s.hold.ask(false), () => s.hold.letGo(), () => ctrlOption(s.hold), () => s.hold.heard(key({ key: 'f', control: true, meta: true }))]) {
      expect(s.hold.ask(true)).toBe(true)
      expect(quits(s)).toBe(false)
      loseIt()
      expect(quits(s)).toBe(true)
    }
    expect(s.said.filter((line) => line.endsWith('closeWindow'))).toHaveLength(4)
  })

  it('leaves ⌘Q to the menu off a Mac, where it is no chord', () => {
    const s = setup('win32')
    s.hold.ask(true)
    expect(s.hold.heard(cmdQ)).toBe('page')
  })

  it('hears ⌃⌘F whatever the hold, and lets go first', () => {
    const s = setup()
    const full = key({ key: 'f', control: true, meta: true })
    expect(s.hold.heard(full)).toBe('fullScreen')
    s.hold.ask(true)
    expect(s.hold.heard(full)).toBe('fullScreen')
    expect(s.hold.holding).toBe(false)
    expect(s.page.ignoring).toBe(false)
    expect(s.said).toEqual([`${HELD_KEY_CHANNEL} freed`])
  })

  it('frees the keyboard on ⌃⌥ pressed with nothing else and let go, and tells the page', () => {
    const s = setup()
    s.hold.ask(true)
    ctrlOption(s.hold)
    expect(s.hold.holding).toBe(false)
    expect(s.page.ignoring).toBe(false)
    expect(s.said).toEqual([`${HELD_KEY_CHANNEL} freed`])
    // the keys still reach the page, which lets go of what it sent
    expect(s.hold.heard(key({ type: 'keyUp', key: 'Control', control: false }))).toBe('page')
  })

  it('keeps the keyboard when another key comes between, or a third modifier is down', () => {
    const s = setup()
    s.hold.ask(true)
    s.hold.heard(key({ key: 'Control', control: true }))
    s.hold.heard(key({ key: 'Alt', control: true, alt: true }))
    s.hold.heard(key({ key: 'Delete', control: true, alt: true }))
    s.hold.heard(key({ type: 'keyUp', key: 'Alt', control: true }))
    expect(s.hold.holding).toBe(true)
    s.hold.heard(key({ key: 'Shift', shift: true }))
    s.hold.heard(key({ key: 'Control', control: true, shift: true }))
    s.hold.heard(key({ key: 'Alt', control: true, alt: true, shift: true }))
    s.hold.heard(key({ type: 'keyUp', key: 'Alt', control: true, shift: true }))
    expect(s.hold.holding).toBe(true)
  })

  it('off a Mac takes only the left Alt as the way out: the right one is AltGr', () => {
    const s = setup('win32')
    s.hold.ask(true)
    s.hold.heard(key({ key: 'Control', code: 'ControlLeft', control: true }))
    s.hold.heard(key({ key: 'Alt', code: 'AltRight', control: true, alt: true }))
    s.hold.heard(key({ type: 'keyUp', key: 'Alt', code: 'AltRight', control: true }))
    expect(s.hold.holding).toBe(true)
    ctrlOption(s.hold)
    expect(s.hold.holding).toBe(false)
  })

  it('lets go on a blur, a crash, a reload and leaving full screen, but not on the page’s own route change', () => {
    for (const [source, event, args] of [
      ['win', 'blur', []],
      ['win', 'leave-full-screen', []],
      ['contents', 'render-process-gone', [{}, { reason: 'crashed' }]],
      ['contents', 'did-start-navigation', [{ isMainFrame: true, isSameDocument: false }]]
    ] as const) {
      const s = setup()
      const win = new EventEmitter()
      const contents = new EventEmitter()
      followHold(s.hold, win, contents)
      s.hold.ask(true)
      ;(source === 'win' ? win : contents).emit(event, ...args)
      expect(s.hold.holding, event).toBe(false)
      expect(s.page.ignoring, event).toBe(false)
      expect(s.said, event).toEqual([`${HELD_KEY_CHANNEL} freed`])
    }
    const s = setup()
    const contents = new EventEmitter()
    followHold(s.hold, new EventEmitter(), contents)
    s.hold.ask(true)
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(s.hold.holding).toBe(true)
  })

  it('lets go when the page says its picture no longer holds the keyboard: a lost stream, Hand back', () => {
    const s = setup()
    s.hold.ask(true)
    expect(s.hold.ask(false)).toBe(false)
    expect(s.page.ignoring).toBe(false)
    // the page knows already: nothing is said back
    expect(s.said).toEqual([])
  })

  it('touches no page that is gone', () => {
    const s = setup()
    s.hold.ask(true)
    s.page.destroyed = true
    s.page.ignoring = true
    s.hold.letGo()
    expect(s.said).toEqual([])
    expect(s.hold.ask(true)).toBe(false)
  })
})
