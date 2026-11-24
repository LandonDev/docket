import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shell } from 'electron'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const liveSessions = new Map<string, FakeSession>()

class FakeSession extends EventEmitter {
  ua = 'Mozilla/5.0 Chrome/140 Electron/39.0.0 TempCode/1.0.400 Safari/537.36'
  request: ((p: string) => boolean) | null = null
  check: ((p: string) => boolean) | null = null
  before: ((url: string) => boolean) | null = null
  getUserAgent = (): string => this.ua
  setUserAgent = (ua: string): void => void (this.ua = ua)
  setPermissionRequestHandler = (fn: (wc: unknown, p: string, done: (ok: boolean) => void) => void): void =>
    void (this.request = (p) => {
      let answer = false
      fn(null, p, (ok) => (answer = ok))
      return answer
    })
  setPermissionCheckHandler = (fn: (wc: unknown, p: string) => boolean): void => void (this.check = (p) => fn(null, p))
  setDevicePermissionHandler = vi.fn()
  webRequest = {
    onBeforeRequest: (fn: (d: { url: string }, done: (r: { cancel: boolean }) => void) => void): void =>
      void (this.before = (url) => {
        let cancel = false
        fn({ url }, (r) => (cancel = r.cancel))
        return cancel
      })
  }
}

vi.mock('electron', () => ({
  app: { getPath: () => '/nowhere' },
  ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) },
  session: {
    fromPartition: (p: string) => {
      if (!liveSessions.has(p)) liveSessions.set(p, new FakeSession())
      return liveSessions.get(p)
    }
  },
  shell: { openExternal: vi.fn() }
}))

import {
  TicketStore,
  TICKET_MS,
  answerTicket,
  attachLiveFence,
  forwardedKey,
  typedKey,
  blockedRequest,
  livePartition,
  livePartitionsIn,
  navigationAllowed,
  openTarget,
  registerOfficeLive,
  tenantOfUrl
} from './officeLive'

const FILE = 'https://purdue0-my.sharepoint.com/personal/lh_purdue_edu/Documents/TempCode%20proof%20live%201.docx?web=1'
const PARTITION = 'persist:office-live-purdue0'

describe('the partition', () => {
  it('is one per tenant, read from the SharePoint host', () => {
    expect(tenantOfUrl(FILE)).toBe('purdue0')
    expect(tenantOfUrl('https://purdue0.sharepoint.com/sites/RecWell/Shared%20Documents/a.xlsx')).toBe('purdue0')
    expect(tenantOfUrl('https://Contoso-My.SharePoint.com/x')).toBe('contoso')
    expect(livePartition(FILE)).toBe(PARTITION)
    expect(livePartition('https://www.office.com/')).toBeNull()
    expect(livePartition('https://evil.com/purdue0.sharepoint.com')).toBeNull()
  })

  it('finds the live partitions on disk and nothing else', () => {
    expect(livePartitionsIn(['office-live-purdue0', 'microsoft', 'office-live-../x', 'office-live-contoso'])).toEqual([PARTITION, 'persist:office-live-contoso'])
  })
})

describe('tickets', () => {
  it('are good once, for one window, one address and one partition', () => {
    const store = new TicketStore()
    expect(store.issue(7, FILE)).toEqual({ ok: true, src: FILE, partition: PARTITION })
    expect(store.take(8, FILE, PARTITION)).toBeNull()
    expect(store.take(7, FILE + '&x=1', PARTITION)).toBeNull()
    expect(store.take(7, FILE, 'persist:microsoft')).toBeNull()
    expect(store.take(7, FILE, PARTITION)?.src).toBe(FILE)
    expect(store.take(7, FILE, PARTITION)).toBeNull()
  })

  it('last ten seconds', () => {
    let now = 1000
    const store = new TicketStore(() => now)
    store.issue(7, FILE)
    now += TICKET_MS + 1
    expect(store.take(7, FILE, PARTITION)).toBeNull()
  })

  it('are only for a Microsoft file', () => {
    const store = new TicketStore()
    expect(store.issue(7, 'https://example.com/a.docx').ok).toBe(false)
    expect(store.issue(7, 'http://purdue0.sharepoint.com/a.docx').ok).toBe(false)
    expect(store.issue(7, 'https://www.office.com/').ok).toBe(false)
  })

  it('are issued to the window itself, never a frame inside it', () => {
    const store = new TicketStore()
    const mainFrame = {}
    expect(answerTicket(store, { sender: { id: 1, mainFrame }, senderFrame: {} }, FILE)).toEqual({ ok: false, error: 'Only the window itself can open a live file.' })
    expect(answerTicket(store, { sender: { id: 1, mainFrame }, senderFrame: mainFrame }, 42).ok).toBe(false)
    expect(answerTicket(store, { sender: { id: 1, mainFrame }, senderFrame: mainFrame }, FILE).ok).toBe(true)
  })
})

