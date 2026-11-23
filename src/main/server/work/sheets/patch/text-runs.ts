// A string's runs as the file holds them (CT_Rst: a shared string item, an inline string, a note's text):
// read into a small model, compared, and written back in the order Excel writes a run's properties.
import { resolveColor } from 'work-kit/sheet/xlsx'
import { children, openTag, type ElementSpan } from './format-xml'
import { inner, local, tagAttrs, xunescape } from './rules-xml'
import { escText, parseAttrs } from './xml'

export class TextRefused extends Error {
  override name = 'TextRefused'
}

/** `#RRGGBB`, or one of the workbook theme's colours with Excel's tint (-1 to 1). */
export type RunColour = string | { theme: number; tint?: number }

/**
 * A run's font, whole, as work-kit's `runsOf` gives it: bold, italic, underline, strike and `vertical` are
 * off where they are left out; a face or a size left out is the cell's; a colour left out is the
 * workbook's own text colour.
 */
export interface RunFont {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  colour?: RunColour
  face?: string
  /** points */
  size?: number
  vertical?: 'super' | 'sub'
}

/** A run of a cell's text. No `font`: the run is in the cell's own font. */
export interface Run {
  text: string
  font?: RunFont
}

export const MAX_CHARS = 32_767
export const MAX_RUNS = 1_024
export const MAX_CELLS = 20_000

/** A run's property elements by local name (a font's `name` is a run's `rFont`), each with its attributes. */
export type Props = Map<string, Record<string, string>>
/** A run as it is in the file. `props` null: the run has no `rPr` and takes the cell's font. */
export interface FileRun {
  text: string
  props: Props | null
}

// The order Excel writes them in (CT_RPrElt is a choice, so any order is valid).
const ORDER = [
  'b',
  'i',
  'strike',
  'condense',
  'extend',
  'outline',
  'shadow',
  'u',
  'vertAlign',
  'sz',
  'color',
  'rFont',
  'family',
  'charset',
  'scheme'
]
const FLAGS = new Set(ORDER.slice(0, 7))
const isOff = (attrs: Record<string, string>) => attrs.val === '0' || attrs.val === 'false'
/** Whether a property says nothing a complete font would not say by leaving it out. */
const idle = (name: string, attrs: Record<string, string>) =>
  FLAGS.has(name)
    ? isOff(attrs)
    : (name === 'u' && attrs.val === 'none') || (name === 'vertAlign' && attrs.val === 'baseline')

/** One spelling for each value, so two runs that say the same compare equal. */
function normal(name: string, attrs: Record<string, string>): Record<string, string> {
  if (FLAGS.has(name)) return isOff(attrs) ? { val: '0' } : {}
  if (name === 'u')
    return attrs.val === undefined || attrs.val === 'single' ? {} : { val: attrs.val }
  if (name === 'sz') return { val: String(Number(attrs.val)) }
  if (name !== 'color') return attrs
  const out = { ...attrs }
  if (out.rgb !== undefined)
    out.rgb = (out.rgb.length === 6 ? 'FF' + out.rgb : out.rgb).toUpperCase()
  if (out.tint !== undefined) out.tint = String(Number(out.tint))
  return out
}

/** The properties of a run's `rPr`, or of a `font` in the styles part. `unknown` hears of a child this model does not hold. */
export function readProps(xml: string, el: ElementSpan, unknown?: () => void): Props {
  const props: Props = new Map()
  for (const child of children(xml, el)) {
    const name = local(child.name) === 'name' ? 'rFont' : local(child.name)
    if (!ORDER.includes(name) || props.has(name)) {
      unknown?.()
      continue
    }
    const attrs: Record<string, string> = {}
    for (const a of parseAttrs(openTag(xml, child).slice(child.name.length + 1)))
      if (!a.name.startsWith('xmlns')) attrs[a.name] = xunescape(a.value)
    props.set(name, normal(name, attrs))
  }
  return props
}

/** An element's text: entities, Excel's `_xHHHH_` escapes and CDATA sections decoded. */
export function textOf(xml: string, el: ElementSpan): string {
  const raw = inner(xml, el)
  if (!raw.includes('<')) return xunescape(raw)
  let text = ''
  let from = 0
  for (const m of raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g)) {
    text += xunescape(raw.slice(from, m.index)) + (m[1] ?? '')
    from = m.index + m[0].length
  }
  return text + xunescape(raw.slice(from))
}

/**
 * The runs of a string item. `pure` is false where it holds what this model does not (a phonetic run, a
 * property Excel knows and we do not): such an item is never taken for another cell's text.
 */
