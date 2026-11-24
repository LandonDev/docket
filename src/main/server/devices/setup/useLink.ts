import { randomBytes } from 'node:crypto'
import type { DevicesPush, SetupItems, SetupPeek, SetupState, SetupStep, SetupStepRow } from '@shared/contract-devices'
import { deriveLinkKeys, openWithKey, signBytes } from '@shared/devices/keys'
import { bundleDigest, claimBytes, parseSetupLink, setupWords, SetupBundleSchema, type ClaimFields, type SetupBundle, type SetupClaimAnswer } from '@shared/devices/setupLink'
import type { DeviceIdentities } from '../identity'
import type { GivenComputer } from '../given'
import type { InstallOutcome, StepReport } from './lifeosInstall'
import type { WorkSignInAnswer } from './workSignIn'
import { noteGave, SETUP_GAVE } from './gave'

/**
 * The computer being set up (docs/agents/pc-setup.md "The setup link"). A
 * pasted link is peeked (the box answers the sealed bundle; the secret opens
 * it here) and nothing moves before Set up this PC. Then, each step reported
 * as a local `device-setup` push:
 *
 * - **link**: this install's identity, a challenge, the claim signed by the
 *   link verifier and the device key (a lost reply is sent again as is, and
 *   the box answers the same key id), the giver and the box pinned with the
 *   pending key in the vault (given.ts `pinGiver`).
 * - **allow**: the three words, and `/api/setup/status` asked until the giver
 *   allows; then the box environment is saved, its key sealed. A link that
 *   ends first takes the pins with it (`abandon`).
 * - **accounts**: the first manifest applied (given.ts `onApplied`).
 * - **lifeos** (Windows only): `installLifeos` with the `desktop` code from
 *   the activate letter. **work**: `signInWork` with the `tempcode` code.
 * - **folders**: waits for the window's pick, then `addSetupFolders`.
 *
 * No platform rides the link or the flow: a second Mac gets the same steps,
 * less LifeOS's install. The link, the code, the secret and LifeOS's codes
 * reach no log, error text or settings row: the box key lives in the pins,
 * the LifeOS codes in the vault (`codes`) until their steps are done.
 */

export const SETUP_STATE = 'devices.setup'
export const CODES_NAME = '~setup-codes'
const POLL_MS = 3_000
const CLAIM_TRIES = 3

interface Saved {
  origin: string
  giver: string
  pairingId: string
  boxEnvId: string
  expiresAt: number
  words: string[]
  items: SetupItems
  seeds: SetupState['seeds']
  steps: SetupStepRow[]
}

interface LifeosCodes {
  owner?: string
  codes?: { desktop?: string; tempcode?: string }
  reader?: boolean
  missing?: string
  /** The Work redemption's attempt, saved before its first try: a retry after a lost reply is answered again (F20). */
  attempt?: string
}

export class SetupRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SetupRefused'
  }
}

export interface UseLinkDeps {
  environmentId: string
  /** The harness marker (TEMP_CODE_USER_DATA): an http:// box for the rig proof. */
  allowHttp: boolean
  platform: NodeJS.Platform
  fetch: typeof fetch
  identity: Pick<DeviceIdentities, 'keys' | 'publicIdentity'>
  given: Pick<GivenComputer, 'pins' | 'pinGiver' | 'abandon'>
  /** The environments saved here, by id. */
  savedHosts: () => { id: string }[]
  /** Save the box environment with the key the pins hold, sealed, and open its link. */
  /** Save the box sealed, only under `envId` (the id the bundle pinned; environments.ts `expectId`). */
  saveBox: (origin: string, key: string, envId: string) => Promise<void>
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  codes: { read(): string | null; write(raw: string): void; clear(): void }
  installLifeos: (input: { code: string; owner: string; reader: boolean }, onStep: (r: StepReport) => void) => Promise<InstallOutcome>
  signInWork: (input: { code: string; owner: string; attempt?: string }) => Promise<WorkSignInAnswer>
  setWork: (enabled: boolean) => void
  addFolders: (paths: string[]) => string[] | Promise<string[]>
  push: (p: DevicesPush) => void
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown>
  ) {
    super(message)
  }
}

