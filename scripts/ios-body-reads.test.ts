import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/* No write to observed state in a body (plan TE_fWkYrofJc §5, docs/IOS-DESIGN.md "Speed on the phone"). SwiftUI
 * runs a body to learn what it reads; a body that writes what it reads asks to run again, and a loop shows only as a
 * hot phone. So a Work view's body (and a modifier's `body(content:)`) may reach a model only through the reads
 * listed in PURE_READS below, and writes nothing but its own locals. Each listed read is checked in its source: it
 * assigns nothing, or only the fields it names as bookkeeping, and each of those is declared `@ObservationIgnored`.
 *
 * What runs on an event is not the body: the closures of `.task`, `.onChange`, `Task`, a Button's action, and every
 * closure passed under a label that is not a view's (`retry:`, `onPage:`, `read:`), are taken out before the scan.
 * A view of ours whose unlabeled trailing closure is an action is named in ACTION_CALLEES. */
const repo = resolve(__dirname, '..')
const WORK = resolve(repo, 'ios/TempCode/Sources/Work')
const CLIENT = 'ios/TempCodeClient/Sources/TempCodeClient'

/** The roots a body reaches a model through: a client, the registry, a host's parts, a screen's store, a singleton. */
const MODEL_ROOTS = new Set(['client', 'model', 'registry', 'work', 'files', 'store', 'feed', 'presses', 'navigator', 'selecting', 'refused', 'host', 'desk', 'desks', 'canvas', 'life', 'reads', 'session'])
/** Calls on a value a read handed back: a collection's or a string's, never a model's. */
const VALUE_CALLS = new Set(['map', 'compactMap', 'flatMap', 'filter', 'first', 'last', 'contains', 'allSatisfy', 'enumerated', 'joined', 'max', 'min', 'sorted', 'prefix', 'suffix', 'reduce', 'firstIndex', 'lastIndex', 'trimmingCharacters', 'formatted', 'hasPrefix', 'hasSuffix', 'components', 'split', 'lowercased', 'uppercased', 'capitalized', 'dropFirst', 'dropLast', 'isMultiple', 'replacingOccurrences', 'localizedCaseInsensitiveContains', 'count', 'index', 'starts', 'union', 'intersection', 'subtracting', 'isSubset'])

interface PureRead {
  /** The call as a body writes it, its root's handle and the member: `client.work.may`. */
  call: string
  /** Where the member is declared, and its name there; no name for a closure the type holds (its bookkeeping names it). */
  file: string
  func: string
  /** Fields the read writes for its own bookkeeping (a slot made at the first ask), each `@ObservationIgnored` in `holder`. */
  bookkeeps?: { field: string; holder: string }[]
}

