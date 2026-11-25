import type { Screen, ScreenElement } from '@shared/computer/outward'
import { formIdOf, MSFORM_NEW_SETTINGS, type MsAnyQuestion, type MsFormSettings, type MsQuestion } from '@shared/work/msforms'
import type { FormRead } from './types'

/**
 * Reading a form back from the Forms page's accessibility tree (the trial's
 * names, trial-raw.md §5). Forms' own `/formapi` JSON is never read or
 * called: what the page shows him is what Work keeps.
 *
 * - the title: button "Form title <title> Saved" (the save state rides the
 *   name), or text area "Form title" while it is being typed;
 * - the description: input "Form description";
 * - a question at rest: button "N. Question title <title> <type> [Required to
 *   answer]", its options the radios or checkboxes inside it;
 * - a question in edit: text area "Question title N …" holding the title,
 *   inputs "Choice Option Text …" holding the options, and switches
 *   "Multiple answers", "Required", "Long answer";
 * - Settings: radios "Anyone can respond", "Only people in <org> can
 *   respond", checkboxes "Record name", "One response per person",
 *   "Accept responses", "Start date", "End date";
 * - Collect responses: input "Link for Collecting Responses";
 * - the Responses view: "<n> Responses" or "No responses yet".
 */

const all = (screen: Screen): ScreenElement[] => [...screen.elements.values()]
const on = (e: ScreenElement): boolean => e.states.includes('checked') || e.states.includes('selected') || e.states.includes('on')
const off = (e: ScreenElement): boolean => e.states.includes('unchecked') || e.states.includes('off')

/** The children of an element, in index order. */
export function childrenOf(screen: Screen, index: number): ScreenElement[] {
  return all(screen).filter((e) => e.parent === index)
}

/** Whether `e` sits inside `ancestor`. */
export function inside(screen: Screen, e: ScreenElement, ancestor: number): boolean {
  for (let p = e.parent; p !== null; p = screen.elements.get(p)?.parent ?? null) if (p === ancestor) return true
  return false
}

/** Every element under `index`. */
export const under = (screen: Screen, index: number): ScreenElement[] => all(screen).filter((e) => inside(screen, e, index))

/** The words Forms ends a question's name with, for each type it offers. */
const TYPE_WORD: { word: RegExp; type: MsQuestion['type'] | 'other'; kind?: string }[] = [
  // the real page says "Single choice" (P1, 2026-11-24); "Multiple choice" with Multiple answers on
  { word: /(?:Single |Multiple )?Choice$/i, type: 'choice' },
  // "Single line text" / "Multi line text" on the real page (P1); bare "Text" in the trial's words
  { word: /(?:Single line |Multi ?line )?Text$/i, type: 'text' },
  { word: /Rating$/i, type: 'rating' },
  { word: /Date$/i, type: 'date' },
  { word: /Section$/i, type: 'section' },
  { word: /Ranking$/i, type: 'other', kind: 'Ranking' },
  { word: /Likert$/i, type: 'other', kind: 'Likert' },
  { word: /Upload File$/i, type: 'other', kind: 'Upload File' },
  { word: /Net Promoter Score®?$/i, type: 'other', kind: 'Net Promoter Score' }
]

const AT_REST = /^(\d+)\.\s*Question title\s+([\s\S]+?)\s*$/
const REQUIRED_TAIL = /\s+Required to answer$/i

/** One question read at rest from its button's name and what lies inside it. */
export function questionAtRest(screen: Screen, button: ScreenElement): MsAnyQuestion | null {
  const m = AT_REST.exec(button.name ?? '')
  if (!m) return null
  let rest = m[2]
  const required = REQUIRED_TAIL.test(rest)
  rest = rest.replace(REQUIRED_TAIL, '')
  const typed = TYPE_WORD.find((t) => t.word.test(rest))
  if (!typed) return null
  const title = rest.replace(typed.word, '').trim()
  if (!title) return null
  if (typed.type === 'other') return { title, type: 'other', kind: typed.kind! }
  const inner = under(screen, button.index)
  const q: MsQuestion = { title, type: typed.type, required: typed.type === 'section' ? false : required }
  if (typed.type === 'choice') {
    const radios = inner.filter((e) => e.role === 'radio' && e.name)
    const boxes = inner.filter((e) => e.role === 'checkbox' && e.name)
    const combo = inner.find((e) => e.role === 'combo box' || e.role === 'pop up button')
    if (combo && !radios.length && !boxes.length) {
      q.dropdown = true
      q.options = inner.filter((e) => (e.role === 'menu item' || e.role === 'option' || e.role === 'cell') && e.name).map((e) => e.name!)
    } else {
      if (boxes.length && !radios.length) q.multiple = true
      q.options = (radios.length ? radios : boxes).map((e) => e.name!)
    }
  }
  if (typed.type === 'text' && (/Multi ?line Text$/i.test(rest) || inner.some((e) => e.role === 'text area'))) q.long = true
  if (typed.type === 'rating') {
    const stars = inner.filter((e) => (e.role === 'radio' || e.role === 'button') && /^\d+/.test(e.name ?? '')).length
    q.scale = stars >= 10 ? 10 : 5
  }
  return q
}