export function readItem(xml: string, item: ElementSpan): { runs: FileRun[]; pure: boolean } {
  const runs: FileRun[] = []
  let pure = true
  const impure = () => {
    pure = false
  }
  for (const el of children(xml, item)) {
    const name = local(el.name)
    if (name === 't') runs.push({ text: textOf(xml, el), props: null })
    else if (name === 'r') {
      let text = ''
      let props: Props | null = null
      for (const child of children(xml, el)) {
        if (local(child.name) === 't') text += textOf(xml, child)
        else if (local(child.name) === 'rPr') props = readProps(xml, child, impure)
      }
      runs.push({ text, props: props?.size ? props : null })
    } else impure()
  }
  return { runs, pure }
}

export const flat = (runs: readonly { text: string }[]) => runs.map((run) => run.text).join('')
export const rich = (runs: readonly FileRun[]) => runs.some((run) => run.props && run.text)

// A face's family and character set are hints about the face: two runs that differ only there look the same.
const HINTS = new Set(['family', 'charset'])
const entries = (props: Props, resolved: boolean) =>
  ORDER.filter(
    (name) => props.has(name) && !(resolved && (HINTS.has(name) || idle(name, props.get(name)!)))
  ).map((name) => [name, Object.entries(props.get(name)!).sort(([a], [b]) => a.localeCompare(b))])

/** The item as written: two items with one key are the same string in any cell. */
export const literalKey = (runs: readonly FileRun[]) =>
  JSON.stringify(runs.map((run) => [run.text, run.props && entries(run.props, false)]))

/**
 * The item as one cell shows it: a run with no properties takes the cell's font (`base`), an empty run is
 * nothing and two neighbours that look the same are one run.
 */
export function shownKey(runs: readonly FileRun[], base: Props | undefined): string {
  const out: [string, string][] = []
  for (const run of runs) {
    if (!run.text) continue
    const props = run.props ?? base
    const look = props ? JSON.stringify(entries(props, true)) : ''
    const last = out.at(-1)
    if (last && last[1] === look) last[0] += run.text
    else out.push([run.text, look])
  }
  return JSON.stringify(out)
}