describe('blocked requests', () => {
  it.each([
    'https://127.0.0.1:7677/ws',
    'https://127.1/',
    'https://0x7f000001/',
    'https://2130706433/',
    'https://0177.0.0.1/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:7f00:1]/',
    'https://[fd00::1]/',
    'https://[fe80::1]/',
    'https://10.0.0.5/',
    'https://172.16.3.4/',
    'https://192.168.1.1/',
    'https://169.254.169.254/latest/meta-data',
    'https://100.101.102.103/',
    'https://0.0.0.0/',
    'https://localhost/',
    'https://localhost./',
    'https://app.localhost/',
    'https://box.local/',
    'https://router/',
    'http://purdue0.sharepoint.com/',
    'ws://127.0.0.1:7677/ws',
    'ws://example.com/',
    'file:///etc/passwd',
    'tempcode-app://renderer/index.html',
    'tempcode-asset://x/y',
    'chrome://settings',
    'not a url'
  ])('%s', (url) => expect(blockedRequest(url)).toBe(true))

  it('lets the internet over https and wss through, and pages made in the guest', () => {
    for (const url of [FILE, 'https://login.microsoftonline.com/common', 'wss://pubsub.office.com/x', 'https://idp.purdue.edu/', 'https://8.8.8.8/', 'data:text/plain,a', 'blob:https://x/y']) expect(blockedRequest(url)).toBe(false)
  })
})

describe('navigation and new windows', () => {
  it('moves the page over https alone, frames also to about, blob and data', () => {
    expect(navigationAllowed('https://idp.purdue.edu/login', 'main')).toBe(true)
    expect(navigationAllowed('http://idp.purdue.edu/login', 'main')).toBe(false)
    expect(navigationAllowed('https://127.0.0.1/', 'main')).toBe(false)
    expect(navigationAllowed('data:text/html,x', 'main')).toBe(false)
    expect(navigationAllowed('about:blank', 'sub')).toBe(true)
    expect(navigationAllowed('file:///x', 'sub')).toBe(false)
  })

  it('opens Microsoft in the guest, the web in his browser, nothing else', () => {
    expect(openTarget('https://purdue0.sharepoint.com/a')).toBe('guest')
    expect(openTarget('https://example.com/help')).toBe('browser')
    expect(openTarget('http://example.com/help')).toBe('browser')
    expect(openTarget('http://127.0.0.1:7677/')).toBe('none')
    expect(openTarget('file:///x')).toBe('none')
    expect(openTarget('tempcode-app://renderer/')).toBe('none')
  })
})

class FakeContents extends EventEmitter {
  constructor(
    readonly id: number,
    readonly session?: FakeSession
  ) {
    super()
  }
  mainFrame = {}
  close = vi.fn()
  loadURL = vi.fn()
  setWindowOpenHandler = vi.fn()
  setWebRTCIPHandlingPolicy = vi.fn()
}

function attach(win: FakeContents, params: Record<string, string>, prefs: Record<string, unknown> = { preload: '/evil.js', nodeIntegration: true, sandbox: false }) {
  const event = { preventDefault: vi.fn() }
  win.emit('will-attach-webview', event, prefs, params)
  return { refused: event.preventDefault.mock.calls.length > 0, prefs, params }
}