const when = (at: unknown): string => (typeof at === 'number' ? new Date(at).toLocaleString() : 'earlier')

/** A box refusal in words for his screen; never the link's parts. */
function refusalWords(err: unknown): string {
  if (err instanceof HttpRefusal) {
    if (err.status === 410 && err.body.used) return `This link was used on ${when(err.body.used)}. Make a new one on your Mac.`
    if (err.status === 410) return 'This link has ended. Make a new one on your Mac.'
    if (err.status === 404) return 'The box does not know this link. Copy the whole link again.'
    if (err.status === 429) return 'Too many tries. Wait a few minutes and paste it again.'
    if (err.status === 409) return typeof err.body.error === 'string' ? `The box refused: ${err.body.error}.` : 'The box refused the link.'
    return `The box answered ${err.status}.`
  }
  if (err instanceof SetupRefused) return err.message
  return 'The box could not be reached. Check the connection and try again.'
}

export class SetupThisPc {
  private allowing = false
  private closed = false
  private readonly running = new Map<SetupStep, Promise<void>>()

  constructor(private readonly deps: UseLinkDeps) {}

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((ok) => setTimeout(ok, ms))
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[setup] ${l}`)))(line)
  }

  private saved(): Saved | null {
    try {
      const raw = this.deps.store.getSetting(SETUP_STATE)
      return raw ? (JSON.parse(raw) as Saved) : null
    } catch {
      return null
    }
  }

  private save(s: Saved | null): void {
    this.deps.store.setSetting(SETUP_STATE, s ? JSON.stringify(s) : null)
  }

  private async post<T>(origin: string, path: string, body: unknown, bearer?: string): Promise<T> {
    const res = await this.deps.fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
      // A setup request never follows a redirect: the code and the claim go to the pasted origin alone (F22).
      redirect: 'error'
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new HttpRefusal(res.status, typeof json.error === 'string' ? json.error : `status ${res.status}`, json)
    return json as T
  }

  // ── peek ───────────────────────────────────────────────────────────────

  private async open(link: string): Promise<{ origin: string; code: string; secret: Buffer; bundle: SetupBundle; sealed: string; pairingId: string; expiresAt: number }> {
    const parsed = parseSetupLink(link, { allowHttp: this.deps.allowHttp })
    let peeked: { bundle: string; expiresAt: number; pairingId: string; claimedBy?: string; used?: number }
    try {
      peeked = await this.post(parsed.origin, '/api/setup/peek', { code: parsed.code })
    } catch (err) {
      throw new SetupRefused(refusalWords(err))
    }
    // A claim this computer made and lost the reply to goes on from the same link (F21); another computer's is used.
    if (peeked.claimedBy && peeked.claimedBy !== this.deps.identity.publicIdentity().signPublic) throw new SetupRefused(refusalWords(new HttpRefusal(410, 'used', { used: peeked.used })))
    const plain = openWithKey(deriveLinkKeys(parsed.secret).bundleKey, String(peeked.bundle))
    const bundle = plain ? SetupBundleSchema.safeParse(safeJson(plain.toString('utf8'))) : null
    if (!bundle?.success) throw new SetupRefused('This link does not open. Copy the whole link from your Mac again.')
    if (bundle.data.box.origin.replace(/\/+$/, '') !== parsed.origin.replace(/\/+$/, '')) throw new SetupRefused('This link names another box than the one it points to. Make a new link on your Mac.')
    this.refuseOthers(bundle.data)
    return { ...parsed, bundle: bundle.data, sealed: String(peeked.bundle), pairingId: String(peeked.pairingId), expiresAt: Number(peeked.expiresAt) }
  }

  /** A computer set up already refuses another giver or box; a saved box key is never replaced in silence. */
  private refuseOthers(bundle: SetupBundle): void {
    const pins = this.deps.given.pins()
    if (pins) {
      if (pins.giver.signPublic !== bundle.giver.identity.signPublic || pins.box.envId !== bundle.box.envId) {
        throw new SetupRefused(`This computer is set up from ${pins.giver.name}. Remove it there before using another link.`)
      }
      throw new SetupRefused('This computer is set up already.')
    }
    if (this.deps.savedHosts().some((h) => h.id === bundle.box.envId)) {
      throw new SetupRefused('This computer already links to that box with a key of its own. Remove the host in Settings → Hosts first.')
    }
  }

  async peek(link: string): Promise<SetupPeek> {
    const o = await this.open(link)
    return { origin: o.origin, giver: o.bundle.giver.name, items: o.bundle.items, expiresAt: o.expiresAt }
  }

  // ── set up this PC ─────────────────────────────────────────────────────

  private stepsFor(items: SetupItems): SetupStepRow[] {
    const steps: SetupStep[] = ['link', 'allow']
    if (items.accounts) steps.push('accounts')
    if (items.lifeos && this.deps.platform === 'win32') steps.push('lifeos')
    if (items.lifeos) steps.push('work')
    if (items.folders) steps.push('folders')
    return steps.map((step) => ({ step, state: 'waiting' }))
  }

  private report(step: SetupStep, state: SetupStepRow['state'], reason?: string): void {
    const s = this.saved()
    if (!s) return
    const steps = s.steps.map((r) => (r.step === step ? { step, state, ...(reason ? { reason } : {}) } : r))
    this.save({ ...s, steps })
    this.deps.push({ push: 'device-setup', step, state, ...(reason ? { reason } : {}), ...(step === 'allow' ? { words: s.words } : {}) })
    if (steps.every((r) => r.state === 'done')) this.finish()
  }

  private stepState(step: SetupStep): SetupStepRow['state'] | null {
    return this.saved()?.steps.find((r) => r.step === step)?.state ?? null
  }

  /** Set up this PC: the link step here, the rest as the giver and the window move. */
  async start(link: string): Promise<{ ok: true }> {
    const prior = this.saved()
    if (prior && !prior.steps.every((r) => r.state === 'done') && this.deps.given.pins()) throw new SetupRefused('This computer is being set up already.')
    const o = await this.open(link)
    // A Remove halted the last setup; this one runs.
    this.closed = false
    const identity = this.deps.identity.publicIdentity()
    const keys = this.deps.identity.keys()
    let answer: SetupClaimAnswer
    let fields: ClaimFields
    try {
      // Each try signs a fresh challenge: a lost reply is recovered under a new one, never by the first body again (F18).
      const signed = async () => {
        const { challenge } = await this.post<{ challenge: string }>(o.origin, '/api/setup/challenge', { code: o.code })
        const f: ClaimFields = { origin: o.origin, pairingId: o.pairingId, bundleDigest: bundleDigest(o.sealed), identity, envId: this.deps.environmentId, challenge }
        const bytes = claimBytes(f)
        return { code: o.code, origin: o.origin, envId: f.envId, identity, challenge, proof: { verifierSig: signBytes(deriveLinkKeys(o.secret).verifier.private, bytes), deviceSig: signBytes(keys.signPrivate, bytes) } }
      }
      answer = await this.claim(o.origin, signed)
      // The words come from the claim on file, whichever try made it.
      if (!answer.challenge) throw new Error('the box did not say which claim it holds')
      fields = { origin: o.origin, pairingId: o.pairingId, bundleDigest: bundleDigest(o.sealed), identity, envId: this.deps.environmentId, challenge: answer.challenge }
    } catch (err) {
      throw new SetupRefused(refusalWords(err))
    }
    await this.deps.given.pinGiver({
      giver: { signPublic: o.bundle.giver.identity.signPublic, name: o.bundle.giver.name, envId: o.bundle.giver.envId },
      box: { envId: o.bundle.box.envId, origin: o.origin },
      boxKey: answer.key,
      generation: answer.generation
    })
    const { appearance, defaultModels, work } = o.bundle.seeds
    this.save({
      origin: o.origin,
      giver: o.bundle.giver.name,
      pairingId: o.pairingId,
      boxEnvId: o.bundle.box.envId,
      expiresAt: answer.expiresAt,
      words: setupWords(fields),
      items: o.bundle.items,
      seeds: appearance !== undefined || defaultModels !== undefined ? { appearance, defaultModels } : null,
      steps: this.stepsFor(o.bundle.items)
    })
    if (typeof work === 'boolean') this.deps.setWork(work)
    this.log(`claimed a setup link from ${o.bundle.giver.name}; waiting for Allow`)
    this.report('link', 'done')
    void this.waitForAllow()
    return { ok: true }
  }

  /** The claim; a reply lost on the way is asked again under a fresh challenge, which the box answers with the same key id. */
  private async claim(origin: string, signed: () => Promise<unknown>): Promise<SetupClaimAnswer> {
    for (let i = 1; ; i++) {
      try {
        return await this.post<SetupClaimAnswer>(origin, '/api/setup/claim', await signed())
      } catch (err) {
        if (err instanceof HttpRefusal || i >= CLAIM_TRIES) throw err
        await this.sleep(1_000 * i)
      }
    }
  }

  /** Asks the box until the giver allows, or the link ends. */
  private async waitForAllow(): Promise<void> {
    if (this.allowing) return
    this.allowing = true
    try {
      this.report('allow', 'working')
      for (;;) {
        const s = this.saved()
        const pins = this.deps.given.pins()
        if (!s || !pins || this.closed) return
        let state: string | null = null
        try {
          state = (await this.post<{ state: string }>(s.origin, '/api/setup/status', {}, pins.boxKey)).state
        } catch (err) {
          if (err instanceof HttpRefusal && (err.status === 401 || err.status === 410)) {
            await this.deps.given.abandon()
            return this.report('allow', 'failed', `The link ended before ${s.giver} allowed this computer. Make a new link on your Mac.`)
          }
        }
        if (state === 'active') {
          try {
            await this.deps.saveBox(s.origin, pins.boxKey, pins.box.envId)
          } catch {
            return this.report('allow', 'failed', 'The box could not be saved. Retry.')
          }
          return this.report('allow', 'done')
        }
        await this.sleep(POLL_MS)
      }
    } finally {
      this.allowing = false
    }
  }

  /** given.ts heard a letter: the activate letter's LifeOS codes, the first manifest's accounts. */
  onApplied(kind: 'activate' | 'manifest', extra: Record<string, unknown> | undefined): void {
    const s = this.saved()
    if (!s) return
    if (kind === 'manifest' && this.stepState('accounts') !== 'done' && this.stepState('accounts') !== null) this.report('accounts', 'done')
    if (kind === 'activate') {
      if (this.stepState('allow') !== 'done') this.report('allow', 'done')
      const lifeos = extra?.lifeos as LifeosCodes | undefined
      if (lifeos && s.items.lifeos) {
        // Saved before the letter counts as applied: a write that fails fails the apply, which runs again (F20).
        this.deps.codes.write(JSON.stringify(lifeos))
        void this.runLifeos(lifeos)
      }
    }
  }

  private readCodes(): LifeosCodes | null {
    try {
      const raw = this.deps.codes.read()
      return raw ? (JSON.parse(raw) as LifeosCodes) : null
    } catch {
      return null
    }
  }

  private async runLifeos(codes: LifeosCodes | null = this.readCodes()): Promise<void> {
    const s = this.saved()
    if (!s || !codes) return
    const missing = codes.missing ? `${s.giver}'s Work is not signed in to LifeOS. Sign in there, then make a new link.` : null
    if (this.stepState('lifeos') !== null && this.stepState('lifeos') !== 'done') {
      await this.once('lifeos', async () => {
        if (missing || !codes.codes?.desktop || !codes.owner) return this.report('lifeos', 'failed', missing ?? 'The giver sent no LifeOS sign-in')
        this.report('lifeos', 'working')
        const out = await this.deps.installLifeos({ code: codes.codes.desktop, owner: codes.owner, reader: !!codes.reader }, () => {})
        if (out.ok && out.signedIn && codes.reader) noteGave(this.deps.store, { reader: true })
        this.report('lifeos', out.ok ? 'done' : 'failed', out.ok ? undefined : out.reason)
      })
    }
    if (this.stepState('work') !== null && this.stepState('work') !== 'done') {
      await this.once('work', async () => {
        if (missing || !codes.codes?.tempcode || !codes.owner) return this.report('work', 'failed', missing ?? 'The giver sent no LifeOS sign-in')
        this.report('work', 'working')
        const attempt = codes.attempt ?? randomBytes(32).toString('base64url')
        if (!codes.attempt) this.deps.codes.write(JSON.stringify({ ...codes, attempt }))
        const out = await this.deps.signInWork({ code: codes.codes.tempcode, owner: codes.owner, attempt })
        if (out.outcome === 'signed-in' && out.token) noteGave(this.deps.store, { work: out.token })
        this.report('work', out.outcome === 'failed' ? 'failed' : 'done', out.outcome === 'failed' ? out.reason : undefined)
      })
    }
  }

  private async once(step: SetupStep, fn: () => Promise<void>): Promise<void> {
    if (this.running.has(step) || this.closed) return
    const run = (async () => {
      try {
        await fn()
      } catch {
        this.report(step, 'failed', 'Something went wrong on this step. Retry.')
      }
    })()
    this.running.set(step, run)
    try {
      await run
    } finally {
      this.running.delete(step)
    }
  }

  /** The window's Add folders… pick. */
  async folders(paths: string[]): Promise<{ added: string[] }> {
    if (this.stepState('folders') === null) throw new SetupRefused('This setup gives no folders.')
    const added = await this.deps.addFolders(paths)
    this.report('folders', 'done')
    return { added }
  }

  /** Retry on a failed step. */
  async retry(step: SetupStep): Promise<{ ok: true }> {
    if (this.stepState(step) !== 'failed') throw new SetupRefused('Only a failed step runs again.')
    if (step === 'allow') void this.waitForAllow()
    else if (step === 'lifeos' || step === 'work') void this.runLifeos()
    else this.report(step, 'waiting')
    return { ok: true }
  }

  state(): SetupState | null {
    const s = this.saved()
    if (!s) return null
    return { origin: s.origin, giver: s.giver, words: s.words, steps: s.steps, seeds: s.seeds, done: s.steps.every((r) => r.state === 'done') }
  }

  /** Every step done: the codes go; the state stays for the Ready screen. */
  private finish(): void {
    try {
      this.deps.codes.clear()
    } catch {
      // gone with a locked vault
    }
  }

  /** Shutdown: the Allow ask stops; the next boot resumes it. */
  close(): void {
    this.closed = true
  }

  /**
   * Remove, before it clears anything: no step starts again and the ones under way finish, so a sign-in
   * never lands after the wipe; then setup's progress, its codes and what it gave go (F16, F23).
   */
  async halt(): Promise<void> {
    this.closed = true
    await Promise.all([...this.running.values()].map((p) => p.catch(() => {})))
  }

  /** The last of Remove and Start fresh: setup's saved progress, codes and record of what it gave. */
  forget(): void {
    this.save(null)
    this.deps.store.setSetting(SETUP_GAVE, null)
    this.finish()
  }

  /** Boot: a setup in progress carries on where it was. */
  resume(): void {
    const s = this.saved()
    if (!s || s.steps.every((r) => r.state === 'done')) return
    const allow = this.stepState('allow')
    if (allow === 'waiting' || allow === 'working') void this.waitForAllow()
    else if (allow === 'done') void this.runLifeos()
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
