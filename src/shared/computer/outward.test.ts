import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHAT_APP_BUNDLES,
  CHAT_APP_NAMES,
  OUTWARD_VERBS,
  clicksBlind,
  cutFields,
  heldTargets,
  landsByPosition,
  namedKeysUnplaced,
  needsFreshRead,
  outwardVerb,
  pointerAfter,
  readOutward,
  restage,
  screenMark,
  screenOfBook,
  screenOfObservation,
  type BookLike,
  type Screen
} from './outward'
import type { ComputerAction } from './protocol'
import { sha256Hex } from '../sha256'
import { cutValue } from './observation'

const FIXTURES = join(__dirname, '../../main/server/computer/fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8').replace(/\n$/, '')

const step = (a: Record<string, unknown>): ComputerAction => a as unknown as ComputerAction
const steps = (...a: Record<string, unknown>[]): ComputerAction[] => a.map(step)

const SLACK = { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' }
const TEAMS = { bundleId: 'com.microsoft.teams2', name: 'Microsoft Teams' }
const MESSAGES = { bundleId: 'com.apple.MobileSMS', name: 'Messages' }
const MAIL = { bundleId: 'com.apple.mail', name: 'Mail' }
const TEXTEDIT = { bundleId: 'com.apple.TextEdit', name: 'TextEdit' }
const CHROME = { bundleId: 'com.google.Chrome', name: 'Google Chrome' }
const FINDER = { bundleId: 'com.apple.finder', name: 'Finder' }
const EDGE_WIN = { bundleId: 'msedge.exe', name: 'Microsoft Edge' }

const screen = (text: string, app: Screen['app']): Screen => {
  const s = screenOfObservation(text, app)
  if (!s) throw new Error(`fixture off the grammar:\n${text}`)
  return s
}

/** A chat box with no button at all: Messages sends on Return. */
const chatBox = (app: Screen['app']): Screen =>
  screen(
    `app "${app.name}" · window "Dana" · 1280×800 · focused [4]
[1] window "Dana"
  [2] scroll area
    [3] text = "See you at 5"
  [4] text area "Message" = "On my way" focused caret 9`,
    app
  )

/** Slack's composer: a Send button with an icon in it, no frames. */
const SLACK_TEXT = `app "Slack" · window "general" · 1280×800 · focused [4]
[1] window "general"
  [2] group "Composer"
    [3] button "Attach"
    [4] text area "Message to #general" = "ship it" focused caret 7
    [5] button "Send now"
      [6] image "paperplane"
    [7] text = "Send"
  [8] button "Search"`

/** A mail compose window read with frames. */
const COMPOSE_TEXT = `app "Mail" · window "New Message" · 800×600 · focused [5]
[1] window "New Message" @0,0 800×600
  [2] toolbar @0,0 800×52
    [3] button "Send" @20,12 40×28
      [4] image "paperplane" @28,16 24×20
    [7] button @100,12 40×28
  [5] input "To:" = "dana@example.com" focused caret 16 @0,60 800×24
  [6] text area "Body" = "Hi" @0,100 800×500`

/** The same compose window read without frames. */
const COMPOSE_NO_FRAMES = COMPOSE_TEXT.replace(/ @-?\d+,-?\d+ \d+×\d+/g, '')

describe('outwardVerb', () => {
  it('finds every verb of the list said alone', () => {
    for (const verb of OUTWARD_VERBS) expect(outwardVerb(verb)).toBe(verb)
  })

  it('finds the verb with a few words after it, and the longest verb that fits', () => {
    expect(outwardVerb('Send now')).toBe('send now')
    expect(outwardVerb('Reply to all')).toBe('reply')
    expect(outwardVerb('Reply all')).toBe('reply all')
    expect(outwardVerb('Pay $12.00')).toBe('pay')
    expect(outwardVerb('Delete draft…')).toBe('delete')
    expect(outwardVerb('Place order')).toBe('place order')
    expect(outwardVerb('Send message to Dana Lee')).toBe('send')
  })

  it('ignores case, an ellipsis and punctuation around the name', () => {
    expect(outwardVerb('SEND')).toBe('send')
    expect(outwardVerb('Send…')).toBe('send')
    expect(outwardVerb('Send...')).toBe('send')
    expect(outwardVerb('  Send! ')).toBe('send')
    expect(outwardVerb('Send (⌘↩)')).toBe('send')
    expect(outwardVerb('Send · Ctrl+Enter')).toBe('send')
  })

  it('lets through the names that start like a verb and are not one', () => {
    for (const name of ['Sign in', 'Sign In to Chrome?', 'Sign up', 'Order by date', 'Send to Back', 'Send Backward', 'Share screen', 'Share my screen', 'Posts', 'Comments', 'Signs', 'Forward Delete', 'Remove formatting', 'Delete word'])
      expect(outwardVerb(name), name).toBeNull()
  })

  it('does not read a verb inside a longer word', () => {
    expect(outwardVerb('Resend')).toBeNull()
    expect(outwardVerb('Unsend')).toBeNull()
    expect(outwardVerb('Sender')).toBeNull()
    expect(outwardVerb('Shared with you')).toBeNull()
    expect(outwardVerb('Deleted Items')).toBeNull()
    expect(outwardVerb('Postpone')).toBeNull()
  })

  it('answers null for no name, an empty name and a name of punctuation alone', () => {
    expect(outwardVerb(undefined)).toBeNull()
    expect(outwardVerb(null)).toBeNull()
    expect(outwardVerb('')).toBeNull()
    expect(outwardVerb('…')).toBeNull()
  })

  it('takes no more words after the verb than it is allowed', () => {
    // A named target or a button may run on twelve words past its verb.
    expect(outwardVerb('Order confirmation for your recent purchase from Example Shop')).toBe('order')
    expect(outwardVerb('Send message to Dana Lee and 3 others')).toBe('send')
    expect(outwardVerb('Order confirmation for your recent purchase from Example Shop, shipped today to your home')).toBeNull()
    expect(outwardVerb('Send now', OUTWARD_VERBS, 0)).toBe('send now')
    expect(outwardVerb('Send it', OUTWARD_VERBS, 0)).toBeNull()
    expect(outwardVerb('Send it', OUTWARD_VERBS, 1)).toBe('send')
  })

  it('reads a long content-like name on a row as content while a button with a short name counts', () => {
    const s = screen(
      `app "Mail" · window "Inbox" · 1280×800
[1] window "Inbox"
  [2] table "messages"
    [3] row "Order confirmation for your recent purchase"
    [4] row "Order"
    [5] cell "Pay your invoice"
  [6] text "Send the report by Friday"
  [7] button "Order now"`,
      MAIL
    )
    expect(readOutward(steps({ action: 'left_click', element: 3 }), s)).toBeNull()
    expect(readOutward(steps({ action: 'left_click', element: 5 }), s)).toBeNull()
    expect(readOutward(steps({ action: 'left_click', element: 6 }), s)).toBeNull()
    expect(readOutward(steps({ action: 'left_click', element: 7 }), s)).toMatchObject({ why: 'control', label: 'Order' })
    // A row or a cell whose name is the bare verb counts.
    expect(readOutward(steps({ action: 'left_click', element: 4 }), s)).toMatchObject({ label: 'Order', on: 'row "Order"' })
  })
})

describe('screenOfObservation', () => {
  it('reads roles, names, values, states, parents and the focus from a hand-written full read', () => {
    const s = screen(SLACK_TEXT, SLACK)
    expect(s.focused).toBe(4)
    expect(s.app).toEqual(SLACK)
    expect(s.elements.get(4)).toEqual({ index: 4, role: 'text area', name: 'Message to #general', value: 'ship it', states: ['focused'], actions: [], parent: 2 })
    expect(s.elements.get(6)).toMatchObject({ role: 'image', name: 'paperplane', parent: 5 })
    expect(s.elements.get(7)).toMatchObject({ role: 'text', value: 'Send', parent: 2 })
    expect(s.elements.get(7)?.name).toBeUndefined()
    expect(s.elements.get(8)).toMatchObject({ parent: 1 })
    expect(s.elements.get(1)).toMatchObject({ role: 'window', parent: null })
  })

  it('keeps frames when the read carries them and none when it does not', () => {
    expect(screen(COMPOSE_TEXT, MAIL).elements.get(3)?.frame).toEqual({ x: 20, y: 12, w: 40, h: 28 })
    expect(screen(COMPOSE_NO_FRAMES, MAIL).elements.get(3)?.frame).toBeUndefined()
  })

  it('answers null for a text off the grammar', () => {
    expect(screenOfObservation('not an observation', MAIL)).toBeNull()
    expect(screenOfObservation('', MAIL)).toBeNull()
  })

  it('reads the recorded TextEdit fixture: ranges keep their indices and their parent', () => {
    const s = screen(fixture('observations/full.txt'), TEXTEDIT)
    expect(s.focused).toBe(3)
    expect(s.elements.size).toBe(40)
    expect(s.elements.get(3)).toMatchObject({ role: 'text area', parent: 2, states: ['focused'] })
    for (let i = 5; i <= 19; i++) expect(s.elements.get(i)).toMatchObject({ role: 'ruler marker', parent: 4 })
    expect(s.elements.get(21)).toMatchObject({ role: 'checkbox', name: 'bold', parent: 20 })
    expect(s.elements.get(37)).toMatchObject({ role: 'button', name: 'close', parent: 1 })
  })

  it('reads the recorded geometry fixture with its frames, the menu at the top level', () => {
    const s = screen(fixture('observations/geometry.txt'), TEXTEDIT)
    expect(s.elements.get(1)?.frame).toEqual({ x: 0, y: 0, w: 1280, h: 1072 })
    expect(s.elements.get(45)).toMatchObject({ role: 'menu', name: 'Format', parent: 1, frame: { x: -12, y: 40, w: 200, h: 300 } })
    expect(s.elements.get(46)).toMatchObject({ role: 'menu item', name: 'Bold', parent: 45 })
  })

  it('reads the recorded menu bar fixture', () => {
    const s = screen(fixture('observations/menus.txt'), TEXTEDIT)
    expect(s.focused).toBe(48)
    expect(s.elements.get(41)).toMatchObject({ role: 'menu bar', parent: null })
    expect(s.elements.get(50)).toMatchObject({ role: 'menu item', name: 'Make Plain Text', states: ['disabled'], parent: 47 })
  })

  it('reads the recorded Chrome form and the Save sheet', () => {
    const chrome = screen(fixture('apps/chrome/form/observation.txt'), CHROME)
    expect(chrome.elements.get(28)).toMatchObject({ role: 'button', name: 'Submit', parent: 14 })
    expect(chrome.elements.get(9)).toMatchObject({ role: 'input', name: 'Address and search bar' })
    const sheet = screen(fixture('apps/textedit/save-sheet/observation.txt'), TEXTEDIT)
    expect(sheet.focused).toBeNull()
    expect(sheet.elements.get(51)).toMatchObject({ role: 'button', name: 'Save', parent: 39 })
  })
})

describe('screenOfBook', () => {
  const book = (lines: Record<number, [string, number | null]>, focused: number | null): BookLike => ({
    size: Object.keys(lines).length,
    focused,
    brief: (i) => (lines[i] ? { index: i, line: lines[i]![0] } : null),
    path: (i) => {
      const out: { index: number; line: string }[] = []
      for (let p = lines[i]?.[1] ?? null; p !== null; p = lines[p]?.[1] ?? null) out.push({ index: p, line: lines[p]![0] })
      return out
    }
  })

  it('reads one-word roles, names, values and parents from sparse indices', () => {
    const s = screenOfBook(
      book({ 3: ['window "Inbox"', null], 10: ['group "Compose"', 3], 57: ['button "Send"', 10], 58: ['input "To:" = "dana@example.com"', 10] }, 58),
      MAIL
    )
    expect(s.focused).toBe(58)
    expect(s.elements.size).toBe(4)
    expect(s.elements.get(57)).toEqual({ index: 57, role: 'button', name: 'Send', states: [], actions: [], parent: 10 })
    expect(s.elements.get(58)).toMatchObject({ role: 'input', name: 'To:', value: 'dana@example.com', parent: 10 })
    expect(s.elements.get(3)?.parent).toBeNull()
    expect(readOutward(steps({ action: 'left_click', element: 57 }), s)).toMatchObject({ label: 'Send' })
  })

  it('keeps the role alone for a line whose quoted string does not parse', () => {
    const s = screenOfBook(book({ 1: ['button "bad \\x"', null] }, null), MAIL)
    expect(s.elements.get(1)).toMatchObject({ role: 'button' })
    expect(s.elements.get(1)?.name).toBeUndefined()
  })

  it('reads a role of two words with its name, so a book menu item or menu button "Send" is held', () => {
    const s = screenOfBook(
      book({ 1: ['window "Mail"', null], 2: ['menu item "Send"', 1], 3: ['text area "Message" = "hi" focused caret 2 actions: show menu', 1], 4: ['menu button "Send"', 1] }, 3),
      MAIL
    )
    expect(s.elements.get(2)).toMatchObject({ role: 'menu item', name: 'Send' })
    expect(s.elements.get(3)).toMatchObject({ role: 'text area', name: 'Message', value: 'hi', states: ['focused'], actions: ['show menu'] })
    expect(readOutward(steps({ action: 'left_click', element: 2 }), s)).toMatchObject({ label: 'Send', on: 'menu item "Send"' })
    expect(readOutward(steps({ action: 'left_click', element: 4 }), s)).toMatchObject({ label: 'Send', on: 'menu button "Send"' })
  })

  it('holds Return in Slack\'s message box read from the book', () => {
    const s = screenOfBook(book({ 1: ['window "general"', null], 2: ['text area "Message" = "hi" focused', 1] }, 2), SLACK)
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toMatchObject({ why: 'key', label: 'Send', on: 'Return in text area "Message"' })
  })

  it('keeps state words from the book, and holds a click on a Send it shows disabled: the call may have enabled it', () => {
    const s = screenOfBook(book({ 1: ['window "Mail"', null], 2: ['button "Send" disabled', 1] }, null), MAIL)
    expect(s.elements.get(2)?.states).toEqual(['disabled'])
    expect(readOutward(steps({ action: 'left_click', element: 2 }), s)).toMatchObject({ why: 'control', label: 'Send' })
  })
})

describe('readOutward: clicks', () => {
  const slack = screen(SLACK_TEXT, SLACK)
  const compose = screen(COMPOSE_TEXT, MAIL)
  const composeBare = screen(COMPOSE_NO_FRAMES, MAIL)

  it('holds an unflagged click on a Send button by its index, and not a click on the button beside it', () => {
    expect(readOutward(steps({ action: 'left_click', element: 5 }), slack)).toEqual({ step: 0, why: 'control', label: 'Send now', on: 'button "Send now"' })
    expect(readOutward(steps({ action: 'left_click', element: 3 }), slack)).toBeNull()
    expect(readOutward(steps({ action: 'double_click', element: 5 }), slack)).toMatchObject({ label: 'Send now' })
  })

  it('holds a click on an image inside a Send button through the button, and on a plain text "Send" by its value', () => {
    expect(readOutward(steps({ action: 'left_click', element: 6 }), slack)).toMatchObject({ why: 'control', label: 'Send now', on: 'button "Send now"' })
    // A line of text prints its string as its value: that is its name.
    expect(readOutward(steps({ action: 'left_click', element: 7 }), slack)).toMatchObject({ label: 'Send', on: 'text' })
  })

  it('holds a click by position inside the frame of a Send button when the read has frames', () => {
    expect(readOutward(steps({ action: 'left_click', coordinate: [30, 20] }), compose)).toEqual({ step: 0, why: 'position', label: 'Send', on: 'button "Send"' })
    expect(readOutward(steps({ action: 'left_click', coordinate: [400, 300] }), compose)).toBeNull()
  })

  it('KNOWN LIMIT: a click by position on Send is not held when the screen carries no frames', () => {
    expect(readOutward(steps({ action: 'left_click', coordinate: [30, 20] }), composeBare)).toBeNull()
  })

  it('KNOWN LIMIT: a click by position on a button with no name is not held', () => {
    expect(readOutward(steps({ action: 'left_click', coordinate: [110, 20] }), compose)).toBeNull()
  })

  it('holds perform press on a link "Submit", and not perform show menu on it', () => {
    const s = screen(`app "Google Chrome" · window "Form" · 800×600\n[1] window "Form"\n  [2] web area "Form"\n    [3] link "Submit"`, CHROME)
    expect(readOutward(steps({ action: 'perform', name: 'press', element: 3 }), s)).toMatchObject({ why: 'control', label: 'Submit', on: 'link "Submit"' })
    expect(readOutward(steps({ action: 'perform', name: 'show menu', element: 3 }), s)).toBeNull()
    expect(readOutward(steps({ action: 'perform', name: 'scroll to visible', element: 3 }), s)).toBeNull()
  })

  it('holds a click on a target by name or by menu path even with no screen', () => {
    expect(readOutward(steps({ action: 'left_click', named: 'Send' }), null)).toEqual({ step: 0, why: 'control', label: 'Send', on: '"Send"' })
    expect(readOutward(steps({ action: 'left_click', menu: 'Message > Send' }), null)).toEqual({ step: 0, why: 'menu', label: 'Send', on: 'menu item "Send"' })
    expect(readOutward(steps({ action: 'perform', name: 'pick', menu: 'Message › Reply All' }), null)).toMatchObject({ why: 'menu', label: 'Reply all' })
    expect(readOutward(steps({ action: 'left_click', named: 'Cancel' }), null)).toBeNull()
    expect(readOutward(steps({ action: 'left_click', menu: 'File > Save…' }), null)).toBeNull()
  })

  it('holds a targetless click after a move onto Send in the same call, and not after a move elsewhere', () => {
    expect(readOutward(steps({ action: 'mouse_move', element: 5 }, { action: 'left_click' }), slack)).toEqual({ step: 1, why: 'position', label: 'Send now', on: 'button "Send now"' })
    expect(readOutward(steps({ action: 'mouse_move', coordinate: [30, 20] }, { action: 'left_mouse_down' }, { action: 'left_mouse_up' }), compose)).toMatchObject({ step: 1, label: 'Send' })
    expect(readOutward(steps({ action: 'mouse_move', element: 3 }, { action: 'left_click' }), slack)).toBeNull()
  })

  it('holds a targetless click when an earlier call left the pointer on Send', () => {
    expect(readOutward(steps({ action: 'left_click' }), slack, { element: 5 })).toMatchObject({ step: 0, why: 'position', label: 'Send now' })
    expect(readOutward(steps({ action: 'left_click' }), compose, { coordinate: [30, 20] })).toMatchObject({ label: 'Send' })
    expect(readOutward(steps({ action: 'left_click' }), slack, { element: 3 })).toBeNull()
    expect(readOutward(steps({ action: 'left_click' }), slack, null)).toBeNull()
  })

  it('holds a click on a Send the read shows disabled, by index and by position', () => {
    const s = screen(`app "Mail" · window "New Message" · 800×600\n[1] window "New Message"\n  [2] button "Send" disabled @20,12 40×28`, MAIL)
    expect(readOutward(steps({ action: 'left_click', element: 2 }), s)).toMatchObject({ why: 'control', label: 'Send' })
    expect(readOutward(steps({ action: 'left_click', coordinate: [30, 20] }), s)).toMatchObject({ why: 'position', label: 'Send' })
  })

  it('counts a disabled Submit beside a field on Return only after the call itself typed', () => {
    const s = screen(
      `app "Google Chrome" · window "Feedback" · 800×600 · focused [4]\n[1] window "Feedback"\n  [2] web area "Feedback"\n    [3] group "Feedback form"\n      [4] input "Your email" focused caret 0\n      [5] button "Submit" disabled`,
      CHROME
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toBeNull()
    expect(readOutward(steps({ action: 'type', text: 'dana@example.com' }, { action: 'key', text: 'Return' }), s)).toMatchObject({ step: 1, label: 'Submit' })
    expect(readOutward(steps({ action: 'set_value', element: 4, value: 'x' }, { action: 'key', text: 'Return' }), s)).toMatchObject({ step: 1, label: 'Submit' })
  })

  it('holds a plain Accept inside a web cookie banner by decision, and lets through a button that itself says cookies', () => {
    const banner = screen(
      `app "Google Chrome" · window "News" · 800×600\n[1] window "News"\n  [2] web area "News"\n    [3] dialog "Privacy"\n      [4] text = "We use cookies to improve your visit."\n      [5] button "Accept"\n      [6] button "Accept all cookies"\n      [7] button "Reject cookies"`,
      CHROME
    )
    expect(readOutward(steps({ action: 'left_click', element: 5 }), banner)).toMatchObject({ label: 'Accept', on: 'button "Accept"' })
    expect(readOutward(steps({ action: 'left_click', element: 6 }), banner)).toBeNull()
    expect(readOutward(steps({ action: 'left_click', element: 7 }), banner)).toBeNull()
  })

  it('holds a dialog\'s Accept', () => {
    const invite = screen(`app "Calendar" · window "Invite" · 800×600\n[1] window "Invite"\n  [2] dialog "Invitation"\n    [3] text = "Lunch with Dana, Friday 12:30"\n    [4] button "Accept"`, { bundleId: 'com.apple.iCal', name: 'Calendar' })
    expect(readOutward(steps({ action: 'left_click', element: 4 }), invite)).toMatchObject({ label: 'Accept', on: 'button "Accept"' })
  })

  it('lets a browser toolbar\'s Forward beside Back through and holds Mail\'s Forward', () => {
    const browser = screen(`app "Google Chrome" · window "News" · 800×600\n[1] window "News"\n  [2] toolbar\n    [3] button "Back"\n    [4] button "Forward"`, CHROME)
    const mail = screen(`app "Mail" · window "Inbox" · 800×600\n[1] window "Inbox"\n  [2] toolbar\n    [3] button "Reply"\n    [4] button "Forward"`, MAIL)
    expect(readOutward(steps({ action: 'left_click', element: 4 }), browser)).toBeNull()
    expect(readOutward(steps({ action: 'left_click', element: 4 }), mail)).toMatchObject({ label: 'Forward' })
  })

  it('does not hold a right click or a scroll on Send', () => {
    expect(readOutward(steps({ action: 'right_click', element: 5 }), slack)).toBeNull()
    expect(readOutward(steps({ action: 'scroll', element: 5, scroll_direction: 'down', scroll_amount: 3 }), slack)).toBeNull()
    expect(readOutward(steps({ action: 'middle_click', element: 5 }), slack)).toBeNull()
  })

  it('reports the step that sends, counted from 0', () => {
    const read = readOutward(steps({ action: 'left_click', element: 4 }, { action: 'type', text: 'ship it' }, { action: 'left_click', element: 5 }), slack)
    expect(read).toMatchObject({ step: 2, label: 'Send now' })
  })

  it('does not take a field\'s label for what a click on it does', () => {
    const s = screen(`app "Mail" · window "New Message" · 800×600\n[1] window "New Message"\n  [2] input "Send to:" = "dana@example.com"`, MAIL)
    expect(readOutward(steps({ action: 'left_click', element: 2 }), s)).toBeNull()
  })

  it('reads the recorded Chrome form: a click on Submit is held, one on Review order is not', () => {
    const s = screen(fixture('apps/chrome/form/observation.txt'), CHROME)
    expect(readOutward(steps({ action: 'left_click', element: 28 }), s)).toMatchObject({ label: 'Submit' })
    expect(readOutward(steps({ action: 'left_click', element: 29 }), s)).toBeNull()
    // "Sign In to Chrome?" starts like Sign and is not.
    expect(readOutward(steps({ action: 'left_click', element: 11 }), s)).toBeNull()
  })

  it('reads the recorded Save sheet: Delete is held as a click, Save and Cancel are not', () => {
    const s = screen(fixture('apps/textedit/save-sheet/observation.txt'), TEXTEDIT)
    expect(readOutward(steps({ action: 'left_click', element: 49 }), s)).toMatchObject({ label: 'Delete' })
    expect(readOutward(steps({ action: 'left_click', element: 51 }), s)).toBeNull()
    expect(readOutward(steps({ action: 'left_click', element: 50 }), s)).toBeNull()
  })
})

describe('readOutward: Return, typed line breaks and confirm', () => {
  it('holds Return in the message box of Slack, Teams and Messages, by bundle id and by name alone, and not in Mail', () => {
    for (const app of [SLACK, TEAMS, MESSAGES]) {
      expect(readOutward(steps({ action: 'key', text: 'Return' }), chatBox(app)), app.name).toMatchObject({ why: 'key', label: 'Send', on: 'Return in text area "Message"' })
      expect(readOutward(steps({ action: 'key', text: 'Return' }), chatBox({ bundleId: null, name: app.name })), app.name).toMatchObject({ label: 'Send' })
    }
    // A mail is written over many lines: plain Return there is a new line.
    expect(readOutward(steps({ action: 'key', text: 'Return' }), chatBox(MAIL))).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'Return' }), chatBox({ bundleId: null, name: 'Mail' }))).toBeNull()
    expect(CHAT_APP_BUNDLES).toContain('com.apple.MobileSMS')
    expect(CHAT_APP_NAMES).toContain('slack')
  })

  it('does not hold Return in TextEdit\'s document, recorded or hand-written', () => {
    expect(readOutward(steps({ action: 'key', text: 'Return' }), chatBox(TEXTEDIT))).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'Return' }), screen(fixture('observations/full.txt'), TEXTEDIT))).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'Return' }), screen(fixture('apps/textedit/doc/observation.txt'), TEXTEDIT))).toBeNull()
  })

  it('does not hold Return in a chat app\'s search field', () => {
    const s = screen(`app "Slack" · window "general" · 800×600 · focused [2]\n[1] window "general"\n  [2] search "Search" = "budget" focused caret 6`, SLACK)
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toBeNull()
  })

  const browser = (url: string): Screen =>
    screen(
      `app "Google Chrome" · window "Chat" · 1280×800 · focused [6]
[1] window "Chat"
  [2] toolbar
    [3] input "Address and search bar" = ${JSON.stringify(url)}
  [4] scroll area
    [5] web area "Chat"
      [6] text area "Message" = "hi" focused caret 2`,
      CHROME
    )

  it('holds Return in a browser on a chat host, a subdomain of one too, and not on a mail host or another site', () => {
    expect(readOutward(steps({ action: 'key', text: 'Return' }), browser('app.slack.com/client/T1/C1'))).toMatchObject({ label: 'Send' })
    expect(readOutward(steps({ action: 'key', text: 'Return' }), browser('https://mail.google.com/mail/u/0/#inbox'))).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'super+Return' }), browser('https://mail.google.com/mail/u/0/#inbox'))).toMatchObject({ why: 'chord', label: 'Send' })
    expect(readOutward(steps({ action: 'key', text: 'Return' }), browser('www.linkedin.com/messaging/'))).toMatchObject({ label: 'Send' })
    expect(readOutward(steps({ action: 'key', text: 'Return' }), browser('docs.example.com/notes'))).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'Return' }), browser('notx.com'))).toBeNull()
  })

  it("reads Edge on Windows, named by its exe, as a browser: a chat host's Return is held (§29.2)", () => {
    const edge = (url: string): Screen =>
      screen(
        `app "Microsoft Edge" · window "Chat" · 1036×725 · focused [6]
[1] window "Chat"
  [2] toolbar "App bar"
    [3] input "Address and search bar" = ${JSON.stringify(url)}
  [4] web area "Chat"
    [6] text area "Message" = "hi" focused caret 2`,
        EDGE_WIN
      )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), edge('app.slack.com/client/T1/C1'))).toMatchObject({ label: 'Send' })
    expect(readOutward(steps({ action: 'key', text: 'Return' }), edge('docs.example.com/notes'))).toBeNull()
  })

  it('holds Return in a field whose own group holds a Submit button, and not in one beside nothing', () => {
    const s = screen(
      `app "Google Chrome" · window "Feedback" · 800×600 · focused [4]
[1] window "Feedback"
  [2] web area "Feedback"
    [3] group "Feedback form"
      [4] input "Your email" focused caret 0
      [5] button "Submit"
    [6] group "Other"
      [7] input "Nickname"`,
      CHROME
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toEqual({ step: 0, why: 'key', label: 'Submit', on: 'Return in input "Your email", beside button "Submit"' })
    expect(readOutward(steps({ action: 'key', text: 'Return', element: 7 }), s)).toMatchObject({ label: 'Submit' })
    const lone = screen(`app "Google Chrome" · window "Feedback" · 800×600 · focused [4]\n[1] window "Feedback"\n  [2] web area "Feedback"\n    [3] group "Feedback form"\n      [4] input "Your email" focused caret 0`, CHROME)
    expect(readOutward(steps({ action: 'key', text: 'Return' }), lone)).toBeNull()
  })

  it('does not hold Return in a rename field when the toolbar\'s Share sits far away in a big window', () => {
    const rows = Array.from({ length: 70 }, (_, i) => `      [${10 + i}] row\n        [${200 + i}] text = "file ${i}.txt"`).join('\n')
    const s = screen(
      `app "Finder" · window "Documents" · 1200×800 · focused [9]
[1] window "Documents"
  [2] toolbar
    [3] button "Back"
    [4] button "Share"
    [5] button "Delete"
  [6] scroll area
    [7] outline "list view"
      [8] row
        [9] input = "Report.pdf" focused caret 3
${rows}`,
      FINDER
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toBeNull()
  })

  it('holds a typed line break in a chat box and not plain typed text', () => {
    const s = chatBox(SLACK)
    expect(readOutward(steps({ action: 'type', text: 'ship it\n' }), s)).toMatchObject({ why: 'typed', label: 'Send', on: 'a line break typed in text area "Message"' })
    expect(readOutward(steps({ action: 'type', text: 'line one\r' }), s)).toMatchObject({ why: 'typed' })
    expect(readOutward(steps({ action: 'type', text: 'ship it' }), s)).toBeNull()
    expect(readOutward(steps({ action: 'type', text: 'a\nb' }), chatBox(TEXTEDIT))).toBeNull()
  })

  it('holds perform confirm on a field in a chat app and not in TextEdit', () => {
    expect(readOutward(steps({ action: 'perform', name: 'confirm', element: 4 }), chatBox(SLACK))).toMatchObject({ why: 'key', label: 'Send' })
    expect(readOutward(steps({ action: 'perform', name: 'confirm', element: 4 }), chatBox(TEXTEDIT))).toBeNull()
  })

  it('holds Return with the focus on a Send button, and Space too', () => {
    const s = screen(`app "Mail" · window "New Message" · 800×600 · focused [3]\n[1] window "New Message"\n  [2] toolbar\n    [3] button "Send" focused\n    [4] button "Attach"`, MAIL)
    expect(readOutward(steps({ action: 'key', text: 'space' }), s)).toMatchObject({ why: 'key', label: 'Send', on: 'Space in button "Send"' })
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toMatchObject({ on: 'Return in button "Send"' })
  })

  it('does not hold Space typed in a text box, even beside a Send button', () => {
    expect(readOutward(steps({ action: 'key', text: 'space' }), screen(SLACK_TEXT, SLACK))).toBeNull()
  })

  it('holds Space after Tab in one call when the window holds a Send button: the focus is unknown', () => {
    const s = screen(`app "Notes" · window "Note" · 800×600 · focused [3]\n[1] window "Note"\n  [2] button "Send"\n  [3] text area "Body" = "hi" focused caret 2`, { bundleId: 'com.apple.Notes', name: 'Notes' })
    expect(readOutward(steps({ action: 'key', text: 'Tab' }, { action: 'key', text: 'space' }), s)).toMatchObject({ step: 1, label: 'Send', on: 'Space in the focus in Notes, which holds button "Send"' })
    expect(readOutward(steps({ action: 'key', text: 'space' }), s)).toBeNull()
    const none = screen(`app "Notes" · window "Note" · 800×600 · focused [3]\n[1] window "Note"\n  [2] button "Done"\n  [3] text area "Body" = "hi" focused caret 2`, { bundleId: 'com.apple.Notes', name: 'Notes' })
    expect(readOutward(steps({ action: 'key', text: 'Tab' }, { action: 'key', text: 'space' }), none)).toBeNull()
  })
})