/** The reads a body may make, each checked below in its source. */
export const PURE_READS: PureRead[] = [
  { call: 'client.work.may', file: `${CLIENT}/Work/Shell/WorkHost.swift`, func: 'may' },
  { call: 'work.may', file: `${CLIENT}/Work/Shell/WorkHost.swift`, func: 'may' },
  { call: 'client.work.canvas.preview', file: `${CLIENT}/Work/Reader/WorkCanvas+Preview.swift`, func: 'preview' },
  { call: 'client.work.presses.busy', file: `${CLIENT}/Work/Outbox/PressLedger.swift`, func: 'busy' },
  { call: 'model.registry.client', file: `${CLIENT}/Client/ClientRegistry.swift`, func: 'client' },
  {
    call: 'client.session',
    file: `${CLIENT}/Client/EnvironmentClient.swift`,
    func: 'session',
    // A slot per id, made at the first ask, in the store the client holds outside observation.
    bookkeeps: [{ field: 'store', holder: `${CLIENT}/Client/EnvironmentClient.swift` }]
  },
  { call: 'files.listing', file: `${CLIENT}/Work/Files/FilesHost.swift`, func: 'listing' },
  { call: 'presses.hides', file: 'ios/TempCode/Sources/Work/OutboxPresses.swift', func: 'hides' },
  { call: 'ReaderCache.shared.latest', file: `${CLIENT}/Work/Reader/ReaderCache.swift`, func: 'latest' },
  { call: 'refused.of', file: 'ios/TempCode/Sources/Work/ShareRefused.swift', func: 'of' },
  { call: 'host.work.may', file: `${CLIENT}/Work/Shell/WorkHost.swift`, func: 'may' },
  { call: 'work.presses.busy', file: `${CLIENT}/Work/Outbox/PressLedger.swift`, func: 'busy' },
  { call: 'client.work.presses.state', file: `${CLIENT}/Work/Outbox/PressLedger.swift`, func: 'state' },
  { call: 'host.work.rekeyLine', file: `${CLIENT}/Work/Guests/WorkHost+Guests.swift`, func: 'rekeyLine' },
  { call: 'host.work.mayReplace', file: `${CLIENT}/Work/Guests/WorkHost+Guests.swift`, func: 'mayReplace' },
  { call: 'work.rekeyLine', file: `${CLIENT}/Work/Guests/WorkHost+Guests.swift`, func: 'rekeyLine' },
  { call: 'work.mayReplace', file: `${CLIENT}/Work/Guests/WorkHost+Guests.swift`, func: 'mayReplace' },
  { call: 'files.loadingMore', file: `${CLIENT}/Work/Files/FilesHost.swift`, func: 'loadingMore' },
  { call: 'desks.desk', file: `${CLIENT}/Work/Messages/ReplyDesk.swift`, func: 'desk' },
  { call: 'MailPresses.shared.counting', file: 'ios/TempCode/Sources/Work/Life/MailPresses.swift', func: 'counting' },
  { call: 'MessagesPresses.shared.counting', file: 'ios/TempCode/Sources/Work/Messages/MessagesPresses.swift', func: 'counting' },
  { call: 'OutboxPresses.shared.hides', file: 'ios/TempCode/Sources/Work/OutboxPresses.swift', func: 'hides' },
  { call: 'OutboxPresses.shared.reason', file: 'ios/TempCode/Sources/Work/OutboxPresses.swift', func: 'reason' },
  { call: 'selecting.selection.allTicked', file: `${CLIENT}/Work/Outbox/OutboxGroup.swift`, func: 'allTicked' },
  { call: 'client.workPlace', file: 'ios/TempCode/Sources/Work/WorkStyles.swift', func: 'workPlace' },
  { call: 'store.isFresh', file: `${CLIENT}/Work/Today/TodayReads.swift`, func: 'isFresh' },
  // Review's clock, a closure the store holds outside observation (a test sets it): it reads the time and writes nothing.
  { call: 'store.now', file: `${CLIENT}/Work/Review/ReviewStore.swift`, func: '', bookkeeps: [{ field: 'now', holder: `${CLIENT}/Work/Review/ReviewStore.swift` }] }
]

/** Views of ours whose unlabeled trailing closure is an action, run on a press. */
export const ACTION_CALLEES = new Set(['AddToThreadSheet', 'TemplateFillView', 'FilesFailed', 'FilesGrid', 'UploadRow', 'mark', 'ItemLoad', 'PlacePick', 'ChatRowView', 'PlayRunSheet', 'PersonRow', 'LineRow', 'UndoCapsule', 'ChatCopyButton'])

/** Labels whose closure is part of the view: anything else passed under a label is a callback. */
const VIEW_LABELS = new Set(['label', 'content', 'header', 'footer', 'icon', 'title', 'message', 'actions', 'placeholder', 'detail', 'sidebar', 'get', 'leading', 'trailing', 'background', 'overlay', 'preview', 'currentValueLabel', 'minimumValueLabel', 'maximumValueLabel', 'description'])

