/**
 * A computer call's result text (docs/computer-protocol.md §9): the step and
 * screenshot lines the host writes and the readers that take them back
 * apart. Its own file, re-exported by tools.ts, so the transcript's
 * phrases (words.ts, computerShots.ts) read a line without bringing the
 * tools' schemas and descriptions into the first paint.
 */
import { parseElementLine } from './observation'
import { COMPUTER_ACTION_NAMES, NO_INPUT_ACTION_NAMES as NO_INPUT_ACTIONS } from './protocolValues'
import type {
  ComputerAction,
  ComputerActionName,
  DiskChange,
  ElementBrief,
  InputVia,
  StepEffect,
  StepResult,
  WaitReport
} from './protocol'

export const STEP_SEPARATOR = ' · '
export const EFFECT_WORDS: Readonly<Record<StepEffect, string>> = {
  changed: 'changed',
  none: 'no change seen',
  unknown: "can't tell",
  uncommitted: 'on screen only, not on disk'
}
/** Between `uncommitted`'s words and what commits the step instead (§26.12). */
export const HINT_SEPARATOR = '; '
/** The disk part of a step line, after its effect (§26.12). */
export const DISK_PREFIX = 'on disk: '
/** Anthropic's own sentence, with "batch" for "turn". */
export const NOT_EXECUTED_LINE = 'Not executed: an earlier action in this batch failed.'
/**
 * A step §27.8 stopped: `n` is the step that changed nothing, numbered from 1 as the screenshot lines number steps
 * (the wire's `afterStep` + 1).
 */
export const stoppedLine = (n: number): string => `Not executed: step ${n} changed nothing, so these keys had no planned place.`
/** stoppedLine's line; group 1 is the step that changed nothing. */
export const STOPPED_LINE = /^Not executed: step ([1-9]\d*) changed nothing, so these keys had no planned place\.$/
/** The step that changed nothing, from a stoppedLine line; null for any other line. */
export const parseStoppedLine = (line: string): number | null => {
  const m = STOPPED_LINE.exec(line)
  return m ? Number(m[1]) : null
}
/** Ends the line of a step that opened a window the call then followed (§27.5): ` · opened window "Untitled 2"`. */
export const OPENED_ENDING = `${STEP_SEPARATOR}opened window `
/** The menu-bar path separators a `menu` target takes (§27.10); a step line joins the segments by the second. */
export const MENU_PATH_SEPARATORS = [' > ', ' › '] as const
export const OBSERVATION_FAILED_PREFIX = 'observation failed: '
/** Image parts in one result; past it the lines still name the files. */
export const MAX_IMAGE_PARTS = 4
export const NOT_ATTACHED = ' (not attached)'