describe('readOutward: send chords', () => {
  it('holds ⌘Return and Ctrl+Return in a chat app as a chord', () => {
    expect(readOutward(steps({ action: 'key', text: 'super+Return' }), chatBox(TEAMS))).toEqual({ step: 0, why: 'chord', label: 'Send', on: 'super+Return in text area "Message"' })
    expect(readOutward(steps({ action: 'key', text: 'ctrl+Return' }), chatBox(SLACK))).toMatchObject({ why: 'chord' })
    expect(readOutward(steps({ action: 'key', text: 'cmd+enter' }), chatBox(MAIL))).toMatchObject({ why: 'chord' })
  })

  it('holds ⇧⌘D in Mail and not in TextEdit', () => {
    expect(readOutward(steps({ action: 'key', text: 'shift+super+d' }), chatBox(MAIL))).toMatchObject({ why: 'chord', label: 'Send' })
    expect(readOutward(steps({ action: 'key', text: 'shift+cmd+D' }), chatBox({ bundleId: 'com.microsoft.Outlook', name: 'Microsoft Outlook' }))).toMatchObject({ why: 'chord' })
    expect(readOutward(steps({ action: 'key', text: 'shift+super+d' }), chatBox(TEXTEDIT))).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'super+d' }), chatBox(MAIL))).toBeNull()
  })

  it('does not hold ⌘Return in TextEdit, and reads no chord from a key that does not parse', () => {
    expect(readOutward(steps({ action: 'key', text: 'super+Return' }), chatBox(TEXTEDIT))).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'hyper+Return' }), chatBox(TEXTEDIT))).toBeNull()
  })
})