/** The question in edit, if one is: its title text area, its option inputs and its switches. */
export function questionInEdit(screen: Screen): { title: ScreenElement; options: ScreenElement[]; required: ScreenElement | null; multiple: ScreenElement | null; long: ScreenElement | null; addOption: ScreenElement | null } | null {
  // an input while it holds nothing new, a text area once typed in (P1, 2026-11-24)
  const title = all(screen).find((e) => (e.role === 'text area' || e.role === 'input') && /^Question title\b/i.test(e.name ?? ''))
  if (!title) return null
  const sw = (name: string) => all(screen).find((e) => (e.role === 'switch' || e.role === 'checkbox') && e.name === name) ?? null
  return {
    title,
    options: all(screen).filter((e) => e.role === 'input' && /^Choice Option Text\b/i.test(e.name ?? '')),
    required: sw('Required'),
    multiple: sw('Multiple answers'),
    long: sw('Long answer'),
    addOption: all(screen).find((e) => e.role === 'button' && e.name === 'Add option') ?? null
  }
}

/**
 * The form's own title button, the one that opens the title for typing. The real page also draws the title in its
 * top bar with the save state ("Form title Untitled form Saved"); that one is not pressed (P1, 2026-11-24).
 */
export function formTitleButton(screen: Screen): ScreenElement | null {
  const buttons = all(screen).filter((e) => e.role === 'button' && /^Form title\b/.test(e.name ?? ''))
  const own = buttons.filter((e) => !SAVE_STATE.test(e.name ?? ''))
  return own.length === 1 ? own[0] : buttons.length === 1 ? buttons[0] : null
}
const SAVE_STATE = /\s+(Saved|Saving\.\.\.|Saving…|Not saved)$/i
/** Whether the page still says it is saving a change (its top bar's title, "… Saving..."). */
export const savingOf = (screen: Screen): boolean => all(screen).some((e) => e.role === 'button' && /^Form title\b.*\sSaving(\.\.\.|…)$/i.test(e.name ?? ''))

/** The form's title: its button at rest (save state cut away), or the text area while typed. */
export function titleOf(screen: Screen): string {
  const editing = all(screen).find((e) => e.role === 'text area' && e.name === 'Form title')
  if (editing?.value !== undefined) return editing.value.trim()
  const button = all(screen).find((e) => e.role === 'button' && /^Form title\s/.test(e.name ?? ''))
  if (!button?.name) return ''
  return button.name
    .replace(/^Form title\s+/, '')
    .replace(/\s+(Saved|Saving\.\.\.|Saving…|Not saved)$/i, '')
    .trim()
}

/** Settings' Accept responses: the real panel names it after its section's heading too ("Options for responses Accept responses", P1 2026-11-24). */
export const ACCEPT_RESPONSES = /^(?:Options for responses\s+)?Accept responses$/i
/** The Settings panel's close: "Settings Close" on the real page. */
export const SETTINGS_CLOSE = /^(?:Settings\s+)?Close(?: settings)?$/i

/** Whether the page shows its edits saved. */
export const savedOf = (screen: Screen): boolean => all(screen).some((e) => e.role === 'button' && /^Form title\s.*\sSaved$/i.test(e.name ?? ''))

