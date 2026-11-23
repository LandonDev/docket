import type { VmCall } from './link'

/**
 * His sign-in to OneDrive in the Windows VM, walked to the one step that is his (docs/agents/work-teams-files.md
 * "Signing in"). Purdue's page asks first for a passkey, which the VM has none of; behind "Sign in another
 * way" is "Approve a request on my Microsoft Authenticator app", which shows a number for his phone. The
 * walk presses those by the words on them, through the helper, and nothing else: it types no address (OneDrive
 * takes it from its own link), no password and no code, and it runs only at his own press.
 *
 * The security-key prompt is Windows' own and takes no click from a program of tcuser's: it is dismissed
 * with Escape from the machine's keyboard (`key`).
 */

export const APPROVE = 'Approve a request on my Microsoft Authenticator app'
export const ANOTHER_WAY = 'Sign in another way'
const SIGN_IN = 'Sign in'

export interface SignInDeps {
  call: VmCall
  /** keys from the machine's own keyboard (QEMU's), which reach Windows' security prompts too */
  key(...qcodes: string[]): Promise<void>
  sleep?: (ms: number) => Promise<void>
  /** how long each wait may take, in steps of a second; a test shortens it */
  waits?: { first: number; page: number; list: number }
}

export type SignInReached = 'number' | 'pending' | 'choose' | 'page' | 'first'

/** Microsoft sends no new request while an older one waits unanswered in his Authenticator: the page says so, with either apostrophe. */
export const NOT_SENT = ["Request wasn't sent", 'Request wasn\u2019t sent']
/** After his approval Microsoft asks whether to register this PC with his organisation and sign every app in: the answer here is its "No, this app only" button. */
export const THIS_APP_ONLY = 'No, this app only'

/** What the row says for where the walk stopped. */
export const SIGN_IN_LINES: Record<SignInReached, string> = {
  number: "A number is on the Windows VM's screen: enter it in Microsoft Authenticator on your phone.",
  pending: 'An older sign-in request is still waiting in Microsoft Authenticator: deny it on your phone. A new one is sent as soon as Microsoft allows, and its number shows on the Windows VM.',
  choose: `Choose "${APPROVE}" on the Windows VM's screen, then enter its number on your phone.`,
  page: "Purdue's sign-in is open on the Windows VM: finish it there.",
  first: "OneDrive's sign-in is open on the Windows VM: press Sign in there."
}

export async function walkSignIn(email: string | null, d: SignInDeps): Promise<SignInReached> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const waits = d.waits ?? { first: 12, page: 24, list: 10 }
  const { press } = ui(d)

  // A sign-in left open from before is taken up where it stands.
  if (await ui(d).seen(APPROVE, ANOTHER_WAY)) return toNumber(d)
  await d.call('onedrive.signin', { email: email ?? '' }, { timeoutMs: 30_000 })
  let pressed = false
  for (let i = 0; i < waits.first && !pressed; i++) {
    pressed = (await press(SIGN_IN)) !== null
    if (!pressed) await sleep(1000)
  }
  if (!pressed) return 'first'
  return toNumber(d)
}

/** The helper's two looks at the screen, by the words on it; `only` keeps them to one app's own window. */
function ui(d: Pick<SignInDeps, 'call'>) {
  const ask = (verb: string) => async (...names: string[]): Promise<string | null> => ((await d.call(verb, { names }, { timeoutMs: 20_000 }).catch(() => null)) as string | null) ?? null
  const askIn = (verb: string) => async (only: string, ...names: string[]): Promise<string | null> => ((await d.call(verb, { names, in: only }, { timeoutMs: 20_000 }).catch(() => null)) as string | null) ?? null
  return { seen: ask('ui.seen'), press: ask('ui.press'), seenIn: askIn('ui.seen'), pressIn: askIn('ui.press') }
}