describe('landsByPosition and pointerAfter', () => {
  it('says a call lands by position when a click names a coordinate or follows a move by coordinate', () => {
    expect(landsByPosition(steps({ action: 'left_click', coordinate: [1, 2] }))).toBe(true)
    expect(landsByPosition(steps({ action: 'mouse_move', coordinate: [1, 2] }, { action: 'left_click' }))).toBe(true)
    expect(landsByPosition(steps({ action: 'left_click' }), { coordinate: [1, 2] })).toBe(true)
    expect(landsByPosition(steps({ action: 'left_click', element: 3 }))).toBe(false)
    expect(landsByPosition(steps({ action: 'mouse_move', element: 3 }, { action: 'left_click' }))).toBe(false)
    expect(landsByPosition(steps({ action: 'left_click' }), { element: 3 })).toBe(false)
    expect(landsByPosition(steps({ action: 'mouse_move', coordinate: [1, 2] }))).toBe(false)
    expect(landsByPosition(steps({ action: 'key', text: 'Return' }))).toBe(false)
  })

  it('leaves the pointer where the last pointer step put it', () => {
    expect(pointerAfter(steps({ action: 'left_click', element: 5 }))).toEqual({ element: 5 })
    expect(pointerAfter(steps({ action: 'mouse_move', coordinate: [3, 4] }, { action: 'scroll', element: 9, scroll_direction: 'down', scroll_amount: 1 }))).toEqual({ element: 9 })
    expect(pointerAfter(steps({ action: 'right_click', coordinate: [3, 4] }))).toEqual({ coordinate: [3, 4] })
    expect(pointerAfter(steps({ action: 'left_click', named: 'Send' }), { element: 5 })).toEqual({ named: 'Send' })
    expect(pointerAfter(steps({ action: 'mouse_move', named: 'Send now' }))).toEqual({ named: 'Send now' })
    expect(pointerAfter(steps({ action: 'left_click', menu: 'Message > Send' }), { element: 5 })).toBeNull()
    expect(pointerAfter(steps({ action: 'key', text: 'Return' }), { element: 5 })).toEqual({ element: 5 })
    expect(pointerAfter(steps({ action: 'left_click' }), { coordinate: [1, 1] })).toEqual({ coordinate: [1, 1] })
    expect(pointerAfter([])).toBeNull()
  })
})

