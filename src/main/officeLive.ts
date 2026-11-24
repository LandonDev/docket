import { app, ipcMain, session, shell, type BrowserWindow, type Session, type WebContents } from 'electron'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isMicrosoftUrl, plainChromeUa } from './server/work/office/addin/web'

/**
 * The fence round a live Office file (docs/agents/work-office-live.md "The fence"). A Files tab draws Word, Excel or
 * PowerPoint for the web in a `<webview>` guest: Microsoft's site with his session, which must never reach TempCode's
 * page, its keys, the preload's bridge or the local server.
 *
 * - A guest attaches only on a ticket the window's own top frame asked for: good once, for 10 s, for one exact `src`
 *   and partition. An iframe (an agent's page, the add-in pane) can hold none, so it cannot make a guest.
 * - At attach every preload goes and the guest is sandboxed, isolated, with no Node and no popups.
 * - Each Microsoft tenant has its own session (`persist:office-live-<tenant>`), plain Chrome's agent so passkeys show,
 *   every permission refused but the sanitized clipboard write, and no request that is not https (or wss) or that
 *   names this machine, a private network or a TempCode scheme.
 * - The first page is a Microsoft file; after that the guest may go anywhere over https (a school's sign-in passes
 *   through its own site). A new window that is Microsoft's loads in the same guest, anything else in his browser.
 */

export const LIVE_PARTITION_PREFIX = 'persist:office-live-'
export const TICKET_MS = 10_000

/** `purdue0` from `purdue0-my.sharepoint.com` or `purdue0.sharepoint.com`; null when the address is not SharePoint's. */
export function tenantOfUrl(url: string): string | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  const m = /^([a-z0-9][a-z0-9-]*?)(?:-my|-admin)?\.sharepoint\.com$/.exec(host)
  return m ? m[1] : null
}

/** The session a file's live view runs in: one per tenant, so one job's sign-in never serves another's. */
export function livePartition(url: string): string | null {
  const tenant = tenantOfUrl(url)
  return tenant ? `${LIVE_PARTITION_PREFIX}${tenant}` : null
}

export const isLivePartition = (partition: string | undefined | null): boolean =>
  !!partition && partition.startsWith(LIVE_PARTITION_PREFIX) && /^[a-z0-9-]+$/.test(partition.slice(LIVE_PARTITION_PREFIX.length))

// ── Tickets ───────────────────────────────────────────────────────────

export interface LiveTicket {
  /** The window's page that asked (its webContents id). */
  owner: number
  src: string
  partition: string
  at: number
}

export type TicketAnswer = { ok: true; src: string; partition: string } | { ok: false; error: string }

/** The tickets main holds: issued to a window's top frame, taken once by that window's attach. */
export class TicketStore {
  private readonly tickets: LiveTicket[] = []
  constructor(private readonly now: () => number = Date.now) {}

  issue(owner: number, url: string): TicketAnswer {
    if (!isMicrosoftUrl(url)) return { ok: false, error: 'Only a file in OneDrive, SharePoint or Teams opens live.' }
    const partition = livePartition(url)
    if (!partition) return { ok: false, error: 'Only a file in OneDrive, SharePoint or Teams opens live.' }
    this.sweep()
    this.tickets.push({ owner, src: url, partition, at: this.now() })
    return { ok: true, src: url, partition }
  }

  /** The ticket for this attach, used up; null when none matches exactly. */
  take(owner: number, src: string | undefined, partition: string | undefined): LiveTicket | null {
    this.sweep()
    const i = this.tickets.findIndex((t) => t.owner === owner && t.src === src && t.partition === partition)
    if (i < 0) return null
    return this.tickets.splice(i, 1)[0]
  }

  private sweep(): void {
    const now = this.now()
    for (let i = this.tickets.length - 1; i >= 0; i--) if (now - this.tickets[i].at > TICKET_MS) this.tickets.splice(i, 1)
  }
}

/** Who asked for a ticket: only a window's own page, never a frame inside it. */
export interface TicketSender {
  sender: { id: number; mainFrame: unknown }
  senderFrame: unknown
}

export function answerTicket(store: TicketStore, event: TicketSender, url: unknown): TicketAnswer {
  if (event.senderFrame !== event.sender.mainFrame) return { ok: false, error: 'Only the window itself can open a live file.' }
  if (typeof url !== 'string') return { ok: false, error: 'Only a file in OneDrive, SharePoint or Teams opens live.' }
  return store.issue(event.sender.id, url)
}

