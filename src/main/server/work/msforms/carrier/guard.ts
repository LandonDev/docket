import type { Screen, ScreenElement } from '@shared/computer/outward'
import type { ComputerAction } from '@shared/computer/protocol'
import { ACCEPT_RESPONSES, SETTINGS_CLOSE } from './read'
import { CarrierRefused, type CarrierOp } from './types'

/**
 * The carrier's guard (docs/agents/work-msforms.md "The carrier"): for each
 * operation, the controls it may press, by role and name and, where a name
 * is not enough, the names above them. A step on anything else is refused
 * before it is sent. Some controls are never pressed by any operation: the
 * ones that send the link, share the form, copy it out or delete answers.
 * A toggle that widens who can answer, or turns answers on, is allowed only
 * where the operation itself is that act (collect, audience, a reopen).
 */

export interface Control {
  roles: readonly string[]
  name: RegExp
  /** an ancestor's name must match (a menu item under its menu, a button in a dialog) */
  under?: RegExp
  /** a toggle that may only be turned this way: 'off' presses it only while it is on */
  only?: 'on' | 'off'
}

const BUTTON = ['button', 'link', 'menu button', 'pop up button']
const ITEM = ['menu item', 'button', 'link', 'option']
const TOGGLE = ['checkbox', 'switch']
const FIELD = ['input', 'text area', 'date', 'combo box']

/** Pressed by nothing the carrier runs, whatever its authorization. */
export const NEVER: readonly Control[] = [
  { roles: [...BUTTON, ...ITEM], name: /^Send\b/i },
  { roles: [...BUTTON, ...ITEM], name: /^Copy( link)?$/i },
  { roles: [...BUTTON, ...ITEM], name: /^Copy\b.*\blink\b/i },
  { roles: [...BUTTON, ...ITEM, ...TOGGLE], name: /^Shorten URL$/i },
  { roles: [...BUTTON, ...ITEM], name: /Share the link to collaborate/i },
  { roles: [...BUTTON, ...ITEM], name: /Get a link to duplicate/i },
  { roles: [...BUTTON, ...ITEM], name: /^(Collaborate or Duplicate|Add collaborators|Share as a template)$/i },
  { roles: [...BUTTON, ...ITEM], name: /^Move to a group$/i },
  { roles: [...BUTTON, ...ITEM], name: /^Delete all responses$/i },
  { roles: [...BUTTON, ...ITEM], name: /^Share a summary link$/i },
  { roles: [...BUTTON, ...ITEM], name: /^Quick import$/i },
  { roles: [...BUTTON, ...ITEM], name: /^(New Group Form|New Group Quiz|New Quiz|Create new form)$/i },
  { roles: [...BUTTON, ...ITEM], name: /\btemplate\b/i },
  { roles: [...BUTTON, ...ITEM], name: /^Print( Form| summary)?$/i },
  { roles: [...BUTTON, ...ITEM], name: /^Delete( form)?$/i },
  { roles: [...BUTTON, ...ITEM], name: /^(Outlook|Teams)$/i, under: /Send and collect responses/i }
]

const TITLE: Control[] = [
  { roles: BUTTON, name: /^Form title\b/ },
  { roles: FIELD, name: /^Form title$/ },
  { roles: FIELD, name: /^Form description$/ }
]

const QUESTIONS: Control[] = [
  { roles: BUTTON, name: /^(Add new question|Quick start with)$/i },
  { roles: BUTTON, name: /^(Choice|Text|Rating|Date|Section)$/i },
  { roles: BUTTON, name: /^\d+\.\s*Question title\b/ },
  { roles: FIELD, name: /^Question title\b/i },
  { roles: FIELD, name: /^Choice Option Text\b/i },
  { roles: BUTTON, name: /^Add option$/i },
  { roles: BUTTON, name: /^Delete .+/i, under: /Question title|Choice Option/i },
  { roles: BUTTON, name: /^Move option (up|down)$/i },
  { roles: BUTTON, name: /^Move question (up|down)\b/i },
  { roles: BUTTON, name: /^Delete question\b/i },
  { roles: TOGGLE, name: /^(Required|Multiple answers|Long answer)$/i },
  { roles: BUTTON, name: /^More settings for question$/i },
  { roles: ITEM, name: /^Drop-down$/i, under: /More settings for question/i },
  { roles: FIELD, name: /^(Levels|Symbol)$/i }
]