describe('heldTargets, screenMark and restage', () => {
  const COMPOSE = `app "Mail" · window "New Message" · 800×600 · focused [6]
[1] window "New Message"
  [2] toolbar
    [3] button "Send"
    [4] button "Attach"
  [5] input "To:" = "dana@example.com"
  [6] text area "Body" = "Hi Dana" focused caret 7`
  const shift = (text: string, by: number): string => text.replace(/\[(\d+)\]/g, (_, n: string) => `[${Number(n) + by}]`)
  const held = (text: string, s: ComputerAction[]) => {
    const now = screen(text, MAIL)
    return { targets: heldTargets(s, now)!, mark: screenMark(now) }
  }

  it('names each target by role and name up the tree, with its place among its likes', () => {
    const now = screen(COMPOSE, MAIL)
    expect(heldTargets(steps({ action: 'left_click', element: 3 }), now)).toEqual([{ step: 0, param: 'element', sig: '[["button","Send"],["toolbar",""],["window","New Message"]]', ordinal: 0, count: 1 }])
    expect(heldTargets(steps({ action: 'left_click', element: 99 }), now)).toBeNull()
    // a click by position that lands on no element the read placed is no target he can be shown
    expect(heldTargets(steps({ action: 'left_click', coordinate: [10, 10] }), now)).toBeNull()
    expect(heldTargets(steps({ action: 'key', text: 'Return' }), now)).toEqual([{ step: 0, param: 'focus', sig: '[["text area","Body"],["window","New Message"]]', ordinal: 0, count: 1 }])
  })

  it('marks the app and every field\'s name and value, and nothing else', () => {
    expect(screenMark(screen(COMPOSE, MAIL))).toBe(JSON.stringify(['com.apple.mail', [['input', 'To:', '=dana@example.com'], ['text area', 'Body', '=Hi Dana']]]))
    expect(screenMark(screen(COMPOSE.replace('button "Attach"', 'button "Attach file"'), MAIL))).toBe(screenMark(screen(COMPOSE, MAIL)))
  })

  it('restages a held click on Send on the same screen unchanged', () => {
    const s = steps({ action: 'left_click', element: 3 })
    const { targets, mark } = held(COMPOSE, s)
    expect(restage(s, targets, mark, screen(COMPOSE, MAIL))).toEqual(s)
  })

  it('rewrites the index when the service numbered the same window anew', () => {
    const s = steps({ action: 'type', text: 'x', element: 6 }, { action: 'left_click', element: 3 })
    const { targets, mark } = held(COMPOSE, s)
    const out = restage(s, targets, mark, screen(shift(COMPOSE, 100), MAIL))
    expect(out).toEqual(steps({ action: 'type', text: 'x', element: 106 }, { action: 'left_click', element: 103 }))
    // The held steps themselves are left alone.
    expect(s[1]!.element).toBe(3)
  })

  it('refuses when a field\'s text changed', () => {
    const s = steps({ action: 'left_click', element: 3 })
    const { targets, mark } = held(COMPOSE, s)
    expect(restage(s, targets, mark, screen(COMPOSE.replace('"Hi Dana"', '"Hi Dan, wire the money"'), MAIL))).toBeNull()
  })

  it('refuses when the target is gone', () => {
    const s = steps({ action: 'left_click', element: 3 })
    const { targets, mark } = held(COMPOSE, s)
    expect(restage(s, targets, mark, screen(COMPOSE.replace('    [3] button "Send"\n', ''), MAIL))).toBeNull()
  })

  it('refuses when a second Send appeared under the same parents', () => {
    const s = steps({ action: 'left_click', element: 3 })
    const { targets, mark } = held(COMPOSE, s)
    expect(restage(s, targets, mark, screen(COMPOSE.replace('    [4] button "Attach"', '    [4] button "Attach"\n    [7] button "Send"'), MAIL))).toBeNull()
  })

  it('refuses a key step when the focus moved', () => {
    const s = steps({ action: 'key', text: 'Return' })
    const { targets, mark } = held(COMPOSE, s)
    const moved = COMPOSE.replace('· focused [6]', '· focused [5]').replace(' focused caret 7', '')
    expect(restage(s, targets, mark, screen(moved, MAIL))).toBeNull()
    expect(restage(s, targets, mark, screen(COMPOSE, MAIL))).toEqual(s)
  })

  it('refuses a click by position when what lies under it changed', () => {
    const s = steps({ action: 'left_click', coordinate: [30, 20] })
    const now = screen(COMPOSE_TEXT, MAIL)
    const targets = heldTargets(s, now)!
    expect(targets).toEqual([expect.objectContaining({ param: 'point', sig: '[["image","paperplane"],["button","Send"],["toolbar",""],["window","New Message"]]' })])
    expect(restage(s, targets, screenMark(now), screen(COMPOSE_TEXT, MAIL))).toEqual(s)
    const swapped = COMPOSE_TEXT.replace('[3] button "Send" @20,12 40×28', '[3] button "Send" @300,12 40×28').replace('[4] image "paperplane" @28,16 24×20', '[4] image "paperplane" @308,16 24×20')
    expect(restage(s, targets, screenMark(now), screen(swapped, MAIL))).toBeNull()
  })

  it('refuses when the app is another one', () => {
    const s = steps({ action: 'left_click', element: 3 })
    const { targets, mark } = held(COMPOSE, s)
    expect(restage(s, targets, mark, screen(COMPOSE, { bundleId: 'com.apple.Notes', name: 'Notes' }))).toBeNull()
  })
})

describe('needsFreshRead', () => {
  it('asks for a fresh read when a step lands by position', () => {
    expect(needsFreshRead(steps({ action: 'left_click', coordinate: [10, 10] }))).toBe(true)
    expect(needsFreshRead(steps({ action: 'left_click' }), { coordinate: [10, 10] })).toBe(true)
  })

  it('asks for a fresh read when Return, Space or D goes to the focus', () => {
    expect(needsFreshRead(steps({ action: 'key', text: 'Return' }))).toBe(true)
    expect(needsFreshRead(steps({ action: 'key', text: 'space' }))).toBe(true)
    expect(needsFreshRead(steps({ action: 'key', text: 'shift+super+d' }))).toBe(true)
    expect(needsFreshRead(steps({ action: 'hold_key', text: 'Return', duration: 1 }))).toBe(true)
  })

  it('asks for a fresh read when a typed line break or space, or a confirm, goes to the focus', () => {
    expect(needsFreshRead(steps({ action: 'type', text: 'hi\n' }))).toBe(true)
    expect(needsFreshRead(steps({ action: 'type', text: 'hello world' }))).toBe(true)
    expect(needsFreshRead(steps({ action: 'perform', name: 'confirm', named: 'Message' }))).toBe(true)
  })

  it('asks for a fresh read for every step that acts on an element by its number: the element may bear another name now', () => {
    expect(needsFreshRead(steps({ action: 'key', text: 'Return', element: 4 }))).toBe(true)
    expect(needsFreshRead(steps({ action: 'type', text: 'hi', element: 4 }))).toBe(true)
    expect(needsFreshRead(steps({ action: 'left_click', element: 4 }))).toBe(true)
    expect(needsFreshRead(steps({ action: 'left_click_drag', start_element: 4, element: 5 }))).toBe(true)
    // a step that moves nothing needs no read for its element
    expect(needsFreshRead(steps({ action: 'mouse_move', element: 4 }, { action: 'scroll', element: 4, scroll_direction: 'down', scroll_amount: 1 }))).toBe(false)
  })

  it('needs no fresh read for keys and text that cannot send', () => {
    expect(needsFreshRead(steps({ action: 'key', text: 'Tab' }, { action: 'type', text: 'word' }))).toBe(false)
    expect(needsFreshRead(steps({ action: 'key', text: 'not a key' }))).toBe(false)
  })

  it('asks for a fresh read for a click by name, or where the pointer was put by name: the service finds the name on the live window', () => {
    expect(needsFreshRead(steps({ action: 'left_click', named: 'paperplane' }))).toBe(true)
    expect(needsFreshRead(steps({ action: 'perform', name: 'press', named: 'Send' }))).toBe(true)
    expect(needsFreshRead(steps({ action: 'left_click' }), { named: 'paperplane' })).toBe(true)
    expect(needsFreshRead(steps({ action: 'mouse_move', named: 'paperplane' }, { action: 'left_click' }))).toBe(true)
    // and wherever the pointer was left: what lies under it is judged on the window as it is now
    expect(needsFreshRead(steps({ action: 'left_click' }), { element: 4 })).toBe(true)
  })
})

