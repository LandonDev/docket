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

export type SignInReached = 'number' | 'choose' | 'page' | 'first'

/** What the row says for where the walk stopped. */
export const SIGN_IN_LINES: Record<SignInReached, string> = {
  number: "A number is on the Windows VM's screen: enter it in Microsoft Authenticator on your phone.",
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
  return (await press(APPROVE)) ? 'number' : 'choose'
}