/**
 * The guest's preferences at attach, whatever the page asked for: no preload, sandboxed, isolated, no Node anywhere,
 * web security on, and the ticket's partition and address. Popups are dropped from the tag's own parameters.
 */
export function hardenAttach(prefs: Record<string, unknown>, params: Record<string, string>, ticket: LiveTicket): void {
  delete prefs.preload
  delete prefs.preloadURL
  prefs.sandbox = true
  prefs.contextIsolation = true
  prefs.nodeIntegration = false
  prefs.nodeIntegrationInSubFrames = false
  prefs.nodeIntegrationInWorker = false
  prefs.webSecurity = true
  prefs.allowRunningInsecureContent = false
  prefs.webviewTag = false
  prefs.partition = ticket.partition
  delete params.allowpopups
  delete params.preload
  delete params.nodeintegration
  delete params.nodeintegrationinsubframes
  delete params.disablewebsecurity
  delete params.webpreferences
  params.src = ticket.src
  params.partition = ticket.partition
}

// ── Requests ──────────────────────────────────────────────────────────

const ipv4 = (host: string): number[] | null => {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null
  const n = parts.map(Number)
  return n.every((x) => x <= 255) ? n : null
}

/** This machine, a private or link-local network, carrier NAT (his tailnet), or a multicast group. */
function privateV4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}

function privateV6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === '::' || h === '::1') return true
  if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^ff/.test(h)) return true
  // An IPv4 address carried in IPv6 (`::ffff:7f00:1`, `::ffff:127.0.0.1`, `::7f00:1`).
  const mapped = /^::(?:ffff:)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/.exec(h)
  if (mapped) {
    if (mapped[3]) return privateV4(ipv4(mapped[3]) ?? [0, 0])
    const hi = parseInt(mapped[1], 16)
    return privateV4([hi >> 8, hi & 255])
  }
  return false
}

/** Whether a host names this machine or a network of his rather than a site on the internet. */
export function localHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true
  if (host.startsWith('[') || host.includes(':')) return privateV6(host)
  const v4 = ipv4(host)
  if (v4) return privateV4(v4)
  // A single label (`router`, `box`) is a name on his own network.
  return !host.includes('.')
}

/**
 * Whether the guest's session cancels a request: anything not over https (wss for a socket), and anything to this
 * machine or his own networks. The URL parser has already made every form of an address plain (`127.1`,
 * `0x7f000001` and `2130706433` all read `127.0.0.1`). Pages made in the guest itself (data, blob) pass.
 */
export function blockedRequest(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return true
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return false
  if (u.protocol !== 'https:' && u.protocol !== 'wss:') return true
  return localHost(u.hostname)
}

/** The one permission a guest is granted: writing to the clipboard what Word copies. */
export const livePermission = (permission: string): boolean => permission === 'clipboard-sanitized-write'

/** Where a new window from the guest goes: Microsoft's in the guest, other web pages to his browser, nothing else. */
export function openTarget(url: string): 'guest' | 'browser' | 'none' {
  if (isMicrosoftUrl(url)) return 'guest'
  return /^https?:/i.test(url) && !blockedRequest(url.replace(/^http:/i, 'https:')) ? 'browser' : 'none'
}

/** A top-level page move: https only. A frame inside it may also be about:, blob: or data:. */
export const navigationAllowed = (url: string, frame: 'main' | 'sub'): boolean =>
  frame === 'main' ? /^https:/i.test(url) && !blockedRequest(url) : /^(about:|blob:|data:)/i.test(url) || (/^https:/i.test(url) && !blockedRequest(url))

// ── Keys ──────────────────────────────────────────────────────────────

/** What a key is to the guest's `before-input-event` (Electron's `Input`, the fields read here). */
export interface LiveInput {
  type: string
  key: string
  code: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
  isAutoRepeat?: boolean
}

/**
 * The guest's keys that are TempCode's, not Word's (docs/agents/work-office-live.md "Keys and menus"): Close Tab,
 * the tab chords (⌃Tab, ⌃⇧Tab, ⌘1 to ⌘9), Search Work, Settings, and Escape while the tab fills the window. Each is
 * stopped at the guest and played to the window's page as the same keydown. Every other key is Word's: ⌘S, ⌘F, ⌘P,
 * ⌘Z, ⌘B, ⌘K and the arrows among them.
 */
