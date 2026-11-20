/**
 * The host's own reading of whether a computer act sends something out
 * (docs/computer-protocol.md §19.3 "The hold in a Work thread",
 * docs/agents/work-outbox.md). In a Work thread the host classes each call
 * from what is on the screen, whatever the model flagged: a tricked model
 * is exactly the one that will not flag its click on Send.
 *
 * What is held:
 *  - a click, a press or a pick on a control named for an outward act
 *    (`OUTWARD_VERBS`), or on anything inside one; a click by position that
 *    lands on such a control, when the screen was read with frames; a press
 *    with no target of its own where the pointer was last put;
 *  - a menu item picked by a path any part of which is such a name, outside
 *    the menus that only edit what is in front of the person;
 *  - Return, a typed line break or `confirm` in the message box of a chat
 *    app or page, in a field whose surroundings hold such a control, in a
 *    sheet or dialog whose default may be one, or with the focus on one;
 *    Shift or Option with Return is a new line and is not;
 *  - Command or Control with Return wherever that sends or submits, a mail
 *    app or page included, and ⇧⌘D in a mail app;
 *  - Space or Return with the focus on such a control.
 *
 * What this cannot catch, in the same class as the unfenced shell: a click
 * by position on a control the screen reader gives no name (a canvas app,
 * a remote desktop, a picture of a button); a control named for something
 * off the list; an act split so that no single call reads as outward; a
 * web address opened in a browser whose page acts on being fetched (a
 * one-click unsubscribe link). The hold does not claim otherwise.
 */
import { sha256Hex } from '../sha256'
import { parseKeyCombo, parseObservation, type Modifier } from './observation'
import type { ComputerAction } from './protocol'
import { menuPathSegments } from './tools'

/**
 * Names of controls that send, post, pay, share, delete or answer for the
 * person. A control's name fits when it is one of these or starts with one
 * and a space ("Send now", "Reply to all", "Pay $12.00", "Delete draft…").
 * Lower case; the list is data, and an app's own form goes here.
 */
export const OUTWARD_VERBS = [
  'send',
  'send now',
  'reply',
  'reply all',
  'forward',
  'post',
  'publish',
  'share',
  'submit',
  'sign',
  'pay',
  'pay now',
  'buy',
  'buy now',
  'purchase',
  'complete purchase',
  'order',
  'place order',
  'checkout',
  'check out',
  'confirm',
  'accept',
  'approve',
  'decline',
  'reject',
  'delete',
  'remove',
  'invite',
  'book',
  'subscribe',
  'unsubscribe',
  'transfer',
  'donate',
  'comment',
  'tweet',
  'rsvp'
] as const

/**
 * The names Return carries out from a text field. Narrower than the whole
 * list: Return in a rename field beside a toolbar's Share or Delete button
 * sends nothing, and holding it would hold every rename.
 */
export const RETURN_VERBS: readonly string[] = ['send', 'send now', 'reply', 'reply all', 'forward', 'post', 'publish', 'submit', 'sign', 'pay', 'pay now', 'buy', 'buy now', 'purchase', 'complete purchase', 'place order', 'checkout', 'check out', 'confirm', 'book', 'subscribe', 'transfer', 'donate', 'comment', 'tweet', 'rsvp']

/** Names that start like an outward verb and are not one. */
const NOT_OUTWARD: readonly RegExp[] = [
  /^sign (in|up|out|on|off)\b/,
  /^order by\b/,
  /^send (to back|backward|backwards)\b/,
  /^share (screen|my screen)\b/,
  /^(post|book|sign|order|comment)s\b/,
  /^forward (delete|one|to the)\b/,
  /^remove (formatting|filter|filters|sort)\b/,
  /^delete (word|line|character|to)\b/
]

/** Bundle ids of chat and mail apps: Return in their message box sends. */
export const CHAT_APP_BUNDLES: readonly string[] = [
  'com.microsoft.teams',
  'com.microsoft.teams2',
  'com.tinyspeck.slackmacgap',
  'com.hnc.Discord',
  'com.apple.MobileSMS',
  'com.apple.mail',
  'com.microsoft.Outlook',
  'net.whatsapp.WhatsApp',
  'WhatsApp',
  'ru.keepcoder.Telegram',
  'org.telegram.desktop',
  'com.facebook.archon',
  'org.whispersystems.signal-desktop',
  'us.zoom.xos',
  'com.readdle.smartemail-Mac',
  'com.superhuman.electron',
  'com.linear',
  'com.tencent.xinWeChat',
  'org.mozilla.thunderbird',
  'com.skype.skype',
  'im.riot.app',
  'jp.naver.line.mac',
  'com.automattic.beeper.desktop',
  'com.mimestream.Mimestream',
  'it.bloop.airmail2',
  'com.hey.app.desktop',
  'Mattermost.Desktop',
  'com.wearezeta.zclient.mac',
  'chat.rocket',
  'org.zulip.zulip-electron',
  'keybase.Electron',
  // Windows, by exe as tc-computer.exe names an app (§29.2)
  'ms-teams.exe',
  'teams.exe',
  'slack.exe',
  'discord.exe',
  'whatsapp.exe',
  'telegram.exe',
  'signal.exe',
  'zoom.exe',
  'outlook.exe',
  'olk.exe',
  'thunderbird.exe'
]
/** The same apps by the name the app list shows, for a call that names no bundle, and for a chat page installed as an app of its own. */
export const CHAT_APP_NAMES: readonly string[] = [
  'microsoft teams',
  'teams',
  'slack',
  'discord',
  'messages',
  'mail',
  'outlook',
  'microsoft outlook',
  'whatsapp',
  'telegram',
  'messenger',
  'signal',
  'zoom',
  'spark',
  'superhuman',
  'wechat',
  'thunderbird',
  'skype',
  'element',
  'line',
  'beeper',
  'mimestream',
  'airmail',
  'hey',
  'mattermost',
  'gmail',
  'google chat',
  'google messages',
  'instagram',
  'linkedin'
]
/** Mail apps. Return in a mail is a new line: only the chords send there (⌘Return, Ctrl+Return, ⇧⌘D). */
const MAIL_APP = /(^|\.)(mail|outlook|smartemail|superhuman|thunderbird|mimestream|airmail|gmail)/i
/** Pages that are mail, by host: judged as a mail app is. */
export const MAIL_HOSTS: readonly string[] = ['mail.google.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.live.com', 'outlook.cloud.microsoft', 'mail.proton.me', 'mail.yahoo.com', 'app.fastmail.com', 'icloud.com']
/** Menus that only edit what is in front of the person: Edit > Delete removes a selection, it sends nothing. */
const LOCAL_MENUS = ['edit', 'format', 'view', 'arrange', 'insert', 'window', 'help', 'selection', 'go', 'table', 'tools', 'history', 'bookmarks']
/** The names a multi-line box's own surroundings must hold for plain Return in it to send: a chat composer's. */
const COMPOSER_VERBS: readonly string[] = ['send', 'send now']

