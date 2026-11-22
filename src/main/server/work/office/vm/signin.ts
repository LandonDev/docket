import type { VmCall } from './link'

/**
 * His sign-in to OneDrive in the Windows VM, walked to the one step that is his (docs/agents/work-files.md
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
  const seen = async (...names: string[]): Promise<string | null> => ((await d.call('ui.seen', { names }, { timeoutMs: 20_000 }).catch(() => null)) as string | null) ?? null
  const press = async (...names: string[]): Promise<string | null> => ((await d.call('ui.press', { names }, { timeoutMs: 20_000 }).catch(() => null)) as string | null) ?? null

  // A sign-in left open from before is taken up where it stands.
  let at = await seen(APPROVE, ANOTHER_WAY)
  if (!at) {
    await d.call('onedrive.signin', { email: email ?? '' }, { timeoutMs: 30_000 })
    let pressed = false
    for (let i = 0; i < waits.first && !pressed; i++) {
      pressed = (await press(SIGN_IN)) !== null
      if (!pressed) await sleep(1000)
    }
    if (!pressed) return 'first'
    // Purdue's page, and over it Windows' prompt for a security key: Escape sends it away.
    for (let i = 0; i < waits.page && !at; i++) {
      await sleep(1000)
      at = await seen(APPROVE, ANOTHER_WAY)
      if (!at && i >= 5 && i % 4 === 1) await d.key('esc').catch(() => undefined)
    }
    if (!at) return 'page'
  }
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

export interface FollowDeps extends Pick<SignInDeps, 'call' | 'sleep'> {
  /** who OneDrive in the guest is signed in as now; null while it is not */
  account(): Promise<string | null>
  /** how long it watches, and how often it looks; a test shortens them */
  forMs?: number
  everyMs?: number
  now?: () => number
}

/**
 * What the host does while he answers on his phone, so that his one approval is enough (found live
 * 2026-11-22: the sign-in's code lapses within two minutes of the approval if the next screen waits):
 *  - Microsoft's "Sign in to all apps and websites on this device?" is answered "No, this app only" the moment
 *    it shows. Yes would register the VM as a device with his organisation, which is his alone to choose;
 *  - "Request wasn't sent" (an older request still waits on his phone) has its Next pressed every ten seconds
 *    until Microsoft sends the new one. A request that timed out unanswered is not sent again: his next
 *    press does that;
 *  - OneDrive's own setup pages after the sign-in have their Next pressed (its folder where OneDrive puts it).
 * It ends once OneDrive is signed in, or after six minutes. It types nothing.
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
  while (now() < end) {
    await press([THIS_APP_ONLY])
    if (now() >= lookAt) {
      lookAt = now() + 5 * every
      if (await d.account().catch(() => null)) return 'signed-in'
      // OneDrive's own window only: Purdue's pages have a Next too.
      await press(['Next'], 'OneDrive')
      if (now() >= nextAt && (await seen(NOT_SENT))) {
        nextAt = now() + 10 * every
        await press(['Next'], 'Microsoft.AAD.BrokerPlugin')
      }
    }
    await sleep(every)
  }
  return 'gave-up'
}

/**
 * Office's own sign-in, once OneDrive is done: Word is started as he would start it and its title bar's
 * Sign in pressed, which opens Microsoft's sign-in window. What that window asks is his.
 */
export async function walkOfficeSignIn(d: Pick<SignInDeps, 'call' | 'sleep' | 'waits'>): Promise<'window' | 'word'> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  await d.call('office.start', {}, { timeoutMs: 30_000 })
  for (let i = 0; i < (d.waits?.first ?? 12) + 8; i++) {
    await sleep(1000)
    if (await d.call('ui.press', { names: [SIGN_IN] }, { timeoutMs: 20_000 }).catch(() => null)) return 'window'
  }
  return 'word'
}

export const OFFICE_SIGN_IN_LINES = {
  window: "Office's sign-in is open on the Windows VM: finish it there.",
  word: 'Word is open on the Windows VM: press Sign in at the top of its window.'
} as const