/** The settings as the Settings panel (or the Collect responses dialog) shows them; what is not shown keeps `was`. */
export function settingsOf(screen: Screen, was: MsFormSettings = MSFORM_NEW_SETTINGS): MsFormSettings {
  const named = (role: string[], re: RegExp) => all(screen).find((e) => role.includes(e.role) && re.test(e.name ?? ''))
  const flag = (e: ScreenElement | undefined, fallback: boolean): boolean => (e ? (on(e) ? true : off(e) ? false : fallback) : fallback)
  const anyone = named(['radio'], /^Anyone can respond/i)
  const org = named(['radio'], /^Only people in .+ can respond/i)
  const orgOnly = org && on(org) ? true : anyone && on(anyone) ? false : was.orgOnly
  const out: MsFormSettings = {
    accepting: flag(named(['checkbox', 'switch'], ACCEPT_RESPONSES), was.accepting),
    orgOnly,
    recordName: flag(named(['checkbox', 'switch'], /^Record name$/i), was.recordName),
    onePerPerson: flag(named(['checkbox', 'switch'], /^One response per person$/i), was.onePerPerson)
  }
  const start = named(['checkbox', 'switch'], /^Start date$/i)
  const end = named(['checkbox', 'switch'], /^End date$/i)
  const dateAfter = (box: ScreenElement | undefined): string | undefined => {
    if (!box || !on(box)) return undefined
    const date = all(screen).find((e) => (e.role === 'date' || e.role === 'input') && e.index > box.index && /date/i.test(e.name ?? '') && e.value)
    return date?.value
  }
  const s = start ? dateAfter(start) : was.startDate
  const e = end ? dateAfter(end) : was.endDate
  if (s) out.startDate = s
  if (e) out.endDate = e
  return out
}

/** The Responses view's count; null when the page shows none. */
export function countOf(screen: Screen): number | null {
  for (const e of all(screen)) {
    const name = `${e.name ?? ''} ${e.value ?? ''}`.trim()
    // "No responses yet, get your data now." on a form no one has answered (P5)
    if (/^No responses( yet)?\b/i.test(name)) return 0
    const m = /^(\d[\d,]*)\s+Responses?$/i.exec(name) ?? /^Responses\s+(\d[\d,]*)$/i.exec(name)
    if (m) return Number(m[1].replace(/,/g, ''))
  }
  return null
}

/** The response link, from the Collect responses dialog. */
export function linkOf(screen: Screen): string | null {
  const input = all(screen).find((e) => e.role === 'input' && /^Link for Collecting Responses$/i.test(e.name ?? ''))
  return input?.value?.trim() || null
}

/** The address the box browser shows, from its address bar. */
export function addressOf(screen: Screen): string | null {
  const bar = all(screen).find((e) => e.role === 'input' && /^Address and search bar$/i.test(e.name ?? ''))
  const v = bar?.value?.trim()
  if (!v) return null
  return /^https?:\/\//i.test(v) ? v : `https://${v}`
}

/** The account the page names as signed in, when it shows an address. */
export function accountOf(screen: Screen): string | null {
  for (const e of all(screen)) {
    const m = /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/.exec(`${e.name ?? ''} ${e.value ?? ''}`)
    if (m && /account|signed in|profile|me control/i.test(`${e.role} ${e.name ?? ''}`)) return m[1].toLowerCase()
  }
  return null
}

/** Whether the page is Microsoft's sign-in, not Forms. */
export function signInOf(screen: Screen, address: string | null): boolean {
  if (address && /login\.microsoftonline\.com|login\.live\.com/i.test(address)) return true
  return all(screen).some((e) => (e.role === 'heading' || e.role === 'text') && /^(Sign in|Pick an account|Sign in to your account)$/i.test(e.name ?? ''))
}

/** Every question the builder shows at rest, in order (and the one in edit, read from its fields). */
export function questionsOf(screen: Screen): MsAnyQuestion[] {
  const out: { n: number; q: MsAnyQuestion }[] = []
  for (const e of all(screen)) {
    if (e.role !== 'button') continue
    const m = AT_REST.exec(e.name ?? '')
    if (!m) continue
    const q = questionAtRest(screen, e)
    if (q) out.push({ n: Number(m[1]), q })
  }
  // A section heading carries no number in some layouts: kept in place by its index.
  return out.sort((a, b) => a.n - b.n).map((x) => x.q)
}

/** The whole form as one read of the builder shows it. `settings` comes from the panel when it is open, else `was`. */
export function formOf(screen: Screen, o: { formId?: string; was?: MsFormSettings } = {}): FormRead {
  const address = addressOf(screen)
  const formId = (address ? formIdOf(address) : null) ?? o.formId ?? ''
  const description = all(screen).find((e) => (e.role === 'input' || e.role === 'text area') && e.name === 'Form description')?.value ?? ''
  return {
    formId,
    title: titleOf(screen),
    description: description.trim(),
    questions: questionsOf(screen),
    settings: settingsOf(screen, o.was),
    count: countOf(screen),
    signedInAs: accountOf(screen),
    link: linkOf(screen)
  }
}