describe('the fence on a window', () => {
  let win: FakeContents
  let ids = 100
  beforeEach(() => {
    handlers.clear()
    registerOfficeLive()
    win = new FakeContents(ids++)
    attachLiveFence({ webContents: win } as never)
  })
  const ticket = (url: string, sender: FakeContents = win): unknown => handlers.get('office-live:ticket')!({ sender, senderFrame: sender.mainFrame }, url)

  it('refuses a <webview> with no ticket', async () => {
    expect(attach(win, { src: FILE, partition: PARTITION }).refused).toBe(true)
  })

  it('refuses a ticket of another window, another address or another partition', async () => {
    const other = new FakeContents(ids++)
    await ticket(FILE, other)
    expect(attach(win, { src: FILE, partition: PARTITION }).refused).toBe(true)
    await ticket(FILE)
    expect(attach(win, { src: FILE, partition: 'persist:microsoft' }).refused).toBe(true)
    expect(attach(win, { src: 'https://purdue0.sharepoint.com/other.docx', partition: PARTITION }).refused).toBe(true)
  })

  it('attaches once on a ticket, stripped of preloads and Node, sandboxed, without popups', async () => {
    await ticket(FILE)
    const first = attach(win, { src: FILE, partition: PARTITION, allowpopups: 'true', preload: 'file:///evil.js', nodeintegration: 'on', webpreferences: 'sandbox=no' })
    expect(first.refused).toBe(false)
    expect(first.prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, partition: PARTITION })
    expect(first.prefs).not.toHaveProperty('preload')
    expect(first.params).toEqual({ src: FILE, partition: PARTITION, allowpopups: 'true' })
    expect(attach(win, { src: FILE, partition: PARTITION }).refused).toBe(true)
  })

  it('makes the tenant session ready: plain Chrome, one permission, the block', async () => {
    await ticket(FILE)
    attach(win, { src: FILE, partition: PARTITION })
    const ses = liveSessions.get(PARTITION)!
    expect(ses.ua).not.toMatch(/Electron|TempCode/)
    expect(ses.request!('clipboard-sanitized-write')).toBe(true)
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'fileSystem', 'openExternal']) expect(ses.request!(p)).toBe(false)
    expect(ses.check!('media')).toBe(false)
    expect(ses.before!('https://127.0.0.1:1234/ws')).toBe(true)
    expect(ses.before!(FILE)).toBe(false)
  })

  it('closes a guest that is not on a live session, and fences one that is', async () => {
    const stray = new FakeContents(9, new FakeSession())
    win.emit('did-attach-webview', {}, stray)
    expect(stray.close).toHaveBeenCalled()
    await ticket(FILE)
    attach(win, { src: FILE, partition: PARTITION })
    const guest = new FakeContents(10, liveSessions.get(PARTITION))
    win.emit('did-attach-webview', {}, guest)
    expect(guest.close).not.toHaveBeenCalled()
    const open = guest.setWindowOpenHandler.mock.calls[0][0] as (d: { url: string }) => { action: string }
    expect(open({ url: 'https://purdue0.sharepoint.com/b.docx' })).toEqual({ action: 'deny' })
    expect(guest.loadURL).toHaveBeenCalledWith('https://purdue0.sharepoint.com/b.docx')
    expect(guest.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
    open({ url: 'https://example.com/a' })
    open({ url: 'https://example.com/b' })
    expect(shell.openExternal).toHaveBeenCalledTimes(1)
    const nav = { preventDefault: vi.fn() }
    guest.emit('will-navigate', nav, 'http://idp.purdue.edu/')
    expect(nav.preventDefault).toHaveBeenCalled()
    const nested = { preventDefault: vi.fn() }
    guest.emit('will-attach-webview', nested)
    expect(nested.preventDefault).toHaveBeenCalled()
  })
})

const key = (over: Partial<Parameters<typeof forwardedKey>[0]>): Parameters<typeof forwardedKey>[0] => ({ type: 'keyDown', key: 'a', code: 'KeyA', meta: false, control: false, shift: false, alt: false, ...over })