describe('readOutward: what the second round closed', () => {
  const slack = screen(SLACK_TEXT, SLACK)

  it('does not hold Return in the Save sheet\'s name field: Save is its default', () => {
    const s = screen(fixture('apps/textedit/save-sheet/observation.txt'), TEXTEDIT)
    expect(readOutward(steps({ action: 'key', text: 'Return', element: 45 }), s)).toBeNull()
    expect(readOutward(steps({ action: 'perform', name: 'confirm', element: 45 }), s)).toBeNull()
    // A click on its Delete still is.
    expect(readOutward(steps({ action: 'left_click', element: 49 }), s)).toMatchObject({ label: 'Delete' })
  })

  it('holds Return in a dialog\'s field when the dialog has only Cancel and Delete', () => {
    const s = screen(
      `app "Notes" · window "Notes" · 800×600 · focused [3]\n[1] window "Notes"\n  [2] dialog "Delete folder"\n    [3] input "Type the folder name" focused caret 0\n    [4] button "Cancel"\n    [5] button "Delete"`,
      { bundleId: 'com.apple.Notes', name: 'Notes' }
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toEqual({ step: 0, why: 'key', label: 'Delete', on: 'Return in input "Type the folder name", beside button "Delete"' })
  })

  const FORUM = `app "Google Chrome" · window "Forum" · 1280×800 · focused [6]
[1] window "Forum"
  [2] toolbar
    [3] input "Address and search bar" = "forum.example.com/t/42"
  [4] web area "Forum"
    [5] group "Reply"
      [6] text area "Comment" = "Nice" focused caret 4
      [7] button "Submit"`

  it('holds Command+Return in a page\'s comment box beside Submit as a chord, and not plain Return there', () => {
    const s = screen(FORUM, CHROME)
    expect(readOutward(steps({ action: 'key', text: 'super+Return' }), s)).toEqual({ step: 0, why: 'chord', label: 'Submit', on: 'super+Return in text area "Comment", beside button "Submit"' })
    expect(readOutward(steps({ action: 'key', text: 'ctrl+Return' }), s)).toMatchObject({ why: 'chord', label: 'Submit' })
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toBeNull()
    expect(readOutward(steps({ action: 'type', text: 'line\n' }), s)).toBeNull()
  })

  it('does not hold Return in Chrome\'s address bar, on a page with Submit or on a chat host', () => {
    expect(readOutward(steps({ action: 'key', text: 'Return', element: 9 }), screen(fixture('apps/chrome/form/observation.txt'), CHROME))).toBeNull()
    const s = screen(
      `app "Google Chrome" · window "Slack" · 1280×800 · focused [3]\n[1] window "Slack"\n  [2] toolbar\n    [3] input "Address and search bar" = "app.slack.com/client" focused caret 3\n  [4] web area "Slack"`,
      CHROME
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toBeNull()
  })

  it('reads the page host from an unnamed field outside the page whose value is an address', () => {
    const s = screen(
      `app "Arc" · window "Slack" · 1280×800 · focused [5]\n[1] window "Slack"\n  [2] toolbar\n    [3] input = "app.slack.com/client/T1"\n  [4] web area "Slack"\n    [5] text area "Message" = "hi" focused caret 2`,
      { bundleId: 'company.thebrowser.Browser', name: 'Arc' }
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toMatchObject({ label: 'Send' })
  })

  it('does not hold Return in a toolbar search field beside Share', () => {
    const s = screen(
      `app "Finder" · window "Documents" · 1200×800 · focused [5]\n[1] window "Documents"\n  [2] toolbar\n    [3] button "Back"\n    [4] button "Share"\n    [5] search "Search" focused caret 0\n  [6] outline "list view"`,
      FINDER
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toBeNull()
  })

  it('does not hold Return in a word processor body beside a Comment button, but holds ⌘Return in a text area beside Send', () => {
    const pages = screen(
      `app "Pages" · window "Essay" · 1200×800 · focused [5]\n[1] window "Essay"\n  [2] toolbar\n    [3] button "Comment"\n  [4] scroll area\n    [5] text area "Body" = "Para" focused caret 4`,
      { bundleId: 'com.apple.iWork.Pages', name: 'Pages' }
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), pages)).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'super+Return' }), pages)).toBeNull()
  })

  it('does not hold Space on an Attach button beside Send: Space presses the focused control alone', () => {
    const s = screen(`app "Mail" · window "New Message" · 800×600 · focused [4]\n[1] window "New Message"\n  [2] toolbar\n    [3] button "Send"\n    [4] button "Attach" focused`, MAIL)
    expect(readOutward(steps({ action: 'key', text: 'space' }), s)).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toBeNull()
  })

  it('does not hold Shift+Return or Option+Return in a chat box: they start a new line', () => {
    expect(readOutward(steps({ action: 'key', text: 'shift+Return' }), chatBox(SLACK))).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'alt+Return' }), chatBox(SLACK))).toBeNull()
  })

  it('does not hold Return in a spreadsheet cell in a small group with a Delete button', () => {
    const s = screen(
      `app "Numbers" · window "Budget" · 1200×800 · focused [5]\n[1] window "Budget"\n  [2] group "Sheet 1"\n    [3] button "Delete"\n    [4] table "Table 1"\n      [5] cell "A1" = "12" focused`,
      { bundleId: 'com.apple.iWork.Numbers', name: 'Numbers' }
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toBeNull()
  })

  it('does not hold a Delete key press, nor Return in a rename field in Finder', () => {
    const s = screen(fixture('apps/finder/folder/observation.txt'), FINDER)
    expect(readOutward(steps({ action: 'key', text: 'Delete' }), s)).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'super+BackSpace' }), s)).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'Return', element: 7 }), s)).toBeNull()
  })

  it('holds a move onto Send by name followed by a click with no target, in one call or the next', () => {
    expect(readOutward(steps({ action: 'mouse_move', named: 'Send now' }, { action: 'left_click' }), slack)).toEqual({ step: 1, why: 'position', label: 'Send now', on: '"Send now"' })
    expect(readOutward(steps({ action: 'mouse_move', named: 'Send now' }, { action: 'left_mouse_down' }), null)).toMatchObject({ step: 1, label: 'Send now' })
    expect(readOutward(steps({ action: 'left_click' }), null, pointerAfter(steps({ action: 'mouse_move', named: 'Send now' })))).toMatchObject({ step: 0, label: 'Send now' })
    expect(readOutward(steps({ action: 'mouse_move', named: 'Cancel' }, { action: 'left_click' }), slack)).toBeNull()
  })

  it('holds a drag that starts and ends on the same Send, and not one that ends elsewhere', () => {
    expect(readOutward(steps({ action: 'left_click_drag', start_element: 5, element: 6 }), slack)).toMatchObject({ why: 'control', label: 'Send now', on: 'button "Send now"' })
    expect(readOutward(steps({ action: 'left_click_drag', start_element: 5, element: 4 }), slack)).toBeNull()
  })

  it('holds a typed space with the focus on a Send button', () => {
    const s = screen(`app "Mail" · window "New Message" · 800×600 · focused [3]\n[1] window "New Message"\n  [2] toolbar\n    [3] button "Send" focused`, MAIL)
    expect(readOutward(steps({ action: 'type', text: ' ' }), s)).toMatchObject({ why: 'typed', label: 'Send', on: 'a space typed in button "Send"' })
  })

  it('holds a click inside a web page\'s clickable box named Send, or holding the word Send', () => {
    const s = screen(
      `app "Google Chrome" · window "Chat" · 800×600\n[1] window "Chat"\n  [2] web area "Chat"\n    [3] group "Send" actions: press\n      [4] image "paper plane"\n    [5] group actions: press\n      [6] text = "Send"`,
      CHROME
    )
    expect(readOutward(steps({ action: 'left_click', element: 3 }), s)).toMatchObject({ label: 'Send' })
    expect(readOutward(steps({ action: 'left_click', element: 4 }), s)).toMatchObject({ label: 'Send', on: 'group "Send"' })
    expect(readOutward(steps({ action: 'left_click', element: 5 }), s)).toMatchObject({ label: 'Send', on: 'group' })
    expect(readOutward(steps({ action: 'left_click', element: 6 }), s)).toMatchObject({ label: 'Send' })
  })

  it('holds a button whose name runs on with its recipients', () => {
    const s = screen(`app "Slack" · window "general" · 800×600\n[1] window "general"\n  [2] button "Send message to Dana Lee and 3 others"`, SLACK)
    expect(readOutward(steps({ action: 'left_click', element: 2 }), s)).toMatchObject({ label: 'Send' })
    expect(readOutward(steps({ action: 'left_click', named: 'Send message to Dana Lee and 3 others' }), null)).toMatchObject({ label: 'Send' })
  })

  it('holds a web mail\'s Forward though the browser\'s Back sits in the same wrapping group', () => {
    const s = screen(
      `app "Google Chrome" · window "Inbox - Gmail" · 1280×800
[1] window "Inbox - Gmail"
  [2] group "Inbox - Gmail"
    [3] group actions: show menu
      [4] button "Back"
      [5] button "Reload"
      [6] input "Address and search bar" = "mail.google.com/mail/u/0/#inbox/FMfc"
      [7] scroll area
        [8] web area "Inbox - Gmail"
          [9] button "Reply"
          [10] button "Forward"
          [11] button "Back to Inbox"`,
      CHROME
    )
    expect(readOutward(steps({ action: 'left_click', element: 10 }), s)).toMatchObject({ label: 'Forward' })
  })

  it('holds a payment dialog\'s Confirm and an invitation\'s Accept whatever the text beside them says', () => {
    const pay = screen(
      `app "Google Chrome" · window "Checkout" · 800×600\n[1] window "Checkout"\n  [2] web area "Checkout"\n    [3] dialog "Payment"\n      [4] text = "Pay $480.00 to Cookie Supply Co."\n      [5] button "Confirm"`,
      CHROME
    )
    const invite = screen(
      `app "Calendar" · window "Invite" · 800×600\n[1] window "Invite"\n  [2] dialog "Invitation"\n    [3] text = "Team lunch, bring cookies"\n    [4] button "Accept"`,
      { bundleId: 'com.apple.iCal', name: 'Calendar' }
    )
    expect(readOutward(steps({ action: 'left_click', element: 5 }), pay)).toMatchObject({ label: 'Confirm' })
    expect(readOutward(steps({ action: 'left_click', element: 4 }), invite)).toMatchObject({ label: 'Accept' })
  })

  it('holds Return in WeChat and ⌘Return in Thunderbird', () => {
    expect(readOutward(steps({ action: 'key', text: 'Return' }), chatBox({ bundleId: 'com.tencent.xinWeChat', name: 'WeChat' }))).toMatchObject({ label: 'Send' })
    expect(readOutward(steps({ action: 'key', text: 'super+Return' }), chatBox({ bundleId: 'org.mozilla.thunderbird', name: 'Thunderbird' }))).toMatchObject({ why: 'chord', label: 'Send' })
  })

  it('holds Return on teams.cloud.microsoft and ⌘Return on outlook.cloud.microsoft', () => {
    const at = (url: string): Screen =>
      screen(
        `app "Google Chrome" · window "Chat" · 1280×800 · focused [5]\n[1] window "Chat"\n  [2] toolbar\n    [3] input "Address and search bar" = ${JSON.stringify(url)}\n  [4] web area "Chat"\n    [5] text area "Message" = "hi" focused caret 2`,
        CHROME
      )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), at('teams.cloud.microsoft/'))).toMatchObject({ label: 'Send' })
    expect(readOutward(steps({ action: 'key', text: 'super+Return' }), at('outlook.cloud.microsoft/mail/'))).toMatchObject({ why: 'chord', label: 'Send' })
  })

  it('holds Return in a chat page installed as an app of its own, and ⌘Return in a mail one', () => {
    const gmail = chatBox({ bundleId: 'com.google.Chrome.app.fmgjjmmmlfnkbppncabfkddbjimcfncm', name: 'Gmail' })
    expect(readOutward(steps({ action: 'key', text: 'Return' }), gmail)).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'super+Return' }), gmail)).toMatchObject({ why: 'chord', label: 'Send' })
    expect(readOutward(steps({ action: 'key', text: 'Return' }), chatBox({ bundleId: 'com.google.Chrome.app.mdpkiolbdkhdjpekfbkbmhigcaggjagi', name: 'Google Chat' }))).toMatchObject({ label: 'Send' })
  })

  it('holds a menu path whose outward verb is not its last part', () => {
    expect(readOutward(steps({ action: 'left_click', menu: 'File > Share > Mail' }), null)).toEqual({ step: 0, why: 'menu', label: 'Share', on: 'menu item "Share"' })
  })

  it('judges perform confirm on a box named by its name with the focus unknown', () => {
    const s = screen(`app "Slack" · window "general" · 800×600 · focused [3]\n[1] window "general"\n  [2] text area "Message" = "hi"\n  [3] row "Channels" focused`, SLACK)
    expect(readOutward(steps({ action: 'perform', name: 'confirm', named: 'Message' }), s)).toMatchObject({ why: 'key', label: 'Send' })
  })

  it('cannot judge Return with no screen: run.ts reads afresh for it first', () => {
    expect(readOutward(steps({ action: 'key', text: 'Return' }), null)).toBeNull()
    expect(needsFreshRead(steps({ action: 'key', text: 'Return' }))).toBe(true)
  })
})