/** Browsers: a page's host decides, read from the address bar. */
export const BROWSER_BUNDLES: readonly string[] = [
  'com.google.Chrome',
  'com.google.Chrome.canary',
  'com.google.chrome.for.testing',
  'com.apple.Safari',
  'com.microsoft.edgemac',
  'company.thebrowser.Browser',
  'com.brave.Browser',
  'org.mozilla.firefox',
  'com.vivaldi.Vivaldi',
  'com.operasoftware.Opera',
  // the box's own Chromium (work/browser/box): its service names it so
  'org.chromium.Chromium',
  // Windows, by exe (§29.2)
  'msedge.exe',
  'chrome.exe',
  'firefox.exe',
  'brave.exe',
  'vivaldi.exe',
  'opera.exe',
  'arc.exe'
]
/** A page installed as an app of its own runs in its browser's bundle with this before its id. */
const WEB_APP_BUNDLE = /^(com\.google\.Chrome|com\.microsoft\.edgemac|com\.brave\.Browser)\.app\./i
/** Hosts whose pages are chat or mail: Return in their message box sends. A host fits itself and its subdomains. */
export const CHAT_HOSTS: readonly string[] = [
  'teams.microsoft.com',
  'teams.live.com',
  'teams.cloud.microsoft',
  'app.slack.com',
  'discord.com',
  'web.whatsapp.com',
  'web.telegram.org',
  'web.skype.com',
  'messages.google.com',
  'chat.google.com',
  'mail.google.com',
  'outlook.office.com',
  'outlook.office365.com',
  'outlook.live.com',
  'outlook.cloud.microsoft',
  'mail.proton.me',
  'mail.yahoo.com',
  'app.fastmail.com',
  'icloud.com',
  'messenger.com',
  'instagram.com',
  'linkedin.com',
  'x.com',
  'facebook.com'
]

export interface ScreenElement {
  index: number
  role: string
  name?: string
  value?: string
  states: readonly string[]
  /** the actions the element lists beyond its role's own (`press`, `confirm`, …) */
  actions: readonly string[]
  parent: number | null
  /** in the call's coordinate space; present only when the screen was read with frames */
  frame?: { x: number; y: number; w: number; h: number }
}

/** A window as the host read it: its elements by index, with who sits in whom. */
export interface Screen {
  app: { bundleId: string | null; name: string }
  focused: number | null
  elements: ReadonlyMap<number, ScreenElement>
  /** the window's title as the host last read it, where it knows one: it tells the Run box from Explorer */
  title?: string | null
}

/** What the host read as outward: which step, and what it would carry out. */
export interface OutwardRead {
  /** the step, 0-based */
  step: number
  why: 'control' | 'position' | 'menu' | 'key' | 'chord' | 'typed' | 'console'
  /** the act's own word, as the button says it: "Send" */
  label: string
  /** what the step lands on, for the card: `button "Send"`, `Return in text area "Message"` */
  on: string
  /** no grant may be made from it: an act in a command line runs whatever it says (`consoleRead`) */
  grantable?: false
}

/**
 * Windows' command lines, by the exe the service names an app by (§29.2): a
 * console or a terminal (cmd and PowerShell open inside Windows Terminal on
 * Windows 11, with OpenConsole behind it), a shell, and the script hosts.
 * Any act that writes or clicks in one runs as a command whatever it says (a
 * click in a classic console pastes the clipboard), so it is held, and no
 * grant is made from it.
 */
export const CONSOLE_EXES: readonly string[] = [
  'windowsterminal.exe',
  'openconsole.exe',
  'conhost.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'powershell_ise.exe',
  'wsl.exe',
  'bash.exe'
]

/** Windows' boxes that run what is typed into them, by their app and their window's title. */
const RUN_BOXES: readonly { exe: string; title: RegExp }[] = [
  { exe: 'explorer.exe', title: /^run$/i },
  { exe: 'taskmgr.exe', title: /^create new task$/i }
]

/** The steps that do nothing to a window: a look, a wait, a move or a scroll. Any other step writes or clicks. */
const LEAVES_IT: readonly string[] = ['screenshot', 'zoom', 'cursor_position', 'wait', 'mouse_move', 'scroll']

/**
 * A step that writes or clicks in a command line (`CONSOLE_EXES`), the Run
 * box or Task Manager's "Create new task", read as outward whatever it says;
 * null for any other window. It is never grantable.
 */
export function consoleRead(steps: readonly ComputerAction[], screen: Screen | null): OutwardRead | null {
  const exe = screen?.app.bundleId?.toLowerCase() ?? null
  if (!exe) return null
  const title = screen?.title?.trim() ?? ''
  const console = CONSOLE_EXES.includes(exe)
  const box = !console && RUN_BOXES.some((b) => b.exe === exe && b.title.test(title))
  if (!console && !box) return null
  const step = steps.findIndex((a) => !LEAVES_IT.includes(a.action))
  if (step < 0) return null
  const a = steps[step]!
  const typed = a.action === 'type' || a.action === 'paste' || a.action === 'set_value' ? (a.text ?? '') : a.action === 'key' || a.action === 'hold_key' ? (a.text ?? '') : null
  const where = box ? `the ${title || 'Run'} box` : screen!.app.name
  return { step, why: 'console', label: 'Run', on: typed !== null && typed !== '' ? `${a.action === 'key' || a.action === 'hold_key' ? 'keys' : 'text'} "${typed}" in ${where}` : `${a.action.replace(/_/g, ' ')} in ${where}`, grantable: false }
}

const TEXT_ROLES = ['input', 'text area', 'combo box', 'search', 'password', 'date']
/** Roles a click or a key press carries out by themselves. */
const CONTROL_ROLES = ['button', 'link', 'menu item', 'menu button']
/** What the focus sits on when a page or a list has it, and no single control does. */
const CONTAINER_ROLES = ['group', 'web area', 'row', 'cell', 'list', 'table', 'outline', 'scroll area', 'window', 'sheet', 'dialog']
/**
 * How many words a control's name may run on past the verb, by role. A
 * button says what it does ("Send message to Dana Lee and 3 others"); a
 * link or an icon says it briefly ("Pay now"); a row, a cell or a line of
 * text is content (a mail whose subject begins "Order confirmation…"), so
 * only the bare verb counts there (a page's own "Send" drawn as plain text).
 */
const EXTRA_WORDS: Readonly<Record<string, number>> = { button: 12, 'menu item': 12, 'menu button': 12, link: 2, image: 2, tab: 1 }
const NAMED_EXTRA = 12
/** What a field sits in, for "its surroundings hold a Send". */
const NEAR_ROLES = ['group', 'sheet', 'dialog', 'toolbar', 'row', 'cell', 'list', 'table', 'outline', 'tabs', 'tab', 'split', 'scroll area', 'popover']
const WIDE_ROLES = ['window', 'web area']
/** The most elements a container may hold to count as a field's near surroundings. */
const NEAR_MAX = 60
/** In a whole window or page, only the names Return plainly carries out from a field. */
const WIDE_VERBS: readonly string[] = RETURN_VERBS.filter((v) => !['comment', 'confirm', 'book', 'sign'].includes(v))
/** A sheet or a dialog whose own default is one of these takes Return itself: Save, OK, Open and the like send nothing. */
const SAFE_DEFAULTS = ['save', 'ok', 'done', 'open', 'choose', 'create', 'rename', 'go', 'next', 'continue', 'add', 'apply', 'close', 'search', 'find', 'replace', 'print', 'export', 'move', 'copy', 'select', 'insert']