export function forwardedKey(input: LiveInput, platform: NodeJS.Platform, fullWindow: boolean): boolean {
  if (input.type !== 'keyDown') return false
  const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  if (input.key === 'Escape') return fullWindow && !input.meta && !input.control && !input.alt && !input.shift
  if (input.code === 'Tab' || input.key === 'Tab') return input.control && !input.meta && !input.alt
  if (!mod || input.alt) return false
  if (input.code === 'KeyW' || input.key.toLowerCase() === 'w') return !input.shift
  if (/^Digit[1-9]$/.test(input.code)) return !input.shift
  if (input.code === 'KeyK' || input.key.toLowerCase() === 'k') return input.shift
  if (input.code === 'Comma' || input.key === ',') return !input.shift
  return false
}

/** The keydown the page is played for a forwarded key. */
export function keyInit(input: LiveInput): { key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean } {
  return { key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, shiftKey: input.shift, altKey: input.alt }
}

/** Whether a key is his typing in the file (a character, Enter, Backspace, Delete), counted for the switch back. */
export const typedKey = (input: LiveInput): boolean =>
  input.type === 'keyDown' && !input.meta && !(input.control && !input.alt) && (input.key.length === 1 || input.key === 'Enter' || input.key === 'Backspace' || input.key === 'Delete')

// ── Electron ──────────────────────────────────────────────────────────

const store = new TicketStore()
const sessions = new WeakSet<Session>()

/** Each live guest by its webContents id: the window that holds it, whether its tab fills the window, his typing. */
interface Guest {
  contents: WebContents
  owner: number
  fullWindow: boolean
  typed: number
  /** Set while the tab asked to close over Word's "still saving": the next hold is let go. */
  force: boolean
  onHold: (() => void) | null
}
const guests = new Map<number, Guest>()

