import { OBSERVATION_TEXT } from '@shared/computer/protocol'
import { cutName, cutValue, formatObservation, hasRoleDefault, sortStates, STRUCTURAL_ROLES, TOGGLE_ROLES, type ElementLine, type LineFrame, type ObservationLine, type StateWord } from '@shared/computer/observation'

/**
 * Chromium's accessibility tree, as DevTools gives it
 * (`Accessibility.getFullAXTree`), read into the observation grammar of
 * docs/computer-protocol.md §4.1: the same roles, names, values, states
 * and indices the Mac's AX reader prints, so the host's tools, its book of
 * the window and the hold's reading of the screen work on it unchanged.
 * See §28 for what differs from the Mac's reader.
 */

export interface AxValue {
  value?: unknown
}
export interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: AxValue
  name?: AxValue
  value?: AxValue
  properties?: { name: string; value: AxValue }[]
  childIds?: string[]
  backendDOMNodeId?: number
}

/** Chromium's roles to the grammar's words; a role not here is a layout role and its children rise. */
const ROLES: Readonly<Record<string, string>> = {
  RootWebArea: 'web area',
  WebArea: 'web area',
  button: 'button',
  link: 'link',
  textbox: 'input',
  searchbox: 'search',
  combobox: 'combo box',
  checkbox: 'checkbox',
  switch: 'switch',
  radio: 'radio',
  tab: 'tab',
  tablist: 'tabs',
  heading: 'heading',
  image: 'image',
  img: 'image',
  list: 'list',
  listbox: 'list',
  option: 'row',
  table: 'table',
  grid: 'table',
  treegrid: 'outline',
  tree: 'outline',
  treeitem: 'row',
  row: 'row',
  cell: 'cell',
  gridcell: 'cell',
  columnheader: 'cell',
  rowheader: 'cell',
  menu: 'menu',
  menubar: 'menu bar',
  menuitem: 'menu item',
  menuitemcheckbox: 'menu item',
  menuitemradio: 'menu item',
  dialog: 'dialog',
  alertdialog: 'dialog',
  StaticText: 'text',
  slider: 'slider',
  spinbutton: 'stepper',
  progressbar: 'progress',
  toolbar: 'toolbar',
  form: 'group',
  group: 'group',
  radiogroup: 'group',
  navigation: 'group',
  main: 'group',
  region: 'group',
  banner: 'group',
  contentinfo: 'group',
  complementary: 'group',
  search: 'group',
  article: 'group',
  section: 'group',
  listitem: 'group',
  DisclosureTriangle: 'disclosure',
  date: 'date',
  DateTime: 'date',
  InputTime: 'date',
  ColorWell: 'color well',
  meter: 'level',
  scrollbar: 'scroll area'
}

/** Elements keep their index while they exist, and a number is never given twice (§4.2): one book per session × app. */
export class IndexBook {
  private next = 1
  private readonly byKey = new Map<string, number>()
  /** the element's DOM node by index, for acting on it */
  readonly nodes = new Map<number, { backend: number | null; key: string }>()

  indexOf(key: string, backend: number | null): number {
    let i = this.byKey.get(key)
    if (i === undefined) {
      i = this.next++
      this.byKey.set(key, i)
    }
    this.nodes.set(i, { backend, key })
    return i
  }
  /** A page that went away: its elements are gone, their numbers never come back. */
  forget(prefix: string): void {
    for (const [key, i] of this.byKey)
      if (key.startsWith(prefix)) {
        this.byKey.delete(key)
        this.nodes.delete(i)
      }
  }
}

const prop = (n: AxNode, name: string): unknown => n.properties?.find((p) => p.name === name)?.value.value
const text = (v: AxValue | undefined): string => (v?.value === undefined || v.value === null ? '' : String(v.value)).trim()

export interface ReadOptions {
  /** the page's key in the book: its target id */
  page: string
  /** the DOM nodes that are password fields (Chromium names their role `textbox`) */
  passwords: ReadonlySet<number>
  /** only this element's subtree (`state.get` with `element`) */
  root?: number
}