/**
 * From a sign-in window just opened (OneDrive's, or one Office opened) to the number for his phone: Purdue's
 * page, and over it Windows' prompt for a security key, which Escape sends away; "Sign in another way"; then
 * "Approve a request on my Microsoft Authenticator app".
 */
async function toNumber(d: SignInDeps): Promise<SignInReached> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const waits = d.waits ?? { first: 12, page: 24, list: 10 }
  const { seen, press } = ui(d)
  let at = await seen(APPROVE, ANOTHER_WAY)
  for (let i = 0; i < waits.page && !at; i++) {
    await sleep(1000)
    at = await seen(APPROVE, ANOTHER_WAY)
    if (!at && i >= 5 && i % 4 === 1) await d.key('esc').catch(() => undefined)
  }
  if (!at) return 'page'
  if (at === ANOTHER_WAY) {
    await press(ANOTHER_WAY)
    at = null
    for (let i = 0; i < waits.list && !at; i++) {
      await sleep(1000)
      at = await seen(APPROVE)
    }
    if (!at) return 'page'
  }
  if (!(await press(APPROVE))) return 'choose'
  // The number shows within a few seconds, unless an older request still waits on his phone.
  for (let i = 0; i < 4; i++) {
    await sleep(1000)
    if (await seen(...NOT_SENT)) return 'pending'
  }
  return 'number'
}

/** The number on Microsoft's "Approve sign in" page, as its own element names it (two or three digits); null when none shows. */
export async function readNumber(d: Pick<SignInDeps, 'call'>): Promise<string | null> {
  const n = (await d.call('ui.number', {}, { timeoutMs: 20_000 }).catch(() => null)) as string | null
  return typeof n === 'string' && /^\d{2,3}$/.test(n) ? n : null
}

/** The row's line once the number is read: the number itself, so he needs no Take over to see it. */
export const numberLine = (n: string): string => `Enter ${n} in Microsoft Authenticator on your phone.`

export interface FollowDeps extends Pick<SignInDeps, 'call' | 'sleep'> {
  /** whether the sign-in it watches is done: OneDrive's account there, or Office licensed */
  account(): Promise<string | null>
  /**
   * OneDrive's: once its account shows, its tutorial is pressed to its end, then this runs (the wanted libraries
   * asked of OneDrive, which ignores a sync link while its tutorial is open). Office's has none.
   */
  afterSignIn?: () => Promise<void>
  /** how long it watches, and how often it looks; a test shortens them */
  forMs?: number
  everyMs?: number
  now?: () => number
}

/**
 * One watch at a time: a watch asked for while one runs starts when it ends (the newest only). Office's sign-in is
 * offered while OneDrive's watch still presses its tutorial, and Office's needs its own watch for the device question.
 */
export function oneWatchAtATime(): (start: () => Promise<unknown>) => void {
  let running = false
  let next: (() => Promise<unknown>) | null = null
  const run = (start: () => Promise<unknown>): void => {
    if (running) {
      next = start
      return
    }
    running = true
    void start()
      .catch(() => undefined)
      .finally(() => {
        running = false
        const n = next
        next = null
        if (n) run(n)
      })
  }
  return run
}

/** OneDrive's tutorial after its sign-in: "Not now" on "Get the mobile app", and its last page's "Open my OneDrive folder". */
export const NOT_NOW = 'Not now'
export const OPEN_FOLDER = 'Open my OneDrive folder'

/**
 * What the host does while he answers on his phone, so that his one approval is enough (found live
 * 2026-11-22: the sign-in's code lapses within two minutes of the approval if the next screen waits):
 *  - Microsoft's "Sign in to all apps and websites on this device?" is answered "No, this app only" the moment
 *    it shows. Yes would register the VM as a device with his organisation, which is his alone to choose;
 *  - "Request wasn't sent" (an older request still waits on his phone) has its Next pressed every ten seconds
 *    until Microsoft sends the new one. A request that timed out unanswered is not sent again: his next
 *    press does that;
 *  - OneDrive's own setup pages after the sign-in have their Next pressed (its folder where OneDrive puts it),
 *    and its tutorial "Not now" and, at its end, "Open my OneDrive folder"; then `afterSignIn`.
 * It ends once the sign-in it watches is done (OneDrive's tutorial through, or a minute past the account), or
 * after six minutes. It types nothing.
 */