describe('the guest\'s keys', () => {
  it.each([
    ['⌘W', { key: 'w', code: 'KeyW', meta: true }],
    ['⌃Tab', { key: 'Tab', code: 'Tab', control: true }],
    ['⌃⇧Tab', { key: 'Tab', code: 'Tab', control: true, shift: true }],
    ['⌘1', { key: '1', code: 'Digit1', meta: true }],
    ['⌘9', { key: '9', code: 'Digit9', meta: true }],
    ['⌘⇧K', { key: 'K', code: 'KeyK', meta: true, shift: true }],
    ['⌘,', { key: ',', code: 'Comma', meta: true }]
  ])('forwards %s on a Mac', (_name, over) => expect(forwardedKey(key(over), 'darwin', false)).toBe(true))

  it.each([
    ['Ctrl+W', { key: 'w', code: 'KeyW', control: true }],
    ['Ctrl+Tab', { key: 'Tab', code: 'Tab', control: true }],
    ['Ctrl+3', { key: '3', code: 'Digit3', control: true }],
    ['Ctrl+Shift+K', { key: 'K', code: 'KeyK', control: true, shift: true }],
    ['Ctrl+,', { key: ',', code: 'Comma', control: true }]
  ])('forwards %s on Windows', (_name, over) => expect(forwardedKey(key(over), 'win32', false)).toBe(true))

  it.each([
    ['⌘S', { key: 's', code: 'KeyS', meta: true }],
    ['⌘F', { key: 'f', code: 'KeyF', meta: true }],
    ['⌘P', { key: 'p', code: 'KeyP', meta: true }],
    ['⌘Z', { key: 'z', code: 'KeyZ', meta: true }],
    ['⌘B', { key: 'b', code: 'KeyB', meta: true }],
    ['⌘K', { key: 'k', code: 'KeyK', meta: true }],
    ['⌘⇧W (the window)', { key: 'W', code: 'KeyW', meta: true, shift: true }],
    ['⌘0', { key: '0', code: 'Digit0', meta: true }],
    ['⌃W (not the Mac\'s chord)', { key: 'w', code: 'KeyW', control: true }],
    ['ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft' }],
    ['a', {}],
    ['Escape, not in Full Window', { key: 'Escape', code: 'Escape' }]
  ])('leaves %s to Word on a Mac', (_name, over) => expect(forwardedKey(key(over), 'darwin', false)).toBe(false))

  it('leaves Ctrl+S, Ctrl+F and Ctrl+P to Word on Windows, and ⌘W is not its chord', () => {
    for (const code of ['KeyS', 'KeyF', 'KeyP']) expect(forwardedKey(key({ key: code.slice(3).toLowerCase(), code, control: true }), 'win32', false)).toBe(false)
    expect(forwardedKey(key({ key: 'w', code: 'KeyW', meta: true }), 'win32', false)).toBe(false)
  })

  it('takes Escape only while the tab fills the window, and only bare', () => {
    expect(forwardedKey(key({ key: 'Escape', code: 'Escape' }), 'darwin', true)).toBe(true)
    expect(forwardedKey(key({ key: 'Escape', code: 'Escape', shift: true }), 'darwin', true)).toBe(false)
    expect(forwardedKey(key({ key: 'Escape', code: 'Escape' }), 'linux', true)).toBe(true)
  })

  it('hears only a key going down', () => {
    expect(forwardedKey(key({ type: 'keyUp', key: 'w', code: 'KeyW', meta: true }), 'darwin', false)).toBe(false)
  })

  it('counts his typing and the chords that change the file, not the others', () => {
    expect(typedKey(key({}))).toBe(true)
    expect(typedKey(key({ key: 'Enter', code: 'Enter' }))).toBe(true)
    expect(typedKey(key({ key: 'Backspace', code: 'Backspace' }))).toBe(true)
    expect(typedKey(key({ key: 'z', code: 'KeyZ', meta: true }))).toBe(true)
    expect(typedKey(key({ key: 'v', code: 'KeyV', control: true }))).toBe(true)
    expect(typedKey(key({ key: 'b', code: 'KeyB', meta: true }))).toBe(false)
    expect(typedKey(key({ key: 'ArrowLeft', code: 'ArrowLeft' }))).toBe(false)
    expect(typedKey(key({ type: 'keyUp' }))).toBe(false)
  })
})