/** A tenant's session, made ready once: its agent, permissions, the request block and downloads by his save dialog. */
export function liveSession(partition: string): Session {
  const ses = session.fromPartition(partition)
  if (sessions.has(ses)) return ses
  sessions.add(ses)
  ses.setUserAgent(plainChromeUa(ses.getUserAgent()))
  ses.setPermissionRequestHandler((_wc, permission, done) => done(livePermission(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => livePermission(permission))
  ses.setDevicePermissionHandler(() => false)
  ses.webRequest.onBeforeRequest((details, done) => done({ cancel: blockedRequest(details.url) }))
  // Word's Download a copy and its print PDF: his own save dialog, never a path of ours.
  ses.on('will-download', (_e, item) => item.setSaveDialogOptions({ title: 'Save a copy' }))
  return ses
}

/** The guest once attached: where it may go and what opens elsewhere. */
function fenceGuest(guest: WebContents): void {
  guest.setWindowOpenHandler(({ url }) => {
    const to = openTarget(url)
    if (to === 'guest') void guest.loadURL(url)
    else if (to === 'browser') void shell.openExternal(url)
    return { action: 'deny' }
  })
  const top = (e: { preventDefault(): void }, to: string): void => {
    if (!navigationAllowed(to, 'main')) e.preventDefault()
  }
  guest.on('will-navigate', (e, to) => top(e, to))
  guest.on('will-redirect', (e, to) => top(e, to))
  guest.on('will-frame-navigate', (e) => {
    if (!navigationAllowed(e.url, e.isMainFrame ? 'main' : 'sub')) e.preventDefault()
  })
  // No guest of a guest.
  guest.on('will-attach-webview', (e) => e.preventDefault())
}

/** A guest's keys and unload, heard for the window that holds it. */
function hearGuest(win: BrowserWindow, guest: WebContents): void {
  const entry: Guest = { contents: guest, owner: win.webContents.id, fullWindow: false, typed: 0, force: false, onHold: null }
  const id = guest.id
  guests.set(id, entry)
  guest.once('destroyed', () => guests.delete(id))
  guest.on('before-input-event', (event, input) => {
    if (forwardedKey(input, process.platform, entry.fullWindow)) {
      // Stops the page and the menu alike (Electron's rule): the window's page hears it once, as its own key.
      event.preventDefault()
      if (!win.isDestroyed()) win.webContents.send('office-live:key', keyInit(input))
      return
    }
    if (typedKey(input)) entry.typed++
  })
  // Word holds the unload while it is still saving: the tab hears so, and only his "Close anyway" lets it go.
  guest.on('will-prevent-unload', (event) => {
    if (entry.force) {
      event.preventDefault()
      return
    }
    entry.onHold?.()
  })
}

export type UnloadAnswer = 'unloaded' | 'holding' | 'gone'

/** Leaves the file (Live → Edit here, or the tab closing): about:blank, unless Word holds it. */
function unloadGuest(entry: Guest, force: boolean): Promise<UnloadAnswer> {
  entry.force = force
  return new Promise((resolve) => {
    const done = (answer: UnloadAnswer): void => {
      clearTimeout(timer)
      entry.onHold = null
      entry.contents.off('did-navigate', navigated)
      resolve(answer)
    }
    const navigated = (_e: unknown, url: string): void => {
      if (url === 'about:blank') done('unloaded')
    }
    const timer = setTimeout(() => done('holding'), 12_000)
    entry.onHold = () => done('holding')
    entry.contents.on('did-navigate', navigated)
    entry.contents.loadURL('about:blank').catch(() => {})
  })
}

/** The guest a window's own page names, or null when it is not that window's. */
function ownGuest(event: TicketSender, guestId: unknown): Guest | null {
  if (event.senderFrame !== event.sender.mainFrame || typeof guestId !== 'number') return null
  const entry = guests.get(guestId)
  return entry && entry.owner === event.sender.id && !entry.contents.isDestroyed() ? entry : null
}

/** The fence on one of his windows: every `<webview>` it would make is refused unless its page holds a ticket. */
export function attachLiveFence(win: BrowserWindow): void {
  const owner = win.webContents.id
  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    const ticket = store.take(owner, params.src, params.partition)
    if (!ticket) {
      event.preventDefault()
      return
    }
    liveSession(ticket.partition)
    hardenAttach(prefs as unknown as Record<string, unknown>, params, ticket)
  })
  win.webContents.on('did-attach-webview', (_event, guest) => {
    // Only a guest the attach let through runs: on one of the live sessions.
    if (!sessions.has(guest.session)) {
      guest.close()
      return
    }
    fenceGuest(guest)
    hearGuest(win, guest)
  })
}

/** The partitions that exist on disk (`Partitions/office-live-*`), by their folder names. */
export function livePartitionsIn(names: readonly string[]): string[] {
  return names.filter((n) => /^office-live-[a-z0-9-]+$/.test(n)).map((n) => `persist:${n}`)
}

/**
 * At start: no word of a live file stays on this machine. Each live session's HTTP cache, cache storage and service
 * workers go; its cookies and local storage stay, so his sign-in lasts.
 */
export async function clearLiveCaches(): Promise<void> {
  let names: string[] = []
  try {
    names = readdirSync(join(app.getPath('userData'), 'Partitions'))
  } catch {
    return
  }
  for (const partition of livePartitionsIn(names)) {
    const ses = session.fromPartition(partition)
    await ses.clearCache().catch(() => {})
    await ses.clearStorageData({ storages: ['cachestorage', 'serviceworkers', 'shadercache'] }).catch(() => {})
  }
}

/** Main's side: the ticket IPC and the caches cleared (`windows.ts` puts `attachLiveFence` on each window). */
export function registerOfficeLive(): void {
  ipcMain.handle('office-live:ticket', (event, url: unknown) => answerTicket(store, event, url))
  ipcMain.handle('office-live:full-window', (event, guestId: unknown, on: unknown) => {
    const entry = ownGuest(event, guestId)
    if (entry) entry.fullWindow = on === true
  })
  /** How many keys he typed in the file since it opened: the switch back waits for OneDrive when any. */
  ipcMain.handle('office-live:typed', (event, guestId: unknown) => ownGuest(event, guestId)?.typed ?? 0)
  ipcMain.handle('office-live:unload', (event, guestId: unknown, force: unknown): Promise<UnloadAnswer> => {
    const entry = ownGuest(event, guestId)
    return entry ? unloadGuest(entry, force === true) : Promise.resolve('gone')
  })
  void clearLiveCaches()
}