/** One kept element and what acting on it needs. */
export interface Kept {
  line: ElementLine
  backend: number | null
  parent: number | null
}

export interface ReadTree {
  kept: Kept[]
  focused: number | null
}

/** The tree in reading order, with what §4.3 keeps; children of a dropped node rise to its parent's depth. */
export function readTree(nodes: readonly AxNode[], book: IndexBook, o: ReadOptions): ReadTree {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const childOf = new Set(nodes.flatMap((n) => n.childIds ?? []))
  const roots = nodes.filter((n) => !childOf.has(n.nodeId))
  const kept: Kept[] = []
  let focused: number | null = null
  const visit = (n: AxNode, depth: number, parent: number | null, parentText: string, rooted: boolean): void => {
    const raw = text(n.role)
    let role = n.ignored ? undefined : ROLES[raw]
    const backend = n.backendDOMNodeId ?? null
    if (role === 'input' && backend !== null && o.passwords.has(backend)) role = 'password'
    if (role === 'input' && prop(n, 'multiline') === true) role = 'text area'
    const name = text(n.name)
    let value = role && !['password', 'checkbox', 'switch', 'radio'].includes(role) ? text(n.value) : ''
    if (value && (STRUCTURAL_ROLES.has(role!) || ['group', 'heading', 'row', 'cell', 'tabs', 'toolbar', 'menu bar'].includes(role!) || value === name)) value = ''
    const states = role ? statesOf(n, role) : []
    const keep =
      !!role &&
      !(role === 'text' && (!name || name === parentText)) &&
      !(role === 'group' && !name && !states.length) &&
      (!!name || !!value || hasRoleDefault(role) || states.length > 0 || STRUCTURAL_ROLES.has(role))
    let here = parent
    let inside = rooted
    let nextDepth = depth
    if (keep) {
      const index = book.indexOf(`${o.page}:${backend ?? n.nodeId}`, backend)
      inside = rooted || index === o.root
      if (inside) {
        const line: ElementLine = {
          depth: Math.min(depth, OBSERVATION_TEXT.maxDepth),
          index,
          role: role!,
          ...(name ? { name: cutName(name) } : {}),
          ...(value ? { value: cutValue(value) } : {}),
          states,
          actions: []
        }
        kept.push({ line, backend, parent })
        if (states.includes('focused')) focused = index
        nextDepth = depth + 1
      }
      here = index
    }
    for (const id of n.childIds ?? []) {
      const c = byId.get(id)
      if (c) visit(c, inside ? nextDepth : depth, here, keep ? name || value : parentText, inside)
    }
  }
  for (const r of roots) visit(r, 0, null, '', o.root === undefined)
  if (o.root !== undefined && kept.length) {
    const top = kept[0]!.line.depth
    for (const k of kept) k.line.depth -= top
  }
  return { kept, focused }
}

/** The address bar's name, as Chrome's own window names it: the hold reads a page's site from it. */
export const ADDRESS_NAME = 'Address and search bar'

/**
 * The browser around the page, as a window of Chrome on the Mac reads: the
 * window, its address bar holding the page's address, and the page under
 * them. A headless Chromium draws no such frame, but the hold judges Return
 * in a mail or chat page by the address bar's site (outward.ts `pageHost`),
 * and the model navigates by typing into it as it would on the Mac.
 */
export function withChrome(tree: ReadTree, book: IndexBook, page: string, title: string, url: string, addressFocused: boolean): ReadTree {
  const window = book.indexOf(`${page}:window`, null)
  const address = book.indexOf(`${page}:address`, null)
  const kept: Kept[] = [
    { line: { depth: 0, index: window, role: 'window', ...(title ? { name: cutName(title) } : {}), states: [], actions: [] }, backend: null, parent: null },
    { line: { depth: 1, index: address, role: 'input', name: ADDRESS_NAME, ...(url ? { value: cutValue(url) } : {}), states: addressFocused ? ['focused'] : [], actions: [] }, backend: null, parent: window },
    ...tree.kept.map((k) => ({ ...k, line: { ...k.line, depth: Math.min(k.line.depth + 1, OBSERVATION_TEXT.maxDepth) }, parent: k.parent ?? window }))
  ]
  if (addressFocused) for (const k of kept.slice(2)) k.line = { ...k.line, states: k.line.states.filter((s) => s !== 'focused') }
  return { kept, focused: addressFocused ? address : tree.focused }
}