function colourAttrs(colour: RunColour): Record<string, string> {
  if (typeof colour === 'string') {
    if (!/^#[0-9a-f]{6}$/i.test(colour))
      throw new TextRefused(
        `“${String(colour).slice(0, 40)}” is not a colour this editor can save.`
      )
    return { rgb: 'FF' + colour.slice(1).toUpperCase() }
  }
  const { theme, tint } = colour ?? {}
  if (!Number.isInteger(theme) || theme < 0 || theme > 255)
    throw new TextRefused('That theme colour is not one this editor can save.')
  if (tint === undefined || tint === 0) return { theme: String(theme) }
  if (typeof tint !== 'number' || !(tint >= -1 && tint <= 1))
    throw new TextRefused('A colour’s tint is between -1 and 1.')
  return { theme: String(theme), tint: String(tint) }
}

/**
 * A run's properties for the file: the whole font, so the run looks the same whether or not the program
 * that opens the file reads a missing property as the cell's. The face (with what describes it) and the
 * size come from the cell's font (`base`) where the run names none, and `ink` is the workbook's own text
 * colour. What the cell's font has on and the run has off is said as off. A run that ends up as the
 * cell's own font has no properties at all.
 */
export function runProps(
  font: RunFont | undefined,
  base: Props | undefined,
  ink?: Record<string, string>
): Props | null {
  if (font === undefined || font === null) return null
  if (typeof font !== 'object') throw new TextRefused('A run’s font is a list of its properties.')
  const props: Props = new Map()
  const flag = (name: string, value: boolean | undefined, off: string) => {
    if (value !== undefined && typeof value !== 'boolean')
      throw new TextRefused('Bold, italic, underline and strike are on or off.')
    const had = base?.get(name)
    const was = !!had && !idle(name, had)
    // An underline already there keeps its kind (a double one stays double).
    if (value) props.set(name, name === 'u' && was ? had! : {})
    else if (was) props.set(name, { val: off })
  }
  flag('b', font.bold, '0')
  flag('i', font.italic, '0')
  flag('strike', font.strike, '0')
  flag('u', font.underline, 'none')
  if (font.vertical !== undefined && font.vertical !== 'super' && font.vertical !== 'sub')
    throw new TextRefused('Text is raised as a superscript or lowered as a subscript.')
  if (font.vertical)
    props.set('vertAlign', { val: font.vertical === 'super' ? 'superscript' : 'subscript' })
  else if (base?.has('vertAlign') && !idle('vertAlign', base.get('vertAlign')!))
    props.set('vertAlign', { val: 'baseline' })
  if (font.size !== undefined) {
    if (typeof font.size !== 'number' || !(font.size >= 1 && font.size <= 409))
      throw new TextRefused('A font size is between 1 and 409 points.')
    props.set('sz', { val: String(font.size) })
  } else if (base?.has('sz')) props.set('sz', base.get('sz')!)
  const colour = font.colour === undefined ? ink : colourAttrs(font.colour)
  if (colour) props.set('color', colour)
  const face = base?.get('rFont')
  if (font.face !== undefined) {
    if (
      typeof font.face !== 'string' ||
      !font.face.trim() ||
      font.face.length > 31 ||
      /[\u0000-\u001f]/.test(font.face)
    )
      throw new TextRefused('A font name has 1 to 31 characters.')
    props.set('rFont', { val: font.face })
  } else if (face) props.set('rFont', face)
  // These three describe the face they came with.
  if (face && props.get('rFont')?.val === face.val)
    for (const name of ['family', 'charset', 'scheme'])
      if (base!.has(name)) props.set(name, base!.get(name)!)
  const same =
    JSON.stringify(entries(props, true)) === JSON.stringify(base ? entries(base, true) : [])
  return same ? null : props
}

/**
 * Text as a string item carries it: line ends as one line feed, and the characters XML 1.0 refuses
 * (and half of a surrogate pair) dropped.
 */
export const clean = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')

/** A caller's runs checked and cleaned; a run left with no text is dropped. Null: no text is left to style. */
export function checkedRuns(runs: unknown, cell: string): Run[] | null {
  if (!Array.isArray(runs)) throw new TextRefused(`Give the text of ${cell} as a list of runs.`)
  if (runs.length > MAX_RUNS)
    throw new TextRefused(
      `The text of ${cell} changes style more than 1,024 times. A cell takes at most 1,024.`
    )
  const out: Run[] = []
  let length = 0
  for (const run of runs as Partial<Run>[]) {
    if (!run || typeof run !== 'object' || typeof run.text !== 'string')
      throw new TextRefused(`Give the text of ${cell} as a list of runs.`)
    // Checked before it is cleaned, so a huge string is never copied.
    if ((length += run.text.length) > MAX_CHARS * 2)
      throw new TextRefused(
        `${cell} would hold more than 32,767 characters, the most a cell takes.`
      )
    const text = clean(run.text)
    if (text) out.push(run.font === undefined ? { text } : { text, font: run.font })
  }
  if (flat(out).length > MAX_CHARS)
    throw new TextRefused(`${cell} would hold more than 32,767 characters, the most a cell takes.`)
  return out.length ? out : null
}

/** `<t>` with the text escaped; white space at an end is kept by `xml:space`. */
export const textTag = (prefix: string, text: string) =>
  `<${prefix}t${/^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : ''}>${escText(text)}</${prefix}t>`

/** The inside of a string item: one plain run is a bare `<t>`, as Excel writes plain text. */
export function renderItem(runs: readonly FileRun[], prefix: string): string {
  if (runs.length === 1 && !runs[0].props) return textTag(prefix, runs[0].text)
  return runs
    .map(({ text, props }) => {
      const rPr = props
        ? `<${prefix}rPr>` +
          ORDER.filter((name) => props.has(name))
            .map((name) => `<${prefix}${name}${tagAttrs(props.get(name)!)}/>`)
            .join('') +
          `</${prefix}rPr>`
        : ''
      return `<${prefix}r>${rPr}${textTag(prefix, text)}</${prefix}r>`
    })
    .join('')
}

/** The run as the caller's model says it, for a reader. An indexed colour is given as its hex. */
export function fontOf(props: Props | null): RunFont | undefined {
  if (!props) return undefined
  const font: RunFont = {}
  const flag = (name: string) => (props.has(name) ? !idle(name, props.get(name)!) : undefined)
  const set = <K extends keyof RunFont>(key: K, value: RunFont[K] | undefined) => {
    if (value !== undefined) font[key] = value
  }
  set('bold', flag('b'))
  set('italic', flag('i'))
  set('underline', flag('u'))
  set('strike', flag('strike'))
  const color = props.get('color')
  if (color?.rgb) set('colour', '#' + color.rgb.slice(-6))
  else if (color?.theme !== undefined) {
    const tint = Number(color.tint ?? 0) || 0
    set('colour', tint ? { theme: Number(color.theme), tint } : { theme: Number(color.theme) })
  } else if (color) set('colour', resolveColor(color, []))
  set('face', props.get('rFont')?.val)
  const size = Number(props.get('sz')?.val)
  if (Number.isFinite(size) && size > 0) set('size', size)
  const vertical = props.get('vertAlign')?.val
  if (vertical === 'superscript') set('vertical', 'super')
  if (vertical === 'subscript') set('vertical', 'sub')
  return Object.keys(font).length ? font : undefined
}

export const toRuns = (runs: readonly FileRun[]): Run[] =>
  runs
    .filter((run) => run.text)
    .map(({ text, props }) => {
      const font = fontOf(props)
      return font ? { text, font } : { text }
    })