const SETTINGS_PANEL: Control[] = [
  { roles: BUTTON, name: /^Settings$/i },
  { roles: BUTTON, name: SETTINGS_CLOSE }
]
/** Who answers, narrowed only: Only people in the org, names kept, one answer each. */
const NARROW: Control[] = [
  { roles: ['radio'], name: /^Only people in .+ can respond/i },
  { roles: TOGGLE, name: /^Record name$/i },
  { roles: TOGGLE, name: /^One response per person$/i }
]
const WIDEN: Control[] = [{ roles: ['radio'], name: /^Anyone can respond/i }]
const DATES: Control[] = [
  { roles: TOGGLE, name: /^(Start date|End date)$/i },
  { roles: FIELD, name: /(start|end) (date|time)/i }
]
const ACCEPT_OFF: Control[] = [{ roles: TOGGLE, name: ACCEPT_RESPONSES, only: 'off' }]
const ACCEPT_ON: Control[] = [{ roles: TOGGLE, name: ACCEPT_RESPONSES, only: 'on' }]
const COLLECT: Control[] = [
  { roles: BUTTON, name: /^Collect responses$/i },
  { roles: BUTTON, name: /^Close$/i, under: /Send and collect responses/i }
]
const RESPONSES: Control[] = [
  { roles: [...BUTTON, 'tab'], name: /^(View responses|Responses)$/i },
  // the tip Forms lays over the Responses view (P1): its Got it only dismisses it
  { roles: BUTTON, name: /^Got it$/i }
]
const PULL: Control[] = [
  { roles: BUTTON, name: /^Open results in Excel$/i },
  { roles: BUTTON, name: /^Continue$/i, under: /Excel/i }
]
const MAKE: Control[] = [
  { roles: BUTTON, name: /^(Create or upload|New)$/i },
  { roles: ITEM, name: /^(?:xlsx\s+)?Forms survey$/i }
]
const PREFILL: Control[] = [
  { roles: BUTTON, name: /^More form settings$/i },
  { roles: ITEM, name: /^Get Pre-?filled URL$/i },
  { roles: BUTTON, name: /^Start Now$/i },
  { roles: [...FIELD, 'radio', 'checkbox'], name: /.+/, under: /Pre-?filled|Question title|^\d+\./i },
  { roles: BUTTON, name: /^Get Prefilled Link$/i }
]

/** What each operation may press. */
export const ALLOWED: Record<CarrierOp, readonly Control[]> = {
  make: [...MAKE, ...SETTINGS_PANEL, ...ACCEPT_OFF, ...TITLE, ...QUESTIONS, ...NARROW, ...DATES],
  write: [...TITLE, ...QUESTIONS, ...SETTINGS_PANEL],
  settings: [...SETTINGS_PANEL, ...ACCEPT_OFF, ...NARROW, ...DATES],
  collect: [...SETTINGS_PANEL, ...NARROW, ...WIDEN, ...DATES, ...ACCEPT_ON, ...COLLECT],
  audience: [...SETTINGS_PANEL, ...NARROW, ...WIDEN],
  close: [...SETTINGS_PANEL, ...ACCEPT_OFF, ...ACCEPT_ON],
  count: RESPONSES,
  pull: [...RESPONSES, ...PULL],
  prefill: PREFILL
}

/** Keys an operation may press: Tab commits (Escape drops an edit, Return in an option field takes a suggestion chip). */
const KEYS = new Set(['Tab', 'shift+Tab'])

const isOn = (e: ScreenElement): boolean => e.states.includes('checked') || e.states.includes('on')

function ancestors(screen: Screen, e: ScreenElement): string[] {
  const out: string[] = []
  for (let p = e.parent; p !== null; p = screen.elements.get(p)?.parent ?? null) {
    const a = screen.elements.get(p)
    if (a?.name) out.push(a.name)
  }
  return out
}

function matches(screen: Screen, e: ScreenElement, c: Control): boolean {
  if (!c.roles.includes(e.role) || !c.name.test(e.name ?? '')) return false
  if (c.under && !ancestors(screen, e).some((n) => c.under!.test(n))) return false
  if (c.only === 'off' && !isOn(e)) return false
  if (c.only === 'on' && isOn(e)) return false
  return true
}

const elementOf = (step: ComputerAction): number | null => {
  const e = (step as { element?: unknown }).element
  return typeof e === 'number' ? e : null
}

/** Refuses a step the operation may not take. The step must name an element the screen shows. */
export function guardStep(op: CarrierOp, screen: Screen, step: ComputerAction): void {
  const refuse = (why: string): never => {
    throw new CarrierRefused(`The carrier refused a step: ${why}. Nothing more was done in Forms.`)
  }
  const index = elementOf(step)
  const action = (step as { action: string }).action
  if (action === 'key') {
    const text = (step as { text?: string }).text ?? ''
    if (!KEYS.has(text)) refuse(`the key ${text || '(none)'} is not one it presses`)
  }
  if (action === 'scroll' || action === 'wait') return
  if (index === null) return refuse('it names no element')
  const e = screen.elements.get(index)
  if (!e) return refuse('it names nothing the page shows')
  if (NEVER.some((c) => matches(screen, e, { ...c, only: undefined }))) refuse('that control is one no carrier operation presses')
  if (action === 'type' && !['input', 'text area', 'date', 'combo box'].includes(e.role)) refuse('that control takes no typing')
  if (!ALLOWED[op].some((c) => matches(screen, e, c))) refuse(`that control is not one ${op} presses`)
}

/** Guards every step of a batch against the one screen it was read against. */
export function guardSteps(op: CarrierOp, screen: Screen, steps: readonly ComputerAction[]): void {
  for (const s of steps) guardStep(op, screen, s)
}