describe('readOutward: what the third round closed', () => {
  const slack = screen(SLACK_TEXT, SLACK)

  it('holds Return in a composer whose own group holds Send, in a chat app off the lists', () => {
    const acme = screen(
      `app "Acme Chat" · window "Dana" · 1280×800 · focused [3]\n[1] window "Dana"\n  [2] group "Composer"\n    [3] text area "Type a message" = "wire the money" focused caret 14\n    [4] button "Send"`,
      { bundleId: 'com.example.acmechat', name: 'Acme Chat' }
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), acme)).toEqual({ step: 0, why: 'key', label: 'Send', on: 'Return in text area "Type a message", beside button "Send"' })
    expect(readOutward(steps({ action: 'type', text: 'wire the money\n' }), acme)).toMatchObject({ why: 'typed', label: 'Send' })
  })

  it('does not take a composer for one when its group holds Comment or Submit, but holds ⌘Return there', () => {
    const github = screen(
      `app "Google Chrome" · window "Issue" · 1280×800 · focused [6]\n[1] window "Issue"\n  [2] toolbar\n    [3] input "Address and search bar" = "github.com/o/r/issues/1"\n  [4] web area "Issue"\n    [5] group "Add a comment"\n      [6] text area "Comment" = "LGTM" focused caret 4\n      [7] button "Comment"\n      [8] button "Submit"`,
      CHROME
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), github)).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'super+Return' }), github)).toMatchObject({ why: 'chord', label: 'Comment' })
  })

  it('holds Return on a chat host in a message box read without its web area', () => {
    const s = screen(
      `app "Google Chrome" · window "Slack" · 1280×800 · focused [4]\n[1] window "Slack"\n  [2] toolbar\n    [3] input "Address and search bar" = "app.slack.com/client"\n  [4] text area "Message" = "hi" focused caret 2`,
      CHROME
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toMatchObject({ label: 'Send', on: 'Return in text area "Message"' })
  })

  it('holds a click with no target after a scroll or a right click onto Send in the same call', () => {
    expect(readOutward(steps({ action: 'scroll', element: 5, scroll_direction: 'down', scroll_amount: 1 }, { action: 'left_click' }), slack)).toMatchObject({ step: 1, why: 'position', label: 'Send now' })
    expect(readOutward(steps({ action: 'right_click', element: 5 }, { action: 'key', text: 'Escape' }, { action: 'left_click' }), slack)).toMatchObject({ step: 2, label: 'Send now' })
    expect(readOutward(steps({ action: 'scroll', named: 'Send now', scroll_direction: 'down', scroll_amount: 1 }, { action: 'left_click' }), slack)).toMatchObject({ step: 1, label: 'Send now' })
    // A scroll with no target leaves the pointer where it was.
    expect(readOutward(steps({ action: 'mouse_move', element: 3 }, { action: 'scroll', scroll_direction: 'down', scroll_amount: 1 }, { action: 'left_click' }), slack)).toBeNull()
  })

  it('does not hold Return or a typed line break in a mail body, To: or Subject:, and holds ⌘Return and ⇧⌘D there', () => {
    const mail = screen(
      `app "Mail" · window "New Message" · 800×600 · focused [4]\n[1] window "New Message"\n  [2] input "To:" = "dana@example.com"\n  [3] input "Subject:" = "Plans"\n  [4] text area "Body" = "Hi Dana," focused caret 8\n  [5] button "Send"`,
      MAIL
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), mail)).toBeNull()
    expect(readOutward(steps({ action: 'type', text: 'Hi Dana,\n\nThanks' }), mail)).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'Return', element: 2 }), mail)).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'Return', element: 3 }), mail)).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'super+Return' }), mail)).toEqual({ step: 0, why: 'chord', label: 'Send', on: 'super+Return in text area "Body"' })
    expect(readOutward(steps({ action: 'key', text: 'shift+super+d' }), mail)).toMatchObject({ why: 'chord', label: 'Send' })
  })

  it('does not hold Return in Gmail\'s To: field, and holds ⌘Return in its body', () => {
    const gmail = screen(
      `app "Google Chrome" · window "Inbox - Gmail" · 1280×800 · focused [6]
[1] window "Inbox - Gmail"
  [2] toolbar
    [3] input "Address and search bar" = "mail.google.com/mail/u/0/#inbox?compose=new"
  [4] web area "Inbox - Gmail"
    [5] dialog "New Message"
      [6] combo box "To recipients" = "dana@example.com" focused caret 16
      [7] input "Subject" = "Plans"
      [8] text area "Message Body" = "Hi Dana,"
      [9] button "Send ‪(⌘Enter)‬"`,
      CHROME
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), gmail)).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'Return', element: 8 }), gmail)).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'super+Return', element: 8 }), gmail)).toEqual({ step: 0, why: 'chord', label: 'Send', on: 'super+Return in text area "Message Body"' })
    expect(readOutward(steps({ action: 'left_click', element: 9 }), gmail)).toMatchObject({ label: 'Send' })
  })

  it('holds plain Return in a mail app when the focus is unknown and the window holds Send: the focus may be on the button', () => {
    const mail = screen(`app "Mail" · window "New Message" · 800×600\n[1] window "New Message"\n  [2] text area "Body" = "Hi"\n  [3] button "Send"`, MAIL)
    expect(readOutward(steps({ action: 'key', text: 'Return' }), mail)).toEqual({ step: 0, why: 'key', label: 'Send', on: 'Return in the focus in Mail, which holds button "Send"' })
    const noSend = screen(`app "Mail" · window "Inbox" · 800×600\n[1] window "Inbox"\n  [2] text area "Body" = "Hi"`, MAIL)
    expect(readOutward(steps({ action: 'key', text: 'Return' }), noSend)).toBeNull()
  })

  it('holds a typed "Hi\\nThere" in Slack\'s box, and not in Mail\'s', () => {
    expect(readOutward(steps({ action: 'type', text: 'Hi\nThere' }), chatBox(SLACK))).toMatchObject({ why: 'typed', label: 'Send', on: 'a line break typed in text area "Message"' })
    expect(readOutward(steps({ action: 'type', text: 'Hi\nThere' }), chatBox(MAIL))).toBeNull()
  })

  it('holds Message > Send and File > Share, and not Edit > Delete or a path under the other menus that edit in place', () => {
    expect(readOutward(steps({ action: 'left_click', menu: 'Message > Send' }), null)).toMatchObject({ why: 'menu', label: 'Send' })
    expect(readOutward(steps({ action: 'left_click', menu: 'File > Share' }), null)).toMatchObject({ why: 'menu', label: 'Share' })
    expect(readOutward(steps({ action: 'left_click', menu: 'Edit > Delete' }), null)).toBeNull()
    expect(readOutward(steps({ action: 'perform', name: 'pick', menu: 'Format › Remove Style' }), null)).toBeNull()
    expect(readOutward(steps({ action: 'left_click', menu: 'Arrange > Order' }), null)).toBeNull()
  })

  it('lets a cookie button named by its name through, as by its index', () => {
    expect(readOutward(steps({ action: 'left_click', named: 'Accept all cookies' }), null)).toBeNull()
    expect(readOutward(steps({ action: 'left_click', named: 'Accept' }), null)).toMatchObject({ label: 'Accept' })
  })

  it('does not take words typed with no known focus for a press', () => {
    const s = screen(`app "Slack" · window "general" · 800×600\n[1] window "general"\n  [2] text area "Message" = ""`, SLACK)
    expect(readOutward(steps({ action: 'type', text: 'see you soon' }), s)).toBeNull()
    const notes = screen(`app "Notes" · window "Note" · 800×600 · focused [3]\n[1] window "Note"\n  [2] button "Send"\n  [3] text area "Body" = "" focused caret 0`, { bundleId: 'com.apple.Notes', name: 'Notes' })
    expect(readOutward(steps({ action: 'key', text: 'Tab' }, { action: 'type', text: 'Hi Dana' }), notes)).toBeNull()
  })

  it('does not name a clickable inbox item by its subject: three labels and more than four words are content', () => {
    const s = screen(
      `app "Google Chrome" · window "Inbox" · 1280×800\n[1] window "Inbox"\n  [2] web area "Inbox"\n    [3] group actions: press\n      [4] text = "Acme Billing"\n      [5] text = "Pay your invoice"\n      [6] text = "Yesterday"`,
      CHROME
    )
    expect(readOutward(steps({ action: 'left_click', element: 5 }), s)).toBeNull()
  })

  it('does not hold Return with the page itself focused', () => {
    const s = screen(fixture('apps/chrome/form/observation.txt'), CHROME)
    expect(s.focused).toBe(14)
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toBeNull()
  })

  it('does not hold a sentence typed into a rich-text box the reader calls a group', () => {
    const s = screen(
      `app "Google Chrome" · window "Thread" · 1280×800 · focused [7]\n[1] window "Thread"\n  [2] toolbar\n    [3] input "Address and search bar" = "www.reddit.com/r/x/comments/1"\n  [4] web area "Thread"\n    [5] group "Comment composer"\n      [7] group "Comment text" focused\n      [8] button "Comment"`,
      CHROME
    )
    expect(readOutward(steps({ action: 'type', text: 'nice post' }), s)).toBeNull()
  })
})

describe('readOutward: composers, disabled Sends, chat inside Gmail and open sheets', () => {
  it('holds Return in a composer whose box and Send sit straight in the page or window, when their parent holds little', () => {
    const s = screen(
      `app "Google Chrome" · window "WhatsApp" · 1280×800 · focused [3]\n[1] window "WhatsApp"\n  [2] web area "WhatsApp"\n    [3] text area "Type a message" = "hi" focused caret 2\n    [4] button "Send"`,
      CHROME
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toMatchObject({ label: 'Send', on: 'Return in text area "Type a message", beside button "Send"' })
    const acme = screen(`app "Acme Chat" · window "Dana" · 800×600 · focused [2]\n[1] window "Dana"\n  [2] text area "Message" = "hi" focused caret 2\n  [3] button "Send"`, { bundleId: 'com.example.acmechat', name: 'Acme Chat' })
    expect(readOutward(steps({ action: 'key', text: 'Return' }), acme)).toMatchObject({ label: 'Send' })
    // A page holding more than twelve elements is no composer's own surroundings.
    const big = Array.from({ length: 12 }, (_, i) => `    [${10 + i}] text = "line ${i}"`).join('\n')
    const page = screen(`app "Google Chrome" · window "Page" · 1280×800 · focused [3]\n[1] window "Page"\n  [2] web area "Page"\n    [3] text area "Notes" = "hi" focused caret 2\n    [4] button "Send"\n${big}`, CHROME)
    expect(readOutward(steps({ action: 'key', text: 'Return' }), page)).toBeNull()
  })

  it('holds a send after the call typed into an empty box beside a Send the read shows disabled', () => {
    const empty = SLACK_TEXT.replace('= "ship it" focused caret 7', 'focused caret 0').replace('[5] button "Send now"', '[5] button "Send now" disabled')
    const slackEmpty = screen(empty, SLACK)
    expect(readOutward(steps({ action: 'type', text: 'wire the money', element: 4 }, { action: 'left_click', element: 5 }), slackEmpty)).toMatchObject({ step: 1, why: 'control', label: 'Send now' })
    const acme = screen(
      `app "Acme Chat" · window "Dana" · 1280×800 · focused [3]\n[1] window "Dana"\n  [2] group "Composer"\n    [3] text area "Type a message" focused caret 0\n    [4] button "Send" disabled`,
      { bundleId: 'com.example.acmechat', name: 'Acme Chat' }
    )
    expect(readOutward(steps({ action: 'type', text: 'wire the money' }, { action: 'key', text: 'Return' }), acme)).toMatchObject({ step: 1, why: 'key', label: 'Send' })
    expect(readOutward(steps({ action: 'key', text: 'Return' }), acme)).toBeNull()
  })

  it('holds plain Return in Google Chat inside Gmail: its path makes it a chat place', () => {
    const s = screen(
      `app "Google Chrome" · window "Chat - Gmail" · 1280×800 · focused [5]\n[1] window "Chat - Gmail"\n  [2] toolbar\n    [3] input "Address and search bar" = "mail.google.com/chat/u/0/#chat/dm/xyz"\n  [4] web area "Chat - Gmail"\n    [5] text area "Message Dana" = "wire the money" focused caret 14`,
      CHROME
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), s)).toMatchObject({ why: 'key', label: 'Send' })
  })

  it('judges Return with the focus on the window, the page or a sheet by the open sheet\'s buttons', () => {
    const sheet = (focus: number): Screen =>
      screen(
        `app "Mail" · window "New Message" · 800×600 · focused [${focus}]\n[1] window "New Message"\n  [2] sheet "No subject"\n    [3] text = "This message has no subject."\n    [4] button "Don't Send"\n    [5] button "Send Anyway"`,
        MAIL
      )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), sheet(2))).toMatchObject({ label: 'Send', on: 'Return in sheet "No subject", which holds button "Send Anyway"' })
    expect(readOutward(steps({ action: 'key', text: 'Return' }), sheet(1))).toMatchObject({ label: 'Send' })
    expect(readOutward(steps({ action: 'key', text: 'Return' }), screen(`app "Notes" · window "Note" · 800×600 · focused [1]\n[1] window "Note"\n  [2] sheet "Share"\n    [3] button "Cancel"\n    [4] button "Send"`, { bundleId: 'com.apple.Notes', name: 'Notes' }))).toMatchObject({ label: 'Send' })
    const save = screen(
      `app "TextEdit" · window "Untitled" · 800×600 · focused [1]\n[1] window "Untitled"\n  [2] sheet "save"\n    [3] button "Delete"\n    [4] button "Cancel"\n    [5] button "Save"`,
      TEXTEDIT
    )
    expect(readOutward(steps({ action: 'key', text: 'Return' }), save)).toBeNull()
  })

  it('GAP: an unnamed clickable box with more than three labels, one of them the word Send, is not held', () => {
    const icons = Array.from({ length: 8 }, (_, i) => `      [${10 + i}] image "decoration ${i}"`).join('\n')
    const s = screen(`app "Google Chrome" · window "Chat" · 800×600\n[1] window "Chat"\n  [2] web area "Chat"\n    [3] group actions: press\n      [4] text = "Send"\n${icons}`, CHROME)
    expect(readOutward(steps({ action: 'left_click', element: 3 }), s)).toBeNull()
  })
})