const EFFECT =
  /(?:\bTask(?:\.detached)?|\.task|\.onAppear|\.onDisappear|\.onChange|\.onReceive|\.onSubmit|\.refreshable|\.onTapGesture|\.onLongPressGesture|\bwithAnimation|\.onScrollPhaseChange|\.onGeometryChange|\.dropDestination|\.onDrop|\.onOpenURL|\.onKeyPress|\.onPreferenceChange|\.onEnded|\.onChanged|\.fileImporter|\.onContinuousHover|\.onHover|\.onMoveCommand|\.onDelete|\.onMove)\s*(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?\s*(?:action:\s*)?\{/g

/** Comments and string contents go: they paint nothing and hold braces of their own. */
export function strip(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
}

/** The index just past the brace that closes the one at `open`. */
function closing(text: string, open: number): number {
  let depth = 1
  let i = open + 1
  for (; i < text.length && depth; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
  }
  return i
}

/** Every body and every helper that makes a view (`var x: some View`, `func x(…) -> some View`), inside its braces. */
export function bodies(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/var body: some View \{|func body\(content: Content\) -> some View \{|(?:var \w+|func \w+\([^)]*\)): some View \{|func \w+\((?:[^()]|\([^()]*\))*\) -> some View \{/g)) {
    const open = m.index! + m[0].length - 1
    out.push(code.slice(open + 1, closing(code, open) - 1))
  }
  return out
}

/** Takes one closure out of `text` at the first match of `re`, the closure's brace at the match's last character. */
function cutFirst(text: string, re: RegExp, keep: (m: RegExpExecArray) => boolean = () => false): { text: string; cut: boolean } {
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (keep(m)) continue
    const open = m.index + m[0].length - 1
    return { text: text.slice(0, m.index) + ' ' + text.slice(closing(text, open)), cut: true }
  }
  return { text, cut: false }
}

/** A body less what runs on an event. */
export function evaluated(body: string): string {
  let text = body
  const cutAll = (re: RegExp, keep?: (m: RegExpExecArray) => boolean) => {
    for (let step = cutFirst(text, re, keep); step.cut; step = cutFirst(text, re, keep)) text = step.text
  }
  cutAll(EFFECT)
  // A Button's first trailing closure is its action unless an `action:` argument came first; `Button { } label: { }` too.
  cutAll(/\b(?:Button|PillButton)\s*(\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?\s*\{/g, (m) => Boolean(m[1] && /\baction:/.test(m[1])))
  // A labeled closure that is not a view's: `retry: { … }`, `set: { … }`, `onPage: { … }`.
  cutAll(/\b([a-zA-Z_]\w*):\s*\{/g, (m) => VIEW_LABELS.has(m[1]))
  // A closure handed over as a value, never a trailing one: `("Review", { … })`, `may ? { … } : nil`.
  cutAll(/(?:[(,?]|\bin)\s*\{/g)
  cutAll(new RegExp(`\\b(?:${[...ACTION_CALLEES].join('|')})\\s*(?:\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\))?\\s*\\{`, 'g'))
  return text
}

export interface Problem {
  file: string
  what: string
}

const ALLOWED = new Set(PURE_READS.map((read) => read.call))

/** Every call on a model a body makes that is not a listed read, and every write a body makes past its own locals. */
export function bodyProblems(file: string, source: string): Problem[] {
  const problems: Problem[] = []
  for (const raw of bodies(strip(source))) {
    const body = evaluated(raw)
    const locals = new Set([...body.matchAll(/\b(?:var|let)\s+([a-zA-Z_]\w*)/g)].map((m) => m[1]))
    // A chain from a model's root, or a singleton's: `client.work.may(`, `OutboxPresses.shared.hides(`.
    for (const m of body.matchAll(/(?<![\w.)\]?])(?:self\.)?([a-z_]\w*(?:\.[a-zA-Z_]\w*)*|[A-Z]\w*\.(?:shared|store)(?:\.[a-zA-Z_]\w*)*)\.([a-z]\w*)\(/g)) {
      const chain = m[1]
      const root = chain.split('.')[0]
      const model = MODEL_ROOTS.has(root) || /^[A-Z]\w*\.(?:shared|store)\b/.test(chain)
      if (!model || locals.has(root)) continue
      const call = `${chain}.${m[2]}`
      if (ALLOWED.has(call) || VALUE_CALLS.has(m[2])) continue
      problems.push({ file, what: `calls ${call}( in its body, which is not a listed pure read` })
    }
    // A write in a body: a result builder takes no bare assignment, so it hides in `let _ = …`. Past the body's locals.
    const discarded = [...body.matchAll(/\blet _ =([^\n]*)/g)].map((m) => m[1]).join('\n')
    for (const m of discarded.matchAll(/(?<![\w.])(?:self\.)?([a-zA-Z_]\w*)((?:\.[a-zA-Z_]\w*|\[[^\]\n]*\])*)\s*(=|\+=|-=|\*=|\/=)(?!=)/g)) {
      const name = m[1]
      if (locals.has(name) || name === '_' || /^(?:let|var|case|guard|if|while|in)$/.test(name)) continue
      // A `let x = …` binding's own `=` follows the name itself, matched as a declaration above.
      problems.push({ file, what: `writes ${name}${m[2]} in its body` })
    }
  }
  return problems
}

/** A function's body by name in a Swift source, braces inside. */
export function funcBody(code: string, name: string): string | null {
  const m = new RegExp(`func ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[(<]`).exec(code)
  if (!m) return null
  const open = code.indexOf('{', m.index)
  return code.slice(open + 1, closing(code, open) - 1)
}

/** What a read assigns past its locals, its own closures (a source it hands back) left out. */
export function readWrites(body: string): string[] {
  let text = body
  for (let step = cutFirst(text, /\b[a-zA-Z_]\w*:\s*\{/g); step.cut; step = cutFirst(text, /\b[a-zA-Z_]\w*:\s*\{/g)) text = step.text
  const locals = new Set([...text.matchAll(/\b(?:var|let)\s+([a-zA-Z_]\w*)/g)].map((m) => m[1]))
  const writes: string[] = []
  for (const m of text.matchAll(/(?<![\w.])(?:self\.)?([a-zA-Z_]\w*)(?:\.[a-zA-Z_]\w*|\[[^\]\n]*\])*\s*(?:=|\+=|-=)(?!=)/g)) {
    const before = text.slice(Math.max(0, m.index! - 8), m.index!)
    if (!locals.has(m[1]) && !/\b(?:let|var)\s+$/.test(before)) writes.push(m[1])
  }
  for (const m of text.matchAll(/(?<![\w.])(?:self\.)?([a-zA-Z_]\w*)(?:\.[a-zA-Z_]\w*)*\.(?:append|insert|remove\w*|removeAll|merge|formUnion|toggle)\(/g)) {
    if (!locals.has(m[1])) writes.push(m[1])
  }
  // A call into a member that makes or caches is the read's own business only once it is named and ignored.
  for (const m of text.matchAll(/(?<![\w.])(?:self\.)?([a-z_]\w*)\.slot\(/g)) writes.push(m[1])
  return [...new Set(writes)]
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (name.endsWith('.swift')) out.push(path)
  }
  return out
}

describe("a Work view's body", () => {
  it('reaches a model only through the listed pure reads, and writes nothing but its locals', () => {
    const problems = walk(WORK).flatMap((path) => bodyProblems(relative(repo, path), readFileSync(path, 'utf8')))
    expect(problems.map((p) => `${p.file}: ${p.what}`)).toEqual([])
  })

  it('lists only reads that are pure, or whose bookkeeping is kept outside observation', () => {
    const problems: string[] = []
    for (const read of PURE_READS) {
      const body = read.func ? funcBody(strip(readFileSync(resolve(repo, read.file), 'utf8')), read.func) : ''
      if (body === null) {
        problems.push(`${read.call}: no func ${read.func} in ${read.file}`)
        continue
      }
      const kept = new Set((read.bookkeeps ?? []).map((b) => b.field))
      for (const field of readWrites(body)) if (!kept.has(field)) problems.push(`${read.call}: writes ${field}`)
      for (const keep of read.bookkeeps ?? []) {
        const holder = strip(readFileSync(resolve(repo, keep.holder), 'utf8'))
        if (!new RegExp(`@ObservationIgnored[^\\n]*\\b(?:let|var)\\s+${keep.field}\\b`).test(holder)) problems.push(`${read.call}: ${keep.field} is not @ObservationIgnored in ${keep.holder}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('finds the shapes it exists for', () => {
    const view = (body: string) => `struct V: View {\n    var body: some View {\n${body}\n    }\n}`
    expect(bodyProblems('v', view('let rows = files.listing(id, at)\nText("")'))).toEqual([])
    expect(bodyProblems('v', view('let rows = files.loadMore(id)\nText("")')).map((p) => p.what)).toEqual(['calls files.loadMore( in its body, which is not a listed pure read'])
    expect(bodyProblems('v', view('let _ = store.refresh()\nText("")'))).toHaveLength(1)
    expect(bodyProblems('v', view('Text("").task { await store.refresh() }.onChange(of: x) { store.mark(x) }'))).toEqual([])
    expect(bodyProblems('v', view('Button("Go") { store.go() }\nPillButton("Try Again", retry: { await store.load() }) {}'))).toEqual([])
    expect(bodyProblems('v', view('Button(action: { store.go() }) { Text(store.title(x)) }')).map((p) => p.what)).toEqual(['calls store.title( in its body, which is not a listed pure read'])
    expect(bodyProblems('v', view('let c = model.registry.client(id)\nText(c?.name ?? "")'))).toEqual([])
    expect(bodyProblems('v', view('let n = client.workspaces.first { $0.kind == .work }\nText("")'))).toEqual([])
    expect(bodyProblems('v', view('var shown = section\nshown.entries = []\nText("")'))).toEqual([])
    expect(bodyProblems('v', view('let _ = (seen = ids)\nText("")')).map((p) => p.what)).toEqual(['writes seen in its body'])
    expect(bodyProblems('v', view('QuietNote(text: "", action: ("Review", { navigator.open(r) }))'))).toEqual([])
    expect(bodyProblems('v', view('let _ = navigator.tops[route] = top'))).toHaveLength(1)
    expect(readWrites('slots[id] = made\nreturn made')).toEqual(['slots'])
    expect(readWrites('let x = 1\nreturn PagePreviewSource(open: { self.can.mark(m) })')).toEqual([])
  })
})