const norm = (name: string): string =>
  name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[…]|\.{3}/g, '')
    .replace(/[^\p{L}\p{N}$€£ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** The outward verb a control's name carries, or null: "Send", "send now", "Reply to all", "Pay $12.00". */
export function outwardVerb(name: string | undefined | null, verbs: readonly string[] = OUTWARD_VERBS, extraWords = NAMED_EXTRA): string | null {
  if (!name) return null
  const n = norm(name)
  if (!n || NOT_OUTWARD.some((re) => re.test(n))) return null
  let best: string | null = null
  for (const verb of verbs) {
    if (n !== verb && !n.startsWith(`${verb} `)) continue
    const more = n === verb ? 0 : n.slice(verb.length + 1).split(' ').length
    if (more <= extraWords && (!best || verb.length > best.length)) best = verb
  }
  return best
}

const cap = (word: string): string => word[0]!.toUpperCase() + word.slice(1)
const say = (e: ScreenElement): string => (e.name !== undefined ? `${e.role} ${JSON.stringify(e.name)}` : e.role)

/** A screen from an observation's text (§4.1): a full read, with frames when it was asked for them. Null when the text is off the grammar. */
export function screenOfObservation(text: string, app: Screen['app']): Screen | null {
  let parsed: ReturnType<typeof parseObservation>
  try {
    parsed = parseObservation(text.replace(/\n+$/, ''))
  } catch {
    return null
  }
  const elements = new Map<number, ScreenElement>()
  const stack: (number | null)[] = []
  for (const l of parsed.lines) {
    if (l.type === 'menuBar') {
      const parent = l.depth <= 0 ? null : (stack[l.depth - 1] ?? null)
      elements.set(l.index, { index: l.index, role: 'menu', name: l.title, states: [], actions: [], parent })
      for (const item of l.items) elements.set(item.index, { index: item.index, role: 'menu item', name: item.name, states: item.disabled ? ['disabled'] : [], actions: [], parent: l.index })
      stack[l.depth] = l.index
      stack.length = l.depth + 1
      continue
    }
    if (l.type !== 'element' && l.type !== 'range') continue
    const parent = l.depth <= 0 ? null : (stack[l.depth - 1] ?? null)
    if (l.type === 'element') {
      elements.set(l.index, {
        index: l.index,
        role: l.role,
        ...(l.name !== undefined ? { name: l.name } : {}),
        ...(l.value !== undefined ? { value: l.value } : {}),
        states: l.states,
        actions: l.actions,
        parent,
        ...(l.frame ? { frame: l.frame } : {})
      })
      stack[l.depth] = l.index
    } else {
      for (let i = l.first; i <= l.last; i++) elements.set(i, { index: i, role: l.role, states: [], actions: [], parent })
      stack[l.depth] = null
    }
    stack.length = l.depth + 1
  }
  return { app, focused: parsed.header.focused ?? null, elements }
}

/** What the thread's own book of elements answers (computer/elements.ts): each element's line and its ancestors. */
export interface BookLike {
  size: number
  focused: number | null
  brief(index: number): { index: number; line: string } | null
  path(index: number): { index: number; line: string }[]
}

/** A screen from the thread's book: each line read by the observation's own grammar, so a role of two words, a value and a state are what they are. No frames. */
export function screenOfBook(book: BookLike, app: Screen['app']): Screen {
  const elements = new Map<number, ScreenElement>()
  // Indices are never reused and never dense: walk until every entry the book holds was found.
  for (let i = 1, found = 0; found < book.size && i < 200_000; i++) {
    const brief = book.brief(i)
    if (!brief) continue
    found++
    const parent = book.path(i)[0]?.index ?? null
    let line: ReturnType<typeof parseObservation>['lines'][number] | undefined
    try {
      line = parseObservation(`app "" · window "" · 1×1\n[${i}] ${brief.line}`).lines[0]
    } catch {
      // a line off the grammar keeps the words before its first quote as its role
    }
    if (line?.type === 'element')
      elements.set(i, { index: i, role: line.role, ...(line.name !== undefined ? { name: line.name } : {}), ...(line.value !== undefined ? { value: line.value } : {}), states: line.states, actions: line.actions, parent })
    else elements.set(i, { index: i, role: brief.line.split(' "')[0]!.split(' = ')[0]!.trim(), states: [], actions: [], parent })
  }
  return { app, focused: book.focused, elements }
}

function ancestors(screen: Screen, index: number): ScreenElement[] {
  const out: ScreenElement[] = []
  const seen = new Set<number>([index])
  for (let at = screen.elements.get(index)?.parent ?? null; at !== null && !seen.has(at); at = screen.elements.get(at)?.parent ?? null) {
    const e = screen.elements.get(at)
    if (!e) break
    seen.add(at)
    out.push(e)
  }
  return out
}

function under(screen: Screen, root: number): ScreenElement[] {
  const kids = new Map<number, ScreenElement[]>()
  for (const e of screen.elements.values()) if (e.parent !== null) kids.set(e.parent, [...(kids.get(e.parent) ?? []), e])
  const out: ScreenElement[] = []
  const walk = (at: number, depth: number): void => {
    if (depth > 64) return
    for (const kid of kids.get(at) ?? []) {
      out.push(kid)
      walk(kid.index, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/** Whether a press on the element carries something out: a control by its role, or anything that lists `press`. */
const pressable = (e: ScreenElement): boolean => CONTROL_ROLES.includes(e.role) || e.actions.includes('press') || e.actions.includes('pick') || e.actions.includes('open')

/**
 * The verb an element carries, by how much its role may say. A line of
 * text prints its string as its value, so that is its name. A control with
 * no name of its own (a page's clickable box) is named by the few words and
 * icons inside it.
 */
function verbOf(screen: Screen, e: ScreenElement, verbs: readonly string[] = OUTWARD_VERBS): string | null {
  const extra = EXTRA_WORDS[e.role] ?? (pressable(e) ? 2 : 0)
  const own = outwardVerb(e.role === 'text' ? (e.name ?? e.value) : e.name, verbs, extra)
  if (own || e.name !== undefined || !pressable(e)) return own
  // The words and icons inside name the box only when they are few: a row of a list (a sender, a subject, a date) is
  // content, and opening a mail whose subject begins "Pay your invoice" pays nothing.
  const labels = under(screen, e.index)
    .filter((x) => ['text', 'image', 'heading'].includes(x.role))
    .map((x) => x.name ?? (x.role === 'image' ? undefined : x.value))
    .filter((label): label is string => !!label?.trim())
  if (!labels.length || labels.length > 3 || labels.join(' ').trim().split(/\s+/).length > 4) return null
  for (const label of labels) {
    const verb = outwardVerb(label, verbs, 2)
    if (verb) return verb
  }
  return null
}

/**
 * A cookie banner's own button answers a site, not a person: the one
 * outward-looking name the hold lets through, and only when the button
 * itself says cookies ("Accept all cookies", "Reject cookies"). Words
 * beside a button are the page's to write, so they unlock nothing: a plain
 * "Accept" on a banner is held and costs a press.
 */
const cookieName = (name: string | undefined, verb: string): boolean => ['accept', 'decline', 'reject'].includes(verb) && /\bcookies?\b/i.test(name ?? '')
const cookieButton = (e: ScreenElement, verb: string): boolean => cookieName(e.name, verb)

/** The browser's own Forward goes through pages: outside any page, beside its Back. A page's Forward is the page's. */
function navForward(screen: Screen, e: ScreenElement, verb: string): boolean {
  if (verb !== 'forward') return false
  if (ancestors(screen, e.index).some((a) => a.role === 'web area')) return false
  return [...screen.elements.values()].some((x) => x.index !== e.index && x.parent === e.parent && /^(back|go back)$/.test(norm(x.name ?? '')))
}

/** `live`: a control the read shows disabled counts too. A composer's Send is disabled until its box holds text, and the read is taken before the call's own typing. */
const sends = (screen: Screen, e: ScreenElement, verbs: readonly string[] = OUTWARD_VERBS, live = false): string | null => {
  if (e.states.includes('disabled') && !live) return null
  const verb = verbOf(screen, e, verbs)
  return verb && !cookieButton(e, verb) && !navForward(screen, e, verb) ? verb : null
}

/** The outward control a click on `index` carries out: the element itself, or the control it sits in. */
function outwardControl(screen: Screen, index: number, verbs: readonly string[] = OUTWARD_VERBS): { element: ScreenElement; verb: string } | null {
  const self = screen.elements.get(index)
  if (!self) return null
  // A field's name is its label ("Send to:"), not what a click on it does.
  const chain = [...(TEXT_ROLES.includes(self.role) ? [] : [self]), ...ancestors(screen, index).filter(pressable)]
  for (const e of chain) {
    // A control the read shows disabled is held all the same: the call's own typing may have enabled it since.
    const verb = sends(screen, e, verbs, true)
    if (verb) return { element: e, verb }
  }
  return null
}

/** The deepest element whose frame holds a point: what a click by position lands on. */
function elementAt(screen: Screen, point: readonly number[]): number | null {
  const [x, y] = point as [number, number]
  let best: ScreenElement | null = null
  for (const e of screen.elements.values()) {
    const f = e.frame
    if (!f || f.w <= 0 || f.h <= 0 || x < f.x || y < f.y || x >= f.x + f.w || y >= f.y + f.h) continue
    if (!best || f.w * f.h <= best.frame!.w * best.frame!.h) best = e
  }
  return best?.index ?? null
}

/** A name as the service matches it (NamedTarget.swift): trimmed, three dots read as an ellipsis; `nameKey` case-blind. */
const nameExact = (name: string): string => name.trim().replace(/\.\.\./g, '…')
const nameKey = (name: string): string => nameExact(name).toLowerCase()
/** A line of text is named by its string. */
const ownName = (e: ScreenElement): string | undefined => (e.role === 'text' ? (e.name ?? e.value) : e.name)

/** Every element a step's `named` may resolve to when it runs, in reading order. */
function namedElements(screen: Screen, name: string): number[] {
  const want = nameKey(name)
  if (!want) return []
  return [...screen.elements.values()]
    .filter((e) => {
      const own = ownName(e)
      return own !== undefined && nameKey(own) === want
    })
    .map((e) => e.index)
    .sort((a, b) => a - b)
}

/** The one element a name finds as the service picks it: an exact name before a case-blind one, among several the one that acts by itself; null for none, or still several. */
function namedTarget(screen: Screen, name: string): number | null {
  const hits = namedElements(screen, name)
  const exact = hits.filter((i) => nameExact(ownName(screen.elements.get(i)!)!) === nameExact(name))
  const pool = exact.length ? exact : hits
  const acting = pool.filter((i) => pressable(screen.elements.get(i)!))
  const one = acting.length ? acting : pool
  return one.length === 1 ? one[0]! : null
}

/** The one element a pointer is on: the element it was put on, what lies under its point, or the one control its name finds; null when nobody can tell. */
function pointedAt(screen: Screen, p: PointerAt): number | null {
  if (!p) return null
  if ('element' in p) return screen.elements.has(p.element) ? p.element : null
  if ('coordinate' in p) return elementAt(screen, p.coordinate)
  return namedTarget(screen, p.named)
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

const inPage = (screen: Screen, index: number): boolean => ancestors(screen, index).some((a) => a.role === 'web area')

/** The browser's own address field: named as one, else the one field outside every page whose value is an address. */
function addressField(screen: Screen): ScreenElement | null {
  const fields = [...screen.elements.values()].filter((e) => ['input', 'combo box', 'search'].includes(e.role) && !inPage(screen, e.index))
  return fields.find((e) => /address|url|location|search or enter|search or type/i.test(e.name ?? '')) ?? fields.find((e) => !!e.value && /^[\w.-]+\.[a-z]{2,}(\/|$|:)|^https?:\/\//i.test(e.value.trim())) ?? null
}

/** The page's host in a browser window, read from its address bar. */
function pageHost(screen: Screen): string | null {
  const value = addressField(screen)?.value?.trim().split(/\s/)[0]
  const host = value ? hostOf(value) : null
  return host && host.includes('.') ? host : null
}

/** A chat that lives on a mail host, by where its page is: Google Chat inside Gmail. */
function chatPath(screen: Screen): boolean {
  const value = addressField(screen)?.value?.trim().split(/\s/)[0] ?? ''
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)
    return (url.hostname === 'mail.google.com' && /^\/(chat|mail\/u\/\d+\/#chat)/.test(url.pathname + url.hash)) || (/^outlook\./.test(url.hostname) && /\/teams(\/|$)/.test(url.pathname))
  } catch {
    return false
  }
}

const isWebApp = (app: Screen['app']): boolean => !!app.bundleId && WEB_APP_BUNDLE.test(app.bundleId)
const isChatApp = (app: Screen['app']): boolean => (app.bundleId ? CHAT_APP_BUNDLES.some((b) => b.toLowerCase() === app.bundleId!.toLowerCase()) : false) || CHAT_APP_NAMES.includes(app.name.trim().toLowerCase())
const isBrowser = (app: Screen['app']): boolean => !!app.bundleId && (BROWSER_BUNDLES.some((b) => b.toLowerCase() === app.bundleId!.toLowerCase()) || isWebApp(app))
const isMailApp = (app: Screen['app']): boolean => MAIL_APP.test(app.bundleId ?? '') || MAIL_APP.test(app.name)

const hostIn = (host: string | null, list: readonly string[]): boolean => !!host && list.some((h) => host === h || host.endsWith(`.${h}`))

/** A mail app or a mail page: a message is written over many lines there, and only the chords send it. */
function mailPlace(screen: Screen): boolean {
  if (isMailApp(screen.app)) return true
  return isBrowser(screen.app) && hostIn(pageHost(screen), MAIL_HOSTS) && !chatPath(screen)
}

/** Whether a message is sent from this window: a chat or mail app, or a browser on a chat or mail page. */
function chatPlace(screen: Screen): boolean {
  if (isChatApp(screen.app) || isMailApp(screen.app)) return true
  return isBrowser(screen.app) && hostIn(pageHost(screen), CHAT_HOSTS)
}

/** The browser's own field, never a page's: the address field itself, one beside it, or one outside the page of a window whose page was read apart. */
function browserOwnField(screen: Screen, field: ScreenElement): boolean {
  if (!isBrowser(screen.app) || isWebApp(screen.app)) return false
  const address = addressField(screen)
  if (address && (address.index === field.index || (address.parent !== null && address.parent === field.parent))) return true
  return !inPage(screen, field.index) && [...screen.elements.values()].some((e) => e.role === 'web area')
}

/** A control named for an outward act anywhere in the window: what a key may press when nobody knows where the focus is. */
function anyOutward(screen: Screen, live = false): { label: string; on: string } | null {
  for (const e of screen.elements.values()) {
    if (!['button', 'link', 'menu button'].includes(e.role)) continue
    const verb = sends(screen, e, OUTWARD_VERBS, live)
    if (verb) return { label: cap(verb), on: `the focus in ${screen.app.name}, which holds ${say(e)}` }
  }
  return null
}

/** How a Return reaches the screen: with Command or Control held; after the call itself typed (a disabled Send may be live by then); as a line break inside typed text. */
interface ReturnHow {
  chord?: boolean
  typed?: boolean
  text?: boolean
}

/** An open sheet or dialog takes Return for its own default, wherever the focus is said to be: the outward control it may press, or null. */
function sheetDefault(screen: Screen, within: number | null, live: boolean): { label: string; on: string } | null {
  for (const box of screen.elements.values()) {
    if (box.role !== 'sheet' && box.role !== 'dialog') continue
    if (within !== null && box.index !== within && !ancestors(screen, box.index).some((a) => a.index === within)) continue
    const controls = under(screen, box.index).filter((e) => ['button', 'link', 'menu button'].includes(e.role))
    const safe = controls.some((e) => SAFE_DEFAULTS.includes(norm(e.name ?? '')))
    for (const e of controls) {
      const verb = sends(screen, e, safe ? RETURN_VERBS : OUTWARD_VERBS, live)
      if (verb) return { label: cap(verb), on: `${say(box)}, which holds ${say(e)}` }
    }
  }
  return null
}

/**
 * What Return, a typed line break or `confirm` carries out with the focus
 * on `at` (null: nobody knows where the focus is).
 */
function returnSends(screen: Screen, at: number | null, how: ReturnHow = {}): { label: string; on: string } | null {
  const { chord = false, typed = false } = how
  const field = at !== null ? (screen.elements.get(at) ?? null) : null
  const mail = mailPlace(screen)
  if (!field) {
    // In a mail a plain Return is a new line wherever the focus is, and letters typed with a line break go into a field,
    // never onto a button; a bare Return there may still press whatever the focus is on.
    if (mail && !chord) return how.text ? null : anyOutward(screen, typed)
    return chatPlace(screen) ? { label: 'Send', on: `the focus in ${screen.app.name}` } : anyOutward(screen, typed)
  }
  const text = TEXT_ROLES.includes(field.role)
  if (!text) {
    // The focus on a control: Return and Space press it, and nothing beside it.
    const hit = outwardControl(screen, field.index)
    if (hit) return { label: cap(hit.verb), on: say(hit.element) }
    if (!CONTAINER_ROLES.includes(field.role)) return null
    // The focus on the window, a page or a sheet itself: an open sheet or dialog takes Return for its default.
    const open = sheetDefault(screen, ['window', 'web area'].includes(field.role) ? null : field.index, typed)
    if (open) return open
  }
  // The browser's own fields (the address bar, find in page) send nothing of a page's; a search field searches.
  if (text && (browserOwnField(screen, field) || field.role === 'search')) return null
  // A mail is written over many lines: only Command or Control with Return sends it.
  if (mail) return chord ? { label: 'Send', on: say(field) } : null
  // A chat app's or page's message box: Return sends.
  if (chatPlace(screen)) return { label: 'Send', on: say(field) }
  // With the page or the window itself in focus, Return presses nothing more.
  if (field.role === 'web area' || field.role === 'window') return null
  // Outside a chat, Return in a multi-line box is a new line, unless Command or Control is held or the box is a
  // composer: its own surroundings hold a Send.
  const multiLine = field.role === 'text area' && !chord
  // Any app: the field's surroundings hold a control named for an outward act.
  for (const box of ancestors(screen, field.index)) {
    const near = NEAR_ROLES.includes(box.role)
    const inside = under(screen, box.index)
    // The screen reader drops unnamed groups, so a composer's box and its Send often sit straight in the page or the
    // window: the box's own parent counts as its surroundings when it holds little.
    const ownParent = box.index === field.parent && inside.length <= 12
    if (!near && !ownParent && !WIDE_ROLES.includes(box.role)) continue
    const controls = inside.filter((e) => ['button', 'link', 'menu button'].includes(e.role))
    const small = (near && inside.length <= NEAR_MAX) || ownParent
    const isDialog = box.role === 'sheet' || box.role === 'dialog'
    if (multiLine && (!small || isDialog)) {
      if (!near && !ownParent) break
      continue
    }
    // A sheet or a dialog takes Return for its own default: with none that plainly sends nothing, any outward name in it may be that default.
    const dialog = small && isDialog && !controls.some((e) => SAFE_DEFAULTS.includes(norm(e.name ?? '')))
    const verbs = multiLine ? COMPOSER_VERBS : dialog ? OUTWARD_VERBS : small ? RETURN_VERBS : WIDE_VERBS
    for (const e of controls) {
      const verb = sends(screen, e, verbs, typed)
      if (verb) return { label: cap(verb), on: `${say(field)}, beside ${say(e)}` }
    }
    if (!near && !ownParent) break
  }
  return null
}

/** ⇧⌘D sends in mail apps; Command or Control with Return is judged where it lands (`returnSends`, as a chord). */
const mailChord = (screen: Screen, modifiers: readonly Modifier[], key: string): boolean =>
  key.toLowerCase() === 'd' && modifiers.includes('super') && modifiers.includes('shift') && modifiers.length === 2 && isMailApp(screen.app)

const CLICKS = ['left_click', 'double_click', 'triple_click', 'left_mouse_down', 'left_mouse_up']
/** Steps that put the focus on the element they name. */
const FOCUSES = ['left_click', 'double_click', 'triple_click', 'type', 'paste', 'set_value', 'select_text', 'key', 'hold_key']

/** Where the pointer was left by an earlier call of the thread: a press with no target lands there. */
export type PointerAt = { element: number } | { coordinate: readonly number[] } | { named: string } | null

/**
 * The first step of a call the host reads as outward, or null. `screen` is
 * the host's read of the window the call acts in: the thread's own book of
 * the window, or a fresh read with frames when a step lands by position or
 * goes to the focus. Null means nothing could be read, and then only a
 * target the step names in words (`named`, `menu`) can be judged. `pointer`
 * is where an earlier call left the pointer.
 */
export function readOutward(steps: readonly ComputerAction[], screen: Screen | null, pointer: PointerAt = null): OutwardRead | null {
  // a command line runs whatever is written or clicked in it: held before anything else is read
  const console = consoleRead(steps, screen)
  if (console) return console
  const at = (p: PointerAt): number | null => (!p || 'named' in p ? null : 'element' in p ? p.element : screen ? elementAt(screen, p.coordinate) : null)
  /** where the pointer is now, by element and by a name it was moved to: a button press with no target lands there */
  let pointerOn: number | null = at(pointer)
  let pointerName: string | null = pointer && 'named' in pointer ? pointer.named : null
  /** where the focus is as the call goes on; `undefined` once a step moved it somewhere nobody can tell */
  let focus: number | null | undefined = screen?.focused ?? null
  /**
   * Where a key, a typed text or a `confirm` goes: the element the step names; every element its name may find, as
   * the service resolves it when the step runs (a focusable Send included), or nobody knows where when it finds none;
   * else the focus, null when nobody knows it.
   */
  const keyTargets = (a: ComputerAction): (number | null)[] => {
    if (a.element !== undefined) return [a.element]
    if (a.named !== undefined) {
      const hits = screen ? namedElements(screen, a.named) : []
      return hits.length ? hits : [null]
    }
    return [focus === undefined ? null : focus]
  }
  /** an earlier step of this call put text somewhere: a Send the read shows disabled may be live by now */
  let typed = false
  for (const [step, a] of steps.entries()) {
    // A target by its name or by its menu path says what it is whatever the screen holds.
    if (a.menu !== undefined && (a.action === 'left_click' || a.action === 'perform')) {
      const parts = menuPathSegments(a.menu)
      // Edit, Format and their kind only change what is in front of the person: Edit > Delete removes a selection.
      const hit = LOCAL_MENUS.includes(norm(parts[0] ?? '')) ? undefined : parts.find((part) => outwardVerb(part))
      if (hit) return { step, why: 'menu', label: cap(outwardVerb(hit)!), on: `menu item ${JSON.stringify(hit)}` }
    }
    const acts = CLICKS.includes(a.action) || (a.action === 'perform' && a.name !== 'raise' && a.name !== 'show menu' && a.name !== 'scroll to visible')
    if (acts && a.named !== undefined && !(a.action === 'perform' && a.name === 'confirm')) {
      const verb = outwardVerb(a.named)
      if (verb && !cookieName(a.named, verb)) return { step, why: 'control', label: cap(verb), on: JSON.stringify(a.named) }
    }
    const targetless = a.element === undefined && a.coordinate === undefined && a.named === undefined && a.menu === undefined
    if (CLICKS.includes(a.action) && targetless && pointerName) {
      const verb = outwardVerb(pointerName)
      if (verb) return { step, why: 'position', label: cap(verb), on: JSON.stringify(pointerName) }
    }
    // Every step that takes the pointer somewhere: a later press with no target lands there.
    if (a.action === 'mouse_move' || ((a.action === 'scroll' || a.action === 'right_click' || a.action === 'middle_click') && !targetless)) {
      pointerOn = a.element ?? (a.coordinate ? at({ coordinate: a.coordinate }) : null)
      pointerName = a.named ?? null
    }
    // A press and a release on the same control is a click, however it is spelled.
    if (screen && a.action === 'left_click_drag') {
      const from = a.start_element ?? (a.start_coordinate ? elementAt(screen, a.start_coordinate) : null)
      const to = a.element ?? (a.coordinate ? elementAt(screen, a.coordinate) : null)
      const a1 = from !== null ? outwardControl(screen, from) : null
      const a2 = to !== null ? outwardControl(screen, to) : null
      if (a1 && a2 && a1.element.index === a2.element.index) return { step, why: 'control', label: cap(a2.verb), on: say(a2.element) }
      pointerOn = to
      pointerName = null
    }
    if (screen && acts) {
      const byPoint = a.element === undefined && a.coordinate !== undefined
      const lands = a.element ?? (a.coordinate ? elementAt(screen, a.coordinate) : targetless ? pointerOn : null)
      // A name resolves when the step runs, to any element that bears it: an icon inside a Send ("paperplane") is held as
      // the Send is. So is a press where the pointer was put by such a name.
      const byName = a.element === undefined && a.coordinate === undefined ? (a.named ?? (targetless && pointerOn === null ? pointerName : null)) : null
      const candidates = lands !== null && lands !== undefined ? [lands] : byName !== null ? namedElements(screen, byName) : []
      let hit: ReturnType<typeof outwardControl> = null
      for (const i of candidates) if ((hit = outwardControl(screen, i))) break
      if (hit) return { step, why: byPoint || targetless ? 'position' : 'control', label: cap(hit.verb), on: say(hit.element) }
      // `confirm` on a field commits it as Return does.
      if (a.action === 'perform' && a.name === 'confirm') {
        for (const to of keyTargets(a)) {
          const sent = returnSends(screen, to, { typed })
          if (sent) return { step, why: 'key', ...sent }
        }
      }
      if (CLICKS.includes(a.action)) {
        pointerOn = lands ?? null
        if (!targetless) pointerName = a.named ?? null
      }
    }
    if (screen && (a.action === 'key' || a.action === 'hold_key')) {
      let combo: { modifiers: Modifier[]; key: string } | null = null
      try {
        combo = parseKeyCombo(a.text ?? '')
      } catch {
        // a combo that does not parse sends nothing the host can name
      }
      if (combo) {
        if (mailChord(screen, combo.modifiers, combo.key)) return { step, why: 'chord', label: 'Send', on: `${a.text} in ${screen.app.name}` }
        // The key goes to the element the step names (by its name, to any element that bears it), else to the focus.
        const chord = combo.modifiers.includes('super') || combo.modifiers.includes('ctrl')
        for (const to of keyTargets(a)) {
          const onText = to !== null && TEXT_ROLES.includes(screen.elements.get(to)?.role ?? '')
          // Shift or Option with Return is a new line in a message box, never a send.
          const newLine = !chord && combo.modifiers.length > 0 && onText
          if (combo.key === 'Return' && !newLine) {
            const sent = returnSends(screen, to, { chord, typed })
            if (sent) return { step, why: chord ? 'chord' : 'key', label: sent.label, on: `${chord ? a.text : 'Return'} in ${sent.on}` }
          }
          if (combo.key === 'space' && combo.modifiers.length === 0 && !onText) {
            const sent = returnSends(screen, to, { typed })
            if (sent) return { step, why: 'key', label: sent.label, on: `Space in ${sent.on}` }
          }
        }
      }
    }
    if (screen && a.action === 'type') {
      for (const to of keyTargets(a)) {
        const onText = to !== null && TEXT_ROLES.includes(screen.elements.get(to)?.role ?? '')
        // A typed line break is Return; a typed space presses a control the focus is known to be on.
        if (/[\r\n]/.test(a.text ?? '') || (/ /.test(a.text ?? '') && to !== null && !onText && !CONTAINER_ROLES.includes(screen.elements.get(to)?.role ?? ''))) {
          const sent = returnSends(screen, to, { typed: true, text: true })
          if (sent) return { step, why: 'typed', label: sent.label, on: `${/[\r\n]/.test(a.text ?? '') ? 'a line break' : 'a space'} typed in ${sent.on}` }
        }
      }
    }
    if (a.action === 'type' || a.action === 'paste' || a.action === 'set_value') typed = true
    // Where the focus is after this step.
    if (FOCUSES.includes(a.action)) {
      if (a.element !== undefined) focus = a.element
      else if (a.named !== undefined) focus = (screen ? namedTarget(screen, a.named) : null) ?? undefined
      else if (a.menu !== undefined) focus = undefined
      else if (a.coordinate !== undefined && CLICKS.includes(a.action)) focus = (screen ? elementAt(screen, a.coordinate) : null) ?? undefined
    }
    if (a.action === 'key' || a.action === 'hold_key') {
      // Tab and any shortcut may move the focus anywhere.
      let moves = true
      try {
        const { modifiers, key } = parseKeyCombo(a.text ?? '')
        moves = key === 'Tab' || modifiers.some((m) => m !== 'shift') || /^(Up|Down|Left|Right|Home|End|Page_Up|Page_Down|Escape)$/i.test(key)
      } catch {
        // unknown: it may have moved
      }
      if (moves) focus = undefined
    }
  }
  return null
}

/** Steps that move nothing of the window's: an element they name need not be read again. */
const PASSIVE = ['mouse_move', 'scroll', 'zoom', 'screenshot', 'cursor_position', 'wait']

/**
 * Whether the host needs the window read afresh, with frames, to judge a
 * call: a step lands by position, acts on an element by its number or by a
 * name, clicks where the pointer was left, or sends a key, a typed line
 * break or a `confirm` to wherever the focus is now. The thread's book says
 * what each number named, where the focus was and what bore a name at its
 * last read; a person or the app may have changed all three (a Next become a
 * Send under the same number), and the service acts on the window as it is.
 */
export function needsFreshRead(steps: readonly ComputerAction[], pointer: PointerAt = null): boolean {
  if (landsByPosition(steps, pointer)) return true
  return steps.some((a, step) => {
    if (namedClick(a) || namedKeys(a)) return true
    // A click where the pointer was left lands on whatever lies under it now.
    if (targetlessClick(a)) return pointerAfter(steps.slice(0, step), pointer) !== null
    // An element by its number: the service keeps the number on the live element, whose name may have changed since
    // the book's read (a Next become a Send).
    if (a.element !== undefined || a.start_element !== undefined) return !PASSIVE.includes(a.action)
    if (a.action === 'perform') return a.name === 'confirm'
    if (a.action === 'type') return /[\r\n ]/.test(a.text ?? '')
    if (a.action !== 'key' && a.action !== 'hold_key') return false
    try {
      const { key, modifiers } = parseKeyCombo(a.text ?? '')
      return key === 'Return' || key === 'space' || (key.toLowerCase() === 'd' && modifiers.includes('super') && modifiers.includes('shift'))
    } catch {
      return false
    }
  })
}

/** Whether a call's steps land anywhere by position, so the host needs the window's frames to judge them. */
export function landsByPosition(steps: readonly ComputerAction[], pointer: PointerAt = null): boolean {
  let moved = pointer !== null && 'coordinate' in pointer
  for (const a of steps) {
    if (a.action === 'mouse_move' || a.action === 'left_click_drag') moved = a.element === undefined && a.coordinate !== undefined
    if (!CLICKS.includes(a.action)) continue
    if (a.coordinate !== undefined) return true
    if (a.element === undefined && a.named === undefined && a.menu === undefined && moved) return true
  }
  return false
}

/** Where a call leaves the pointer, for the thread's next call; `before` when no step moved it. */
export function pointerAfter(steps: readonly ComputerAction[], before: PointerAt = null): PointerAt {
  let at = before
  for (const a of steps) {
    if (!CLICKS.includes(a.action) && a.action !== 'mouse_move' && a.action !== 'left_click_drag' && a.action !== 'right_click' && a.action !== 'middle_click' && a.action !== 'scroll') continue
    if (a.element !== undefined) at = { element: a.element }
    else if (a.coordinate !== undefined) at = { coordinate: a.coordinate }
    else if (a.named !== undefined) at = { named: a.named }
    else if (a.menu !== undefined) at = null
  }
  return at
}

/**
 * Whether a step clicks with no target while nobody knows where the pointer is (no call of the thread put it
 * anywhere, or a menu pick since left it unknown): the service's own cursor may still sit on a Send no read shows,
 * so in a thread the hold applies to the click is refused before it is judged.
 */
export function clicksBlind(steps: readonly ComputerAction[], pointer: PointerAt = null): boolean {
  return steps.some((a, step) => targetlessClick(a) && pointerAfter(steps.slice(0, step), pointer) === null)
}

// ── what a held act must still find on the screen when the owner presses ──

/** One element a held step acts on, said without its index: an index is the service session's, and that may not outlive the hold. */
export interface HeldTarget {
  step: number
  /** which parameter named it; `focus`: the element a key step goes to; `point`: what lies under a step's coordinate, what a click's `named` finds, or what lies under the pointer for a click with no target */
  param: 'element' | 'start_element' | 'focus' | 'point'
  /** role, name and the roles and names above it, as JSON `[[role, name], …]` from the element up */
  sig: string
  /** which of the elements with this signature, in reading order, and how many there were */
  ordinal: number
  count: number
}

/** An element and every element above it as `[role, name]` tuples in JSON: a name holding " < " or a colon stays inside its own tuple. */
const sigOf = (screen: Screen, index: number): string | null => {
  const e = screen.elements.get(index)
  if (!e) return null
  return JSON.stringify([e, ...ancestors(screen, index)].map((x) => [x.role, x.name ?? '']))
}

function placeOf(screen: Screen, index: number): { sig: string; ordinal: number; count: number } | null {
  const sig = sigOf(screen, index)
  if (sig === null) return null
  const same = [...screen.elements.keys()].sort((a, b) => a - b).filter((i) => sigOf(screen, i) === sig)
  return { sig, ordinal: same.indexOf(index), count: same.length }
}

/** Steps that put keys or text into an element: by its name, each is bound to the element the name found. */
const NAMED_INPUT = ['key', 'hold_key', 'type', 'paste', 'set_value', 'select_text']

/** A key, typed or pasted text, a value set or a selection made in an element found by its name. */
const namedKeys = (a: ComputerAction): boolean => NAMED_INPUT.includes(a.action) && a.named !== undefined && a.element === undefined

/**
 * Whether a key, a text or a value names an element its name finds none of, or several, on the screen: the service
 * would resolve it on its own and the host cannot judge where it goes. In a thread the hold applies to it is refused.
 */
export function namedKeysUnplaced(steps: readonly ComputerAction[], screen: Screen): boolean {
  return steps.some((a) => namedKeys(a) && namedTarget(screen, a.named!) === null)
}

const targetlessClick = (a: ComputerAction): boolean => CLICKS.includes(a.action) && a.element === undefined && a.coordinate === undefined && a.named === undefined && a.menu === undefined
/** A click or a press by name: the name is found again when the step runs. */
const namedClick = (a: ComputerAction): boolean => (CLICKS.includes(a.action) || a.action === 'perform') && a.named !== undefined && a.element === undefined && a.coordinate === undefined

/**
 * The elements a call's steps act on, as the screen names them now. Null when a step names one the screen lacks,
 * clicks a point on none, clicks by a name that finds no one element, or clicks with no target where nobody knows the
 * pointer is. `pointer` is where an earlier call left the pointer: a click with no target lands there.
 */
export function heldTargets(steps: readonly ComputerAction[], screen: Screen, pointer: PointerAt = null): HeldTarget[] | null {
  const out: HeldTarget[] = []
  for (const [step, a] of steps.entries()) {
    for (const param of ['element', 'start_element'] as const) {
      const index = a[param]
      if (index === undefined) continue
      const place = placeOf(screen, index)
      if (!place) return null
      out.push({ step, param, ...place })
    }
    if (a.coordinate !== undefined && CLICKS.includes(a.action)) {
      const index = elementAt(screen, a.coordinate)
      const place = index !== null ? placeOf(screen, index) : null
      if (!place) return null
      out.push({ step, param: 'point', ...place })
    }
    // A click or a key by name, or a click with no target where the pointer is, finds its element when it runs: it must
    // find the one he was shown (a "paperplane" still inside "Send to Dana"). With no pointer known the click could land anywhere.
    if (namedClick(a) || namedKeys(a) || targetlessClick(a)) {
      const index = namedClick(a) || namedKeys(a) ? namedTarget(screen, a.named!) : pointedAt(screen, pointerAfter(steps.slice(0, step), pointer))
      const place = index !== null ? placeOf(screen, index) : null
      if (!place) return null
      out.push({ step, param: 'point', ...place })
    }
  }
  // A key, a typed text or a paste with no target of its own goes to the focus: it must still be where it was.
  const blind = steps.findIndex((a) => ['key', 'hold_key', 'type', 'paste'].includes(a.action) && a.element === undefined && a.named === undefined)
  if (blind >= 0 && screen.focused !== null) {
    const place = placeOf(screen, screen.focused)
    if (place) out.push({ step: blind, param: 'focus', ...place })
  }
  return out
}

/** Controls whose surroundings say where a send goes. A reply or a comment sits beside every message of a list, whose words change as messages come. */
const CONTEXT_VERBS: readonly string[] = RETURN_VERBS.filter((v) => !['reply', 'reply all', 'forward', 'comment'].includes(v))

/**
 * Who a send goes to, as the window says it beside its fields: every heading (a chat's header "Dana Lee"), and the
 * lines of text around each control that sends: all of them in a small group or sheet it sits in, and the ones that
 * stand straight in each larger container up to the window or page (a mail's To line drawn as text). A list's
 * messages sit deeper and are left out, so a message coming in does not void a press.
 */
function sendContext(screen: Screen): [string, string][] {
  const kept = new Map<number, [string, string]>()
  const keep = (e: ScreenElement): void => {
    const words = e.role === 'heading' || e.role === 'text' ? (e.name ?? e.value) : undefined
    if (words?.trim()) kept.set(e.index, [e.role, words])
  }
  for (const e of screen.elements.values()) if (e.role === 'heading') keep(e)
  const seen = new Set<number>()
  for (const c of screen.elements.values()) {
    if (!['button', 'link', 'menu button'].includes(c.role) || !sends(screen, c, CONTEXT_VERBS, true)) continue
    for (const box of ancestors(screen, c.index)) {
      if (!seen.has(box.index)) {
        seen.add(box.index)
        const inside = under(screen, box.index)
        if (NEAR_ROLES.includes(box.role) && inside.length <= NEAR_MAX) inside.forEach(keep)
        else for (const e of inside) if (e.parent === box.index) keep(e)
      }
      if (WIDE_ROLES.includes(box.role)) break
    }
  }
  return [...kept].sort((a, b) => a[0] - b[0]).map(([, words]) => words)
}

/** Numeric fields: a quantity's stepper, an amount's slider. Their value goes as a text field's does. */
const NUMBER_ROLES = ['stepper', 'slider']

/** The fields whose value would go, in reading order: every text field but a password (a recipient search box too), and every numeric field. */
const markFields = (screen: Screen): ScreenElement[] =>
  [...screen.elements.values()]
    .filter((e) => (TEXT_ROLES.includes(e.role) && e.role !== 'password') || NUMBER_ROLES.includes(e.role))
    .sort((a, b) => a.index - b.index)

/** A value the read printed cut (observation.ts `cutValue`): its first scalars, then `…(+n chars)`. */
export const isCutValue = (value: string | undefined): boolean => !!value && /…\(\+\d+ chars\)$/.test(value)

/** The fields and pop-ups the read printed cut: the hold reads each again whole (`state.get` with `element`, §4.4) before it binds the window. */
export const cutFields = (screen: Screen): number[] =>
  [...markFields(screen), ...[...screen.elements.values()].filter((e) => e.role === 'pop up')].filter((e) => isCutValue(e.value)).map((e) => e.index)

/** The screen with these fields' values as read whole. */
export function withValues(screen: Screen, values: ReadonlyMap<number, string>): Screen {
  const elements = new Map(screen.elements)
  for (const [index, value] of values) {
    const e = elements.get(index)
    if (e) elements.set(index, { ...e, value })
  }
  return { ...screen, elements }
}

/**
 * A value as the mark binds it: a long one by its digest, so a change anywhere in it, past what a line shows too, is
 * a change. The two forms are tagged apart (`=` the text itself, `#` a digest), so a field holding the literal text
 * "#<digest of another value>" never binds as that value does.
 */
const boundValue = (value: string): string => (value.length > 160 ? `#${sha256Hex(value)}` : `=${value}`)

/** Controls whose state goes with a submit: what is ticked, switched on or chosen ("Include insurance", the plan picked). */
const STATE_ROLES = ['checkbox', 'radio', 'switch', 'tab']
const STATES_BOUND = ['checked', 'unchecked', 'mixed', 'selected']

/**
 * What each listbox has chosen: a `list` (a listbox's options, a picker of recipients or plans), never a `table` or
 * an `outline`, where a mail list or a sidebar keeps its rows. Every list is bound by the rows selected in it, so
 * choosing another option, or none, is a change; rows that come and go unselected (a list that grows) are not.
 */
function listMark(screen: Screen): [string, string, string][] {
  const chosen = new Map<number, string[]>()
  const sorted = [...screen.elements.values()].sort((a, b) => a.index - b.index)
  for (const e of sorted) if (e.role === 'list') chosen.set(e.index, [])
  for (const e of sorted) {
    if ((e.role !== 'row' && e.role !== 'cell') || !e.states.includes('selected')) continue
    const box = ancestors(screen, e.index).find((a) => ['list', 'table', 'outline'].includes(a.role))
    if (box?.role === 'list') chosen.get(box.index)?.push(e.name ?? e.value ?? '')
  }
  return [...chosen].map(([index, rows]) => ['list', screen.elements.get(index)?.name ?? '', JSON.stringify(rows)])
}

/** Each tickable control's state, each pop-up's chosen option and each listbox's chosen rows, in reading order, as `[role, name, state or tagged choice]`. */
function controlMark(screen: Screen): [string, string, string][] {
  const controls = [...screen.elements.values()]
    .filter((e) => STATE_ROLES.includes(e.role) || e.role === 'pop up')
    .sort((a, b) => a.index - b.index)
    .map((e): [string, string, string] => [e.role, e.name ?? '', e.role === 'pop up' ? boundValue(e.value ?? '') : e.states.filter((x) => STATES_BOUND.includes(x)).join(' ')])
  return [...controls, ...listMark(screen)]
}

/**
 * What the window holds that would go: the app, every field's name and value (a long value by its digest), who it
 * goes to (`sendContext`), and what is ticked or chosen (`controlMark`). Each entry is a tuple, never words joined
 * by a separator, so no name or value can spill into the next part ("Message" holding "hello|=PAY" never binds as
 * "Message|=hello" holding "PAY"). A part with nothing in it is left out.
 */
export function screenMark(screen: Screen): string {
  const fields = markFields(screen).map((e): [string, string, string] => [e.role, e.name ?? '', boundValue(e.value ?? '')])
  const context = sendContext(screen)
  const controls = controlMark(screen)
  const app = screen.app.bundleId ?? screen.app.name
  return JSON.stringify(controls.length ? [app, fields, context, controls] : context.length ? [app, fields, context] : [app, fields])
}

/**
 * The held steps as they must run on the screen as it is now: each target
 * found again by what it is, its index rewritten when the service numbered
 * the window anew. Null when the screen moved on: a field's text changed, a
 * target is gone or is no longer the only one of its kind where it was,
 * the focus or what lies under a click is something else. `pointer` is where
 * the thread's calls have left the pointer since: a click with no target must
 * still find it on what he was shown.
 */
export function restage(steps: readonly ComputerAction[], targets: readonly HeldTarget[], mark: string, screen: Screen, pointer: PointerAt = null): ComputerAction[] | null {
  if (screenMark(screen) !== mark) return null
  const order = [...screen.elements.keys()].sort((a, b) => a - b)
  const out = steps.map((a) => ({ ...a }))
  /** clicks with no target, checked once every index above them is rewritten */
  const pointed: [number, number][] = []
  for (const t of targets) {
    const same = order.filter((i) => sigOf(screen, i) === t.sig)
    if (same.length !== t.count) return null
    const index = same[t.ordinal]
    if (index === undefined) return null
    const step = out[t.step]
    if (!step) return null
    if (t.param === 'focus') {
      if (screen.focused !== index) return null
    } else if (t.param === 'point') {
      if (targetlessClick(step)) pointed.push([t.step, index])
      else if (namedClick(step) || namedKeys(step)) {
        if (namedTarget(screen, step.named!) !== index) return null
      } else if (!step.coordinate || elementAt(screen, step.coordinate) !== index) return null
    } else step[t.param] = index
  }
  for (const [step, index] of pointed) if (pointedAt(screen, pointerAfter(out.slice(0, step), pointer)) !== index) return null
  return out
}