describe('readOutward: what the fourth round closed in mail', () => {
  it('does not hold Tab from Subject: to the body followed by a typed letter of several lines, and still holds a bare Return there', () => {
    const mail = screen(
      `app "Mail" · window "New Message" · 800×600 · focused [3]\n[1] window "New Message"\n  [2] input "To:" = "dana@example.com"\n  [3] input "Subject:" = "Plans" focused caret 5\n  [4] text area "Body" = ""\n  [5] button "Send"`,
      MAIL
    )
    expect(readOutward(steps({ action: 'key', text: 'Tab' }, { action: 'type', text: 'Hi Dana,\n\nThanks' }), mail)).toBeNull()
    expect(readOutward(steps({ action: 'key', text: 'Tab' }, { action: 'key', text: 'Return' }), mail)).toMatchObject({ step: 1, why: 'key', label: 'Send', on: 'Return in the focus in Mail, which holds button "Send"' })
  })

  it('does not hold ⌘Return in a mail app\'s search field', () => {
    const mail = screen(`app "Mail" · window "Inbox" · 800×600 · focused [2]\n[1] window "Inbox"\n  [2] search "Search" = "invoice" focused caret 7`, MAIL)
    expect(readOutward(steps({ action: 'key', text: 'super+Return' }), mail)).toBeNull()
  })
})

describe('readOutward, heldTargets and screenMark: what the fifth review closed', () => {
  it('holds a click by a name that is only an icon inside a Send, as the same click by index is', () => {
    const slack = screen(SLACK_TEXT, SLACK)
    expect(readOutward(steps({ action: 'left_click', named: 'paperplane' }), slack)).toEqual({ step: 0, why: 'control', label: 'Send now', on: 'button "Send now"' })
    // the service matches a name case-blind, and a press where the pointer was put by such a name lands there too
    expect(readOutward(steps({ action: 'perform', name: 'press', named: 'Paperplane' }), slack)).toMatchObject({ label: 'Send now' })
    expect(readOutward(steps({ action: 'mouse_move', named: 'paperplane' }, { action: 'left_click' }), slack)).toMatchObject({ step: 1, why: 'position', label: 'Send now' })
    expect(readOutward(steps({ action: 'left_click', named: 'paperplane' }), null)).toBeNull()
    expect(readOutward(steps({ action: 'left_click', named: 'Attach' }), slack)).toBeNull()
  })

  const CHAT = `app "Slack" · window "Slack" · 1280×800 · focused [7]
[1] window "Slack"
  [2] heading "Dana Lee"
  [3] scroll area
    [4] group
      [5] text = "See you at 5"
  [6] group "Composer"
    [7] text area "Message" = "the wire details" focused caret 16
    [8] button "Send"`

  it('marks who a send goes to: a heading the press finds changed refuses, a message coming in does not', () => {
    const s = steps({ action: 'left_click', element: 8 })
    const now = screen(CHAT, SLACK)
    const targets = heldTargets(s, now)!
    const mark = screenMark(now)
    expect(restage(s, targets, mark, screen(CHAT, SLACK))).toEqual(s)
    expect(restage(s, targets, mark, screen(CHAT.replace('heading "Dana Lee"', 'heading "Sam Ortiz"'), SLACK))).toBeNull()
    expect(restage(s, targets, mark, screen(CHAT.replace('      [5] text = "See you at 5"', '      [5] text = "See you at 5"\n      [9] text = "Running late"'), SLACK))).toEqual(s)
  })

  it("marks a mail's To line drawn as text beside the Send", () => {
    const TO = `app "Mail" · window "New Message" · 800×600 · focused [5]
[1] window "New Message"
  [2] toolbar
    [3] button "Send"
  [4] text = "To: Dana Lee"
  [5] text area "Body" = "Hi" focused caret 2`
    const s = steps({ action: 'left_click', element: 3 })
    const now = screen(TO, MAIL)
    expect(restage(s, heldTargets(s, now)!, screenMark(now), screen(TO.replace('To: Dana Lee', 'To: Sam Ortiz'), MAIL))).toBeNull()
  })

  it('keeps what the pointer is on for a click with no target, and refuses the press when the pointer moved off it', () => {
    const s = steps({ action: 'left_click' })
    const now = screen(COMPOSE_TEXT, MAIL)
    const mark = screenMark(now)
    const targets = heldTargets(s, now, { coordinate: [30, 20] })!
    expect(targets).toEqual([{ step: 0, param: 'point', sig: '[["image","paperplane"],["button","Send"],["toolbar",""],["window","New Message"]]', ordinal: 0, count: 1 }])
    expect(restage(s, targets, mark, now, { coordinate: [30, 20] })).toEqual(s)
    expect(restage(s, targets, mark, now, { element: 4 })).toEqual(s)
    // the thread put the pointer on the unnamed button beside it since, or nobody knows where it is
    expect(restage(s, targets, mark, now, { coordinate: [110, 20] })).toBeNull()
    expect(restage(s, targets, mark, now, { element: 7 })).toBeNull()
    expect(restage(s, targets, mark, now)).toBeNull()
    // a pointer on nothing the read placed is no target he can be shown
    expect(heldTargets(s, now, { coordinate: [900, 900] })).toBeNull()
  })

  it('checks a pointer this call puts on its target after the index is found again', () => {
    const s = steps({ action: 'mouse_move', element: 3 }, { action: 'left_click' })
    const now = screen(COMPOSE_TEXT, MAIL)
    const targets = heldTargets(s, now, { element: 7 })!
    expect(targets.map((t) => [t.step, t.param])).toEqual([[0, 'element'], [1, 'point']])
    expect(restage(s, targets, screenMark(now), screen(COMPOSE_TEXT.replace(/\[(\d+)\]/g, (_, n: string) => `[${Number(n) + 100}]`), MAIL), { element: 107 })).toEqual(
      steps({ action: 'mouse_move', element: 103 }, { action: 'left_click' })
    )
  })
})

describe('heldTargets and restage: what the review of the fifth round closed', () => {
  const TO_DANA = `app "Slack" · window "Slack" · 1280×800 · focused [3]
[1] window "Slack"
  [2] group "Composer"
    [3] text area "Message" = "the wire details" focused caret 16
    [4] button "Send to Dana"
      [5] image "paperplane"`

  it('binds a held click by name to the element the name found, and refuses the press when it now sits in another Send', () => {
    const s = steps({ action: 'left_click', named: 'paperplane' })
    const now = screen(TO_DANA, SLACK)
    const targets = heldTargets(s, now)!
    expect(targets).toEqual([{ step: 0, param: 'point', sig: '[["image","paperplane"],["button","Send to Dana"],["group","Composer"],["window","Slack"]]', ordinal: 0, count: 1 }])
    const mark = screenMark(now)
    expect(restage(s, targets, mark, screen(TO_DANA, SLACK))).toEqual(s)
    const toEve = screen(TO_DANA.replace('Send to Dana', 'Send to Eve'), SLACK)
    expect(screenMark(toEve)).toBe(mark)
    expect(restage(s, targets, mark, toEve)).toBeNull()
    // a second element of that name beside it: the name no longer finds the one he was shown
    expect(restage(s, targets, mark, screen(`${TO_DANA}\n    [6] button "paperplane"`, SLACK))).toBeNull()
  })

  it('refuses to hold a click by a name that finds no element, or several, on the read', () => {
    const now = screen(TO_DANA, SLACK)
    expect(heldTargets(steps({ action: 'left_click', named: 'Send' }), now)).toBeNull()
    expect(heldTargets(steps({ action: 'left_click', named: 'paperplane' }), screen(`${TO_DANA}\n  [6] image "paperplane"`, SLACK))).toBeNull()
    // an exact name before a case-blind one, as the service picks
    expect(heldTargets(steps({ action: 'left_click', named: 'paperplane' }), screen(`${TO_DANA}\n  [6] image "PaperPlane"`, SLACK))).toEqual([expect.objectContaining({ sig: '[["image","paperplane"],["button","Send to Dana"],["group","Composer"],["window","Slack"]]' })])
  })

  it('refuses to hold a click with no target when nobody knows where the pointer is', () => {
    const now = screen(COMPOSE_TEXT, MAIL)
    expect(heldTargets(steps({ action: 'left_click' }), now)).toBeNull()
    expect(heldTargets(steps({ action: 'left_mouse_down' }, { action: 'left_mouse_up' }), now)).toBeNull()
    // a pointer this call puts on a control first is known
    expect(heldTargets(steps({ action: 'mouse_move', element: 3 }, { action: 'left_click' }), now)).toHaveLength(2)
  })
})

describe('clicksBlind', () => {
  it('finds a click with no target while nobody knows where the pointer is', () => {
    expect(clicksBlind(steps({ action: 'left_click' }))).toBe(true)
    expect(clicksBlind(steps({ action: 'left_mouse_down' }), null)).toBe(true)
    expect(clicksBlind(steps({ action: 'left_click' }), { element: 3 })).toBe(false)
    // a step of the call that puts the pointer somewhere first, and a pick in a menu that leaves it unknown again
    expect(clicksBlind(steps({ action: 'mouse_move', element: 3 }, { action: 'left_click' }))).toBe(false)
    expect(clicksBlind(steps({ action: 'left_click', menu: 'Edit > Select All' }, { action: 'left_click' }), { element: 3 })).toBe(true)
    expect(clicksBlind(steps({ action: 'left_click', element: 3 }, { action: 'key', text: 'Return' }))).toBe(false)
  })
})