const quoteShort = (text: string, max = 60): string => {
  const s = [...text]
  return JSON.stringify(s.length > max ? s.slice(0, max).join('') + '…' : text)
}
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`

/** `[14] button "Save"`: an element as a step line names it, its role and name alone. */
export function briefTarget(brief: ElementBrief): string {
  try {
    const e = parseElementLine(`[${brief.index}] ${brief.line}`)
    return `[${e.index}] ${e.role}${e.name !== undefined ? ` ${JSON.stringify(e.name)}` : ''}`
  } catch {
    return `[${brief.index}]`
  }
}

/** A `menu` target's segments, split on ` > ` or ` › ` (§27.10). */
export const menuPathSegments = (path: string): string[] => path.split(/ > | › /).map((s) => s.trim())

/** `menu File › Save…`: the separator never appears inside the part, so the line reads back. */
const menuWords = (path: string): string => `menu ${menuPathSegments(path).join(' › ').split(STEP_SEPARATOR).join(' ')}`

/** `"Team" [52] menu item`: a `named` target, then the element it resolved to by index and role (§27.9). */
function namedTarget(named: string, resolved: number | undefined, brief: ElementBrief | undefined): string {
  if (resolved === undefined) return JSON.stringify(named)
  let role = ''
  if (brief?.index === resolved)
    try {
      role = ` ${parseElementLine(`[${brief.index}] ${brief.line}`).role}`
    } catch {
      role = ''
    }
  return `${JSON.stringify(named)} [${resolved}]${role}`
}

/** What a step acted on, in the words of its step line; `resolved` is the element a `named` target resolved to. */
export function stepTarget(action: ComputerAction, brief?: ElementBrief, resolved?: number): string {
  const el = (i: number | undefined): string | null =>
    i === undefined ? null : brief && brief.index === i ? briefTarget(brief) : `[${i}]`
  const point = (p: number[] | undefined): string | null => (p ? `${p[0]},${p[1]}` : null)
  const at =
    el(action.element) ?? (action.named !== undefined ? namedTarget(action.named, resolved ?? brief?.index, brief) : null) ?? point(action.coordinate)
  if (action.menu !== undefined) return action.action === 'perform' ? `${action.name} ${menuWords(action.menu)}` : menuWords(action.menu)
  const textIsNotMods: readonly ComputerActionName[] = ['type', 'key', 'hold_key', 'select_text', 'paste']
  const mods = action.text && !textIsNotMods.includes(action.action)
  const withMods = (s: string): string => (mods ? `${s} with ${action.text}` : s)
  switch (action.action) {
    case 'screenshot':
    case 'cursor_position':
    case 'left_mouse_down':
    case 'left_mouse_up':
      return ''
    case 'zoom': {
      const r = action.region!
      return `${r[0]},${r[1]} to ${r[2]},${r[3]}`
    }
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
    case 'mouse_move':
      return withMods(at ?? 'at the cursor')
    case 'left_click_drag':
      return withMods(`${el(action.start_element) ?? point(action.start_coordinate)} to ${at}`)
    case 'scroll':
      return withMods(`${action.scroll_direction} ${action.scroll_amount}${at ? ` on ${at}` : ''}`)
    case 'type':
      return `${quoteShort(action.text!)}${at ? ` into ${at}` : ''}`
    case 'key':
      return `${action.text}${action.repeat && action.repeat > 1 ? ` ×${action.repeat}` : ''}${action.named !== undefined ? ` on ${at}` : ''}`
    case 'hold_key':
      return `${action.text} for ${action.duration} s${action.named !== undefined ? ` on ${at}` : ''}`
    case 'wait':
      return `up to ${action.duration} s`
    case 'set_value':
      return `${at} to ${quoteShort(action.value!)}`
    case 'perform':
      return `${action.name} on ${at}`
    case 'select_text':
      return `${action.text !== undefined ? quoteShort(action.text) : `${action.range![0]}..${action.range![1]}`} in ${at}`
    case 'paste':
      return `${action.format ?? 'text'}${at ? ` into ${at}` : ''}`
    case 'save_as':
      return `${action.path}${action.replace ? ' replacing' : ''}`
  }
}

/**
 * What the commit check found, in the step line's words (§26.12): `saved ~/run/Total.txt`,
 * `renamed ~/run/a.txt to ~/run/b.txt`; null when there is nothing to say.
 */
export function diskWords(disk: DiskChange | undefined): string | null {
  if (!disk) return null
  if (disk.unknown) return "can't tell"
  const parts: string[] = []
  if (disk.saved) parts.push(disk.unexpected ? `saved by the app itself to ${disk.saved}` : `saved ${disk.saved}`)
  for (const r of disk.renamed ?? []) parts.push(`renamed ${r.from} to ${r.to}`)
  for (const p of disk.added ?? []) parts.push(`added ${p}`)
  for (const p of disk.removed ?? []) parts.push(`removed ${p}`)
  if (!parts.length && disk.edited?.before && !disk.edited.after) parts.push('saved in place')
  // the separator never appears inside the part, so the line reads back
  return parts.length ? parts.join(', ').split(STEP_SEPARATOR).join(' ') : null
}

function waitWords(w: WaitReport | undefined): string | null {
  if (!w) return null
  return w.settled ? `settled after ${seconds(w.waitedMs)}` : `still changing after ${seconds(w.waitedMs)}`
}

/**
 * One step line: the verb and its target, then the tier (for `type` the way
 * it went in), then what the service saw. A failed step says why; a step
 * after it says Anthropic's sentence.
 */
export function formatStepLine(step: StepResult, action: ComputerAction): string {
  if (step.status === 'not-run') return step.stopped ? stoppedLine(step.stopped.afterStep + 1) : NOT_EXECUTED_LINE
  const ok = step.status === 'ok' ? step : undefined
  const head = [action.action, stepTarget(action, ok?.element, ok?.resolved)].filter(Boolean).join(' ')
  if (step.status === 'failed') return `${head}${STEP_SEPARATOR}failed: ${step.error.message}`
  const parts = [head]
  if (action.action === 'cursor_position' && step.text) parts.push(step.text)
  else if (action.action === 'wait') {
    const w = waitWords(step.waited)
    if (w) parts.push(w)
  } else if (!NO_INPUT_ACTIONS.includes(action.action)) {
    parts.push(howWords(action, step))
    const hint = step.effect === 'uncommitted' ? step.disk?.hint?.split(STEP_SEPARATOR).join(' ') : undefined
    parts.push(hint ? `${EFFECT_WORDS[step.effect]}${HINT_SEPARATOR}${hint}` : EFFECT_WORDS[step.effect])
    const disk = step.effect === 'uncommitted' ? null : diskWords(step.disk)
    if (disk) parts.push(DISK_PREFIX + disk)
  }
  const line = parts.join(STEP_SEPARATOR)
  return step.opened ? `${line}${OPENED_ENDING}${JSON.stringify(step.opened.title)}` : line
}

/** The background routes (§24.8): the line names them with what they acted on, `menu File › Close`. */
export const FALLBACK_VIAS: readonly InputVia[] = ['menu', 'hit', 'caret', 'scroll-bar', 'scroll-page', 'pick', 'scroll-into-view']

/** How a step went in: a fallback route and what it acted on, `type`'s way, else the tier. A paste that went by the clipboard names its tier. */
function howWords(action: ComputerAction, step: Extract<StepResult, { status: 'ok' }>): string {
  const via = step.input?.via
  if (via === 'panel') return via
  if (via && FALLBACK_VIAS.includes(via)) {
    // a menu target already names its path in the head
    if (action.menu !== undefined) return via
    // the separator never appears inside the part, so the line reads back
    const on = step.input?.on?.split(STEP_SEPARATOR).join(' ')
    const route = on ? `${via} ${on}` : via
    // a route run with the app brought forward says so first: `front menu File › Save`
    return step.tier === 'front' ? `front ${route}` : route
  }
  if (action.action === 'paste') return via === 'ax-insert' ? via : (step.tier ?? 'no tier')
  return via ?? step.tier ?? 'no tier'
}

/** `screenshot 1 (step 2): <path> (1280×800)`, or `(observation)`; ` (not attached)` past MAX_IMAGE_PARTS. */
export function formatShotLine(n: number, where: number | 'observation', shot: { path: string; width: number; height: number }, attached: boolean): string {
  const source = where === 'observation' ? 'observation' : `step ${where}`
  return `screenshot ${n} (${source}): ${shot.path} (${shot.width}×${shot.height})${attached ? '' : NOT_ATTACHED}`
}

export interface ShotLine {
  n: number
  from: { step: number } | 'observation'
  path: string
  width: number
  height: number
  attached: boolean
}

const SHOT_LINE = /^screenshot ([1-9]\d*) \((observation|step ([1-9]\d*))\): (.+) \(([1-9]\d*)×([1-9]\d*)\)( \(not attached\))?$/

/** One `formatShotLine` line back to its parts; null for any other line. */
export function parseShotLine(line: string): ShotLine | null {
  const m = SHOT_LINE.exec(line)
  if (!m) return null
  return {
    n: Number(m[1]),
    from: m[3] === undefined ? 'observation' : { step: Number(m[3]) },
    path: m[4],
    width: Number(m[5]),
    height: Number(m[6]),
    attached: m[7] === undefined
  }
}

export interface StepLine {
  action: ComputerActionName
  /** what the step acted on, as its line wrote it (`[14] button "Save"`, `down 3 on [5]`); empty for a step with none */
  target: string
  /** the element the line names with its role (a bare `[14]` the service had no line for is left out); a `named` target's name when the element's own is not on the line */
  element?: { index: number; role: string; name: string | null }
  /** the name a `named` step looked for, when it resolved (§27.9) */
  named?: string
  /** a `menu` step's path, by segment (§27.10) */
  menu?: string[]
  /** the title of the window the step opened (§27.5) */
  opened?: string
  /** the tier, or for a `type` the way it went in: `ax`, `ax-insert`, `no tier`, `panel`, `menu File › Close`; `front` for `front menu File › Save` */
  tier?: string
  /** the background route a `front` step took, kept apart from its tier: `menu File › Save` */
  route?: string
  effect?: StepEffect
  /** what commits an `uncommitted` step instead */
  hint?: string
  /** the disk part, after `on disk: ` */
  disk?: string
  /** a failed step's reason */
  failed?: string
}

const ROLE_STOP = /^(?:with|to|into|on|in)\b/
const NO_TARGET: readonly ComputerActionName[] = ['screenshot', 'cursor_position', 'left_mouse_down', 'left_mouse_up']

/** Where the head of a step line ends: the first separator outside a quoted name or value. */
function headEnd(line: string): number {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (line.startsWith(STEP_SEPARATOR, i)) return i
  }
  return line.length
}

/** The first `[n] role "name"` in a target, outside quotes, and the `named` target written right before it (`"Team" [52] menu item`). */
function targetElement(target: string): { element: StepLine['element']; named?: string } | undefined {
  let quoted = false
  let quoteStart = -1
  let quoteEnd = -1
  for (let i = 0; i < target.length; i++) {
    const c = target[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') {
        quoted = false
        quoteEnd = i
      }
      continue
    }
    if (c === '"') {
      quoted = true
      quoteStart = i
      continue
    }
    const m = c === '[' ? /^\[([1-9]\d*)\]/.exec(target.slice(i)) : null
    if (!m) continue
    const named = quoteEnd === i - 2 && target[i - 1] === ' ' ? (JSON.parse(target.slice(quoteStart, quoteEnd + 1)) as string) : undefined
    const rest = target.slice(i + m[0].length)
    const role = /^ ([a-z][a-z0-9:-]*(?: [a-z][a-z0-9:-]*)*?)(?= "| with | to |$)/.exec(rest)
    if (!role || ROLE_STOP.test(role[1])) return named === undefined ? undefined : { element: undefined, named }
    const after = rest.slice(role[0].length)
    const name = /^ ("(?:[^"\\]|\\.)*")/.exec(after)
    const element = { index: Number(m[1]), role: role[1], name: name ? (JSON.parse(name[1]) as string) : (named ?? null) }
    return named === undefined ? { element } : { element, named }
  }
  return undefined
}

/** A `menu` step's path in its target: `menu File › Save…`, or `pick menu …` for perform. */
function targetMenu(action: ComputerActionName, target: string): string[] | undefined {
  const prefix = action === 'left_click' ? 'menu ' : action === 'perform' ? 'pick menu ' : null
  return prefix && target.startsWith(prefix) ? target.slice(prefix.length).split(' › ') : undefined
}

const OPENED_TITLE = /^("(?:[^"\\]|\\.)*")$/

/** Where a line's ` · opened window "…"` ending starts, past the head, with the title; null when it has none. */
function openedEnding(line: string, from: number): { at: number; title: string } | null {
  for (let at = line.lastIndexOf(OPENED_ENDING); at >= from; at = line.lastIndexOf(OPENED_ENDING, at - 1)) {
    const m = OPENED_TITLE.exec(line.slice(at + OPENED_ENDING.length))
    if (m) return { at, title: JSON.parse(m[1]) as string }
    if (at === 0) break
  }
  return null
}

const EFFECT_OF: Readonly<Record<string, StepEffect>> = Object.fromEntries(Object.entries(EFFECT_WORDS).map(([k, v]) => [v, k as StepEffect]))

/** One `formatStepLine` line back to its parts; null for any other line (a `Not executed` line, a shot line, the body). */
export function parseStepLine(line: string): StepLine | null {
  const end = headEnd(line)
  const head = line.slice(0, end)
  const space = head.indexOf(' ')
  const action = space < 0 ? head : head.slice(0, space)
  if (!(COMPUTER_ACTION_NAMES as readonly string[]).includes(action)) return null
  const name = action as ComputerActionName
  const target = space < 0 ? '' : head.slice(space + 1)
  // these name nothing (stepTarget), so a `screenshot 1 (observation): …` line is a shot line
  if (target && NO_TARGET.includes(name)) return null
  const out: StepLine = { action: name, target }
  const found = targetElement(target)
  if (found?.element) out.element = found.element
  if (found?.named !== undefined) out.named = found.named
  const menu = targetMenu(name, target)
  if (menu) out.menu = menu
  if (end === line.length) return out
  if (line.startsWith('failed: ', end + STEP_SEPARATOR.length)) return { ...out, failed: line.slice(end + STEP_SEPARATOR.length + 'failed: '.length) }
  const opened = openedEnding(line, end)
  if (opened) out.opened = opened.title
  if (opened?.at === end) return out
  const rest = line.slice(end + STEP_SEPARATOR.length, opened?.at)
  if (NO_INPUT_ACTIONS.includes(name)) return out
  const [how, effectPart, ...extra] = rest.split(STEP_SEPARATOR)
  if (!how || extra.length > 1 || (extra.length === 1 && !extra[0].startsWith(DISK_PREFIX))) return null
  const front = how.startsWith('front ') ? { tier: 'front', route: how.slice('front '.length) } : { tier: how }
  if (effectPart === undefined) return { ...out, ...front }
  const cut = effectPart.indexOf(HINT_SEPARATOR)
  const effectWords = cut < 0 ? effectPart : effectPart.slice(0, cut)
  const effect = EFFECT_OF[effectWords]
  if (!effect || (cut >= 0 && effect !== 'uncommitted')) return null
  return {
    ...out,
    ...front,
    effect,
    ...(cut >= 0 ? { hint: effectPart.slice(cut + HINT_SEPARATOR.length) } : {}),
    ...(extra.length ? { disk: extra[0].slice(DISK_PREFIX.length) } : {})
  }
}
