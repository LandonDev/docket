import type { Screen, ScreenElement } from '@shared/computer/outward'
import type { ComputerAction } from '@shared/computer/protocol'
import { guardSteps } from './guard'
import { formIdOf } from '@shared/work/msforms'
import { addressOf, goneOf, signInOf } from './read'
import { CarrierGone, CarrierSignIn, CarrierStop, type CarrierOp, type FormRead } from './types'

/**
 * The carrier's hands on one page, under the trial's rules
 * (docs/agents/work-msforms.md "The trial's rules"):
 *  - a window is followed by its id, never its title (a form's window title
 *    follows the form's title), and the id is the page the open made;
 *  - a form's page shows that form's id in its address at every read;
 *  - a step's elements come from a read made just before it, and an index is
 *    never reused across reads;
 *  - a click that mounts a field is followed by a read before typing into it;
 *  - Tab commits a field, never Escape (it drops the edit) and never Return
 *    in an option field (it takes a suggestion chip);
 *  - a step is tried again at most once, after one fresh read.
 */

/** What the carrier needs of the box browser: windows by id, a read, steps read against a screen. */
export interface FormsComputer {
  /** opens `url` in a window of its own and answers that window's id: the page the open made, for every later step */
  open(url: string): Promise<string>
  /** a fresh read of the whole window, with the address bar */
  read(window: string): Promise<Screen>
  /** runs steps read against `screen`; answers false (with words) when the page did not take them */
  act(window: string, screen: Screen, steps: readonly ComputerAction[]): Promise<{ ok: boolean; words?: string }>
  /** the windows open now, with their addresses and, for a page another page opened, that page's id */
  windows(): Promise<{ id: string; url: string; opener?: string }[]>
  close(window: string): Promise<void>
  /** waits; a test's computer answers at once */
  wait(ms: number): Promise<void>
  /**
   * A request from inside the page of `window`, as the signed-in page itself
   * would make it (SharePoint REST from the folder's site page). `bytes`
   * answers the body as bytes; otherwise its JSON. Never a Forms address.
   */
  fetch(window: string, url: string, o?: { bytes?: boolean; method?: 'GET' | 'POST'; headers?: Record<string, string> }): Promise<{ status: number; json?: unknown; bytes?: Uint8Array }>
}

const all = (screen: Screen): ScreenElement[] => [...screen.elements.values()]

/** The one element of these roles whose name matches; null when none or more than one. */
export function one(screen: Screen, roles: readonly string[], name: RegExp, o: { within?: number } = {}): ScreenElement | null {
  const hits = all(screen).filter((e) => roles.includes(e.role) && name.test(e.name ?? '') && (o.within === undefined || isUnder(screen, e, o.within)))
  return hits.length === 1 ? hits[0] : null
}

/** The first such element, for a list where Forms repeats a control (an option's Delete). */
export const first = (screen: Screen, roles: readonly string[], name: RegExp): ScreenElement | null => all(screen).find((e) => roles.includes(e.role) && name.test(e.name ?? '')) ?? null

function isUnder(screen: Screen, e: ScreenElement, ancestor: number): boolean {
  for (let p = e.parent; p !== null; p = screen.elements.get(p)?.parent ?? null) if (p === ancestor) return true
  return false
}

export const isOn = (e: ScreenElement | null): boolean => !!e && (e.states.includes('checked') || e.states.includes('on'))

export const click = (e: ScreenElement): ComputerAction => ({ action: 'left_click', element: e.index }) as ComputerAction
export const typeInto = (e: ScreenElement, text: string): ComputerAction => ({ action: 'type', element: e.index, text }) as ComputerAction
export const tab = (e: ScreenElement): ComputerAction => ({ action: 'key', element: e.index, text: 'Tab' }) as ComputerAction

/** One window driven by one operation: every step guarded for the operation, every read fresh. */
export class Page {
  private screen: Screen | null = null
  /** what the operation has done, for the sentence a stop says */
  readonly done: string[] = []

  constructor(
    readonly computer: FormsComputer,
    readonly window: string,
    readonly op: CarrierOp,
    /** the form this page is of, once known: every stop names it, so a form made before the stop is kept (P1) */
    readonly formId: string | null = null
  ) {}

  /**
   * A fresh read. Microsoft's sign-in stops the operation and says so. A page of a known form must show that form's id
   * in its address at every read, before any step is taken on it: another form, or none, stops the operation (review 16).
   */
  async read(): Promise<Screen> {
    const screen = await this.computer.read(this.window)
    const address = addressOf(screen)
    if (signInOf(screen, address)) throw new CarrierSignIn()
    this.screen = null
    // Forms' page for a deleted form is no other form: the form is gone, said apart from every other stop
    if (this.formId !== null && goneOf(screen)) throw new CarrierGone(this.formId)
    if (this.formId !== null && (address ? formIdOf(address) : null) !== this.formId) this.stop('Forms showed another form than the one asked')
    this.screen = screen
    return screen
  }

  /** Reads until `found` answers, a few times over about `ms`; the last read either way. */
  async until<T>(found: (s: Screen) => T | null | undefined | false, ms = 15_000, every = 1_000): Promise<{ screen: Screen; got: T | null }> {
    let screen = await this.read()
    for (let waited = 0; ; waited += every) {
      const got = found(screen)
      if (got) return { screen, got }
      if (waited >= ms) return { screen, got: null }
      await this.computer.wait(every)
      screen = await this.read()
    }
  }

  /**
   * Runs steps against the last read, each guarded for the operation. A step
   * the page did not take is tried once more on a fresh read, its elements
   * found again by `again` (an index is never reused across reads).
   */
  async act(steps: (s: Screen) => ComputerAction[] | null, what: string): Promise<Screen> {
    const screen = this.screen ?? (await this.read())
    const first = steps(screen)
    if (!first) return this.stop(`${what} was not on the page`)
    if (!first.length) return screen
    guardSteps(this.op, screen, first)
    const ran = await this.computer.act(this.window, screen, first)
    if (!ran.ok) {
      const fresh = await this.read()
      const second = steps(fresh)
      if (!second) return this.stop(`${what} did not take${ran.words ? ` (${ran.words})` : ''}`)
      guardSteps(this.op, fresh, second)
      const again = await this.computer.act(this.window, fresh, second)
      if (!again.ok) return this.stop(`${what} did not take${again.words ? ` (${again.words})` : ''}`)
    }
    // A click mounts what it opens: the next step reads first.
    return this.read()
  }

  /** Stops the operation, saying what it had done. */
  stop(why: string, read: FormRead | null = null): never {
    const head = this.done.length ? `${this.done.join('; ')}; then ${why}` : `${why[0].toUpperCase()}${why.slice(1)}`
    throw new CarrierStop(`${head}.`, read, read?.formId ?? this.formId)
  }

  get last(): Screen | null {
    return this.screen
  }
}