describe('readOutward: keys and typed text by name', () => {
  const GMAIL = `app "Google Chrome" · window "Gmail" · 1280×800 · focused [4]
[1] window "Gmail"
  [2] input "Address and search bar" = "mail.google.com/mail/u/0/#inbox"
  [3] web area "Gmail"
    [4] text area "Message Body" = "Hi Dana" focused caret 7
    [5] button "Send"`
  const gmail = screen(GMAIL, CHROME)

  it('holds a line break or a space typed into a focusable Send found by its name, as the service focuses it', () => {
    expect(readOutward(steps({ action: 'type', named: 'Send', text: '\n' }), gmail)).toMatchObject({ step: 0, why: 'typed', label: 'Send', on: 'a line break typed in button "Send"' })
    expect(readOutward(steps({ action: 'type', named: 'send', text: ' ' }), gmail)).toMatchObject({ why: 'typed', label: 'Send' })
    expect(readOutward(steps({ action: 'perform', name: 'confirm', named: 'Send' }), gmail)).toMatchObject({ why: 'control', label: 'Send' })
    // a line break into the mail's own body by its name is a new line there
    expect(readOutward(steps({ action: 'type', named: 'Message Body', text: '\n' }), gmail)).toBeNull()
  })

  it('carries the focus to the element a name found: Space after it presses that Send', () => {
    expect(readOutward(steps({ action: 'type', named: 'Send', text: 'x' }, { action: 'key', text: 'space' }), gmail)).toMatchObject({ step: 1, why: 'key', label: 'Send' })
  })

  it('finds a key or a typed text whose name finds no one element, and binds one that does', () => {
    expect(namedKeysUnplaced(steps({ action: 'type', named: 'Reply', text: 'x' }), gmail)).toBe(true)
    expect(namedKeysUnplaced(steps({ action: 'key', named: 'Send', text: 'Return' }), screen(`${GMAIL}\n    [6] button "Send"`, CHROME))).toBe(true)
    expect(namedKeysUnplaced(steps({ action: 'type', named: 'Message Body', text: 'x' }), gmail)).toBe(false)
    expect(namedKeysUnplaced(steps({ action: 'left_click', named: 'Reply' }), gmail)).toBe(false)
    expect(needsFreshRead(steps({ action: 'type', named: 'Message Body', text: 'x' }))).toBe(true)
    const s = steps({ action: 'type', named: 'Send', text: '\n' })
    const targets = heldTargets(s, gmail)!
    expect(targets).toEqual([{ step: 0, param: 'point', sig: '[["button","Send"],["web area","Gmail"],["window","Gmail"]]', ordinal: 0, count: 1 }])
    expect(restage(s, targets, screenMark(gmail), screen(GMAIL.replace('button "Send"', 'button "Send later"'), CHROME))).toBeNull()
    // a second Send elsewhere: the name no longer finds the one he was shown
    expect(restage(s, targets, screenMark(gmail), screen(`${GMAIL}\n    [6] toolbar\n      [7] button "Send"`, CHROME))).toBeNull()
    expect(restage(s, targets, screenMark(gmail), gmail)).toEqual(s)
  })
})

describe('heldTargets and restage: a paste, a value or a selection by name', () => {
  const COMPOSE = `app "Google Chrome" · window "Gmail" · 1280×800 · focused [5]
[1] window "Gmail"
  [2] input "Address and search bar" = "mail.google.com/mail/u/0/#inbox"
  [3] web area "Gmail"
    [4] input "To" = "dana@example.com"
    [5] text area "Message" = "Hi" focused caret 2
    [6] button "Send"`
  // the same fields in the same order, the To field moved into another part of the page
  const MOVED = COMPOSE.replace('    [4] input "To" = "dana@example.com"', '    [7] group "Forward"\n      [4] input "To" = "dana@example.com"')
  const s = steps({ action: 'left_click', element: 5 }, { action: 'paste', named: 'To', text: 'other@example.com' }, { action: 'left_click', element: 6 })

  it('binds a paste by name to the field the name finds, not the focus an earlier step left', () => {
    const now = screen(COMPOSE, CHROME)
    const targets = heldTargets(s, now)!
    expect(targets).toContainEqual({ step: 1, param: 'point', sig: '[["input","To"],["web area","Gmail"],["window","Gmail"]]', ordinal: 0, count: 1 })
    expect(restage(s, targets, screenMark(now), screen(COMPOSE, CHROME))).toEqual(s)
    // the mark is the same, but the name now finds a To he was not shown
    expect(screenMark(screen(MOVED, CHROME))).toBe(screenMark(now))
    expect(restage(s, targets, screenMark(now), screen(MOVED, CHROME))).toBeNull()
  })

  it('does the same for a value set or a selection made by name, and refuses one whose name finds none', () => {
    const now = screen(COMPOSE, CHROME)
    for (const step of [{ action: 'set_value', named: 'To', value: 'other@example.com' }, { action: 'select_text', named: 'To', text: 'dana' }]) {
      expect(heldTargets(steps(step), now)).toEqual([{ step: 0, param: 'point', sig: '[["input","To"],["web area","Gmail"],["window","Gmail"]]', ordinal: 0, count: 1 }])
      expect(needsFreshRead(steps(step))).toBe(true)
    }
    expect(namedKeysUnplaced(steps({ action: 'paste', named: 'Bcc', text: 'x' }), now)).toBe(true)
    expect(heldTargets(steps({ action: 'paste', named: 'Bcc', text: 'x' }), now)).toBeNull()
  })
})

describe('screenMark and cutFields: what pass 19 closed', () => {
  const sheet = (value: string, choice = 'Standard') =>
    screen(
      `app "Mail" · window "Order" · 800×600\n[1] window "Order"\n  [2] text area "Note" = ${JSON.stringify(value)}\n  [3] pop up "Plan" = ${JSON.stringify(choice)}\n  [4] button "Submit"`,
      MAIL
    )

  it('reads a pop-up printed cut again whole, as a field is', () => {
    const long = `Premium ${'with every add-on, '.repeat(12)}billed yearly`
    expect(cutFields(sheet('Hi', cutValue(long)))).toEqual([3])
    expect(cutFields(sheet(cutValue(long), cutValue(long)))).toEqual([2, 3])
    expect(cutFields(sheet('Hi', 'Standard'))).toEqual([])
    // the same prefix and length with another tail is another choice once read whole
    expect(screenMark(sheet('Hi', long))).not.toBe(screenMark(sheet('Hi', long.replace('billed yearly', 'billed weekly'))))
  })

  it('never binds a text as the digest it spells', () => {
    const long = `Hello Dana, ${'the plan is below. '.repeat(12)}`
    const spelled = `#${sha256Hex(long)}`
    expect(spelled.length).toBeLessThanOrEqual(160)
    expect(screenMark(sheet(spelled))).not.toBe(screenMark(sheet(long)))
    expect(screenMark(sheet(spelled, spelled))).not.toBe(screenMark(sheet(long, long)))
  })
})

describe('screenMark: what pass 20 closed', () => {
  const order = (fields: string) => screen(`app "Shop" · window "Checkout" · 800×600\n[1] window "Checkout"\n${fields}\n  [9] button "Place order"`, { bundleId: 'com.example.shop', name: 'Shop' })

  it('binds a numeric field: a quantity changed while Place order is held is a change', () => {
    const one = order('  [2] stepper "Quantity" = "1"\n  [3] slider "Tip" = "10"')
    expect(screenMark(order('  [2] stepper "Quantity" = "100000"\n  [3] slider "Tip" = "10"'))).not.toBe(screenMark(one))
    expect(screenMark(order('  [2] stepper "Quantity" = "1"\n  [3] slider "Tip" = "90"'))).not.toBe(screenMark(one))
    expect(screenMark(order('  [2] stepper "Quantity" = "1"\n  [3] slider "Tip" = "10"'))).toBe(screenMark(one))
    // a long one is read again whole, as a text field is
    expect(cutFields(order(`  [2] stepper "Quantity" = ${JSON.stringify(cutValue('9'.repeat(200)))}`))).toEqual([2])
  })

  it('keeps each field apart: a separator inside a name or a value never moves text from one part to the next', () => {
    const a = order('  [2] input "Message" = "hello|=PAY 100000"')
    const b = order('  [2] input "Message|=hello" = "PAY 100000"')
    expect(screenMark(a)).not.toBe(screenMark(b))
    const c = order('  [2] pop up "Plan" = "Basic|Premium"\n  [3] checkbox "Insurance" unchecked')
    const d = order('  [2] pop up "Plan|=Basic" = "Premium"\n  [3] checkbox "Insurance" unchecked')
    expect(screenMark(c)).not.toBe(screenMark(d))
  })
})

describe('heldTargets and screenMark: what pass 21 closed', () => {
  const win = (body: string) => screen(`app "Shop" · window "Pay" · 800×600\n[1] window "Pay"\n${body}`, { bundleId: 'com.example.shop', name: 'Shop' })

  it('signs a target and the names above it as tuples: a name holding " < " never passes for an ancestor', () => {
    const a = win('  [2] group "Bob"\n    [3] button "Pay < group:Alice"')
    const b = win('  [2] group "Alice < group:Bob"\n    [3] button "Pay"')
    const s = steps({ action: 'left_click', element: 3 })
    const [ta] = heldTargets(s, a)!
    const [tb] = heldTargets(s, b)!
    expect(ta!.sig).toBe(JSON.stringify([['button', 'Pay < group:Alice'], ['group', 'Bob'], ['window', 'Pay']]))
    expect(ta!.sig).not.toBe(tb!.sig)
    // held on the one, the press on the other is refused (their marks are equal: neither has a field)
    expect(screenMark(a)).toBe(screenMark(b))
    expect(restage(s, [ta!], screenMark(a), b)).toBeNull()
    expect(restage(s, [ta!], screenMark(a), a)).toEqual(s)
  })

  it('binds a search field: a recipient search box changed while Send is held is a change', () => {
    const to = (who: string) => win(`  [2] search "To" = ${JSON.stringify(who)}\n  [3] button "Send"`)
    expect(screenMark(to('alice@'))).not.toBe(screenMark(to('bob@')))
    expect(screenMark(to('alice@'))).toBe(screenMark(to('alice@')))
  })

  it("binds what each listbox has chosen, a change to none too, and not rows that come and go unselected", () => {
    const pick = (rows: string) => win(`  [2] list "Recipients"\n${rows}\n  [9] button "Send"`)
    const alice = pick('    [3] row "Alice" selected\n    [4] row "Bob"')
    expect(screenMark(pick('    [3] row "Alice"\n    [4] row "Bob" selected'))).not.toBe(screenMark(alice))
    expect(screenMark(pick('    [3] row "Alice"\n    [4] row "Bob"'))).not.toBe(screenMark(alice))
    expect(screenMark(pick('    [3] row "Alice" selected\n    [4] row "Bob"\n    [5] row "Carol"'))).toBe(screenMark(alice))
    // a mail list or a sidebar (a table, an outline) is not a choice: clicking around it voids nothing
    const mail = (row: number) => win(`  [2] table "Inbox"\n    [3] row "Budget"${row === 3 ? ' selected' : ''}\n    [4] row "Lunch"${row === 4 ? ' selected' : ''}\n  [9] button "Send"`)
    expect(screenMark(mail(3))).toBe(screenMark(mail(4)))
  })
})