function statesOf(n: AxNode, role: string): StateWord[] {
  const s: StateWord[] = []
  if (prop(n, 'focused') === true) s.push('focused')
  if (prop(n, 'selected') === true) s.push('selected')
  if (prop(n, 'disabled') === true) s.push('disabled')
  if (TOGGLE_ROLES.has(role)) {
    const c = prop(n, 'checked')
    s.push(c === 'mixed' ? 'mixed' : c === true || c === 'true' ? 'checked' : 'unchecked')
  }
  const e = prop(n, 'expanded')
  if (e === true) s.push('expanded')
  else if (e === false && ['row', 'cell', 'disclosure'].includes(role)) s.push('collapsed')
  if (prop(n, 'required') === true) s.push('required')
  const inv = prop(n, 'invalid')
  if (inv !== undefined && inv !== 'false' && inv !== false) s.push('invalid')
  if (prop(n, 'modal') === true) s.push('modal')
  if (prop(n, 'readonly') === true && ['input', 'search', 'text area', 'combo box', 'date'].includes(role)) s.push('read-only')
  return sortStates(s)
}

export interface Header {
  app: string
  window: string
  width: number
  height: number
  loading: boolean
  others: string[]
}

/** Too poor to act from (§4.5): fewer than three elements with a role-default action and under 200 bytes of names and values. */
export function thinTree(tree: ReadTree): boolean {
  const actionable = tree.kept.filter((k) => !['window', 'web area'].includes(k.line.role) && hasRoleDefault(k.line.role)).length
  const bytes = tree.kept.reduce((n, k) => n + Buffer.byteLength((k.line.name ?? '') + (k.line.value ?? '')), 0)
  return actionable < OBSERVATION_TEXT.thinActionable && bytes < 200
}

/**
 * The observation's text: the header, the lines, and the `(truncated …)`
 * line when the budget cut. Lines with frames carry them. Past the budget
 * the walk's tail goes first (a page's footer before its form).
 */
export function observationText(h: Header, tree: ReadTree, frames: ReadonlyMap<number, LineFrame> | null, budget: number = 24_000): { text: string; omitted: number; lines: number; thin: boolean } {
  const lines: ObservationLine[] = tree.kept.map((k) => ({ type: 'element' as const, ...k.line, ...(frames?.get(k.line.index) ? { frame: frames.get(k.line.index)! } : {}) }))
  const thin = thinTree(tree)
  const base = {
    header: { app: h.app, window: h.window, width: h.width, height: h.height, loading: h.loading, change: null, thin, ...(tree.focused !== null ? { focused: tree.focused } : {}) },
    others: h.others.map((title) => ({ title }))
  }
  let text = formatObservation({ ...base, lines })
  let omitted = 0
  if (Buffer.byteLength(text) > budget && lines.length > 1) {
    const root = tree.kept[0]!.line.index
    // the focused element's line is never the one cut
    let keep = lines.length
    while (keep > 1) {
      keep = Math.max(1, Math.floor(keep * 0.9))
      const cut = lines.slice(0, keep)
      if (tree.focused !== null && !cut.some((l) => l.type === 'element' && l.index === tree.focused)) {
        const f = lines.find((l) => l.type === 'element' && l.index === tree.focused)
        if (f) cut.push({ ...f, depth: Math.min((f as ElementLine).depth, (cut[cut.length - 1] as ElementLine).depth + 1) } as ObservationLine)
      }
      omitted = lines.length - cut.length
      text = formatObservation({ ...base, lines: [...cut, { type: 'truncated', omitted, element: root }] })
      if (Buffer.byteLength(text) <= budget) {
        lines.splice(0, lines.length, ...cut)
        break
      }
    }
  }
  return { text, omitted, lines: text.split('\n').length, thin }
}