export async function followSignIn(d: FollowDeps): Promise<'signed-in' | 'gave-up'> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = d.now ?? Date.now
  const every = d.everyMs ?? 1000
  const end = now() + (d.forMs ?? 6 * 60_000)
  const press = async (names: string[], within?: string): Promise<boolean> => !!(await d.call('ui.press', { names, ...(within ? { in: within } : {}) }, { wake: false, timeoutMs: 15_000 }).catch(() => null))
  const seen = async (names: string[]): Promise<boolean> => !!(await d.call('ui.seen', { names }, { wake: false, timeoutMs: 15_000 }).catch(() => null))
  let nextAt = 0
  let lookAt = 0
  let signedAt: number | null = null
  while (now() < end) {
    await press([THIS_APP_ONLY])
    if (signedAt !== null) {
      // the tutorial, to its last page or a minute; then what waited on it
      const last = await press([OPEN_FOLDER], 'OneDrive')
      if (!last) await press([NOT_NOW, 'Next'], 'OneDrive')
      if (last || now() - signedAt >= 60 * every) {
        await d.afterSignIn?.().catch(() => undefined)
        return 'signed-in'
      }
    } else if (now() >= lookAt) {
      lookAt = now() + 5 * every
      if (await d.account().catch(() => null)) {
        if (!d.afterSignIn) return 'signed-in'
        signedAt = now()
        continue
      }
      // OneDrive's own window only: Purdue's pages have a Next too.
      await press(['Next'], 'OneDrive')
      if (now() >= nextAt && (await seen(NOT_SENT))) {
        nextAt = now() + 10 * every
        await press(['Next'], 'Microsoft.AAD.BrokerPlugin')
      }
    }
    await sleep(every)
  }
  // the account came in the last minute: what waited on the tutorial still runs
  if (signedAt !== null) {
    await d.afterSignIn?.().catch(() => undefined)
    return 'signed-in'
  }
  return 'gave-up'
}

/** Word's words on the way to its sign-in: its first-run privacy page, and an account it holds but cannot use. */
export const PRIVACY = 'Your privacy option'
export const FIX_ME = 'Fix me'
export const FILE_TAB = 'File Tab'
export const ACCOUNT = 'Account'

export type OfficeReached = SignInReached | 'word'

/**
 * Office's own sign-in, once OneDrive is done: Word is started as he would start it, its privacy page closed,
 * and its sign-in opened by whichever shows: the title bar's Sign in, or for an account it holds with an error,
 * File, Account, "Fix me". Microsoft's window then goes the way OneDrive's does, to the number for his phone.
 */
export async function walkOfficeSignIn(d: SignInDeps): Promise<OfficeReached> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const { seenIn, pressIn } = ui(d)
  await d.call('office.start', {}, { timeoutMs: 30_000 })
  for (let i = 0; i < (d.waits?.first ?? 12) + 8; i++) {
    await sleep(1000)
    if (await seenIn('WINWORD', PRIVACY)) await pressIn('WINWORD', 'Close')
    if (await pressIn('WINWORD', SIGN_IN, FIX_ME)) return toNumber(d)
    // no Sign in after a few seconds: an account with an error says so on File, Account
    if (i >= 3 && i % 3 === 0 && (await pressIn('WINWORD', FILE_TAB))) {
      await sleep(1000)
      await pressIn('WINWORD', ACCOUNT)
    }
  }
  return 'word'
}

export const OFFICE_WORD_LINE = 'Word is open on the Windows VM: press Sign in at the top of its window, or File, Account, Fix me.'
