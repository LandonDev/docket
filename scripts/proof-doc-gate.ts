import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import { DOCUMENT_FRAGMENT, schemaOf } from 'work-kit/collab'
import { DEFAULT_STYLES, defaultSetup } from 'work-kit/editor/page'
import { TEMPCODE_THEME } from 'work-kit/format/theme'
import { emptySidecar, type Block, type Inline } from 'work-kit/formats'
import { writeDocx } from 'work-kit/formats/docx'
import type { ImportAnswer } from '../src/shared/contract-work-formats'
import { freePort, REPO, Run, sleep, textOf } from './e2e-work-lib'

/**
 * READ FIRST: this was written and run against the gate as it stood before master 1835e189e. Since
 * that commit a host refuses a window that says no schema on EVERY document (work-docs.md "A window
 * that says no schema is let onto nothing"), so steps 2 and 4 below, which expect an old window to
 * be let onto a classic document, now describe what must NOT happen. Before it is run against
 * master, turn them: an old window (v1.0.361 or v1.0.362) is refused the classic document too,
 * writes nothing, and a v1.0.362 window shows "Update TempCode to open this document." What this
 * script found as written, with its frames and pictures: .temp-code/plans/landed/DOC-gate/ and
 * DOC-split/gate-live-proof-report.md (the v1.0.362 fault among them).
 *
 * The documents' schema gate between two running instances (docs/agents/work-docs.md "The schema
 * gate"): HOST runs this tree (it knows schema 2), OLD runs an older build from its own worktree
 * (GATE_OLD_TREE: a release from before styling, which knows schema 0 and says nothing of a schema
 * in its socket's address). OLD saves HOST with a client key minted for the run, so OLD's window
 * opens HOST's documents over the relay (`work.docs.connect`, `work.docs.recv`), as his Mac's
 * window opens the box's.
 *
 *  1. HOST: a classic document (a .md import, schema 0) and a styled one (a .docx with a font, a
 *     size and a colour, schema 1), each in a Work Chat of its own.
 *  2. OLD opens the classic one: the document on HOST stays whole, neither window sends a frame
 *     that adds to it or deletes from it, it draws, and typing goes both ways.
 *  3. OLD opens the styled one: refused before any of it is sent; what OLD draws is recorded, none
 *     of its words reach OLD's page or OLD's relay, and HOST's stored file is byte for byte as it was.
 *  4. With OLD on the classic one, HOST styles it with `doc_format` (because: own): the document
 *     rises to 1, OLD's socket is closed before the styled write is sent, OLD's later typing reaches
 *     nothing, and HOST keeps the styling and every block.
 *  5. The other way: HOST pairs with OLD, and HOST's window on a document OLD serves is told no
 *     schema by `work.docs.open` and offers the classic row alone.
 *
 * Each window's side of the relay is recorded in its own page (every link's `request` wrapped for
 * the `work.docs.*` calls) and each sync frame is decoded: which Yjs client's units it adds and
 * whose it deletes. So "nothing reached it" and "it wrote nothing" are read off the frames, not
 * off a page alone. Every check waits on a condition; those that prove an absence wait on the
 * event that would have carried it and then watch for a stated time.
 *
 * Which old build. v1.0.361 (work-kit v64) is the last release whose editor writes nothing before a
 * document's first copy: it is the default. v1.0.362 (work-kit v66) writes its own empty paragraph
 * first and, when its Yjs client id sorts before the document's, deletes the whole document: with
 * it step 2 fails about one run in two, which is that release's fault and not the gate's. When
 * step 2 empties the document, HOST writes it again so step 4 is still shown.
 *
 *   heavy --low env -u ELECTRON_RUN_AS_NODE bun scripts/proof-doc-gate.ts
 *
 * GATE_OLD_TREE, GATE_HOST_TREE: the built worktrees (HOST's is this one unless named).
 * GATE_OUT: where the results, the frames and the pictures go.
 * GATE_STEPS=classic: steps 1 and 2 alone, for any pair of trees (a control: new on new, old on old).
 * GATE_HOST_WINDOW=later: HOST's own window opens the classic document only after OLD has.
 *
 * Every tree must be built (`bunx electron-vite build` in each). Dummy words only; no model runs.
 */

const HOST_TREE = resolve(process.env.GATE_HOST_TREE ?? REPO)
const OLD_TREE = resolve(process.env.GATE_OLD_TREE ?? join(REPO, '../build-documents-gateproof-v361'))
const OUT = resolve(process.env.GATE_OUT ?? '/srv/agents/work/temp-code/.temp-code/plans/landed/DOC-gate')
const SHOTS = join(OUT, 'shots')
/** A control: any pair of trees, the classic document alone (steps 1 and 2), to tell a fault of one build from a fault of the pair. */
const CONTROL = process.env.GATE_STEPS === 'classic'
/** HOST's own window stays off the classic document until OLD has opened it: what OLD's open does with no other editor on it. */
const HOST_WINDOW_LATER = process.env.GATE_HOST_WINDOW === 'later'
for (const tree of [HOST_TREE, OLD_TREE])
  if (!existsSync(join(tree, 'out', 'main', 'index.js'))) {
    console.error(`${tree}/out/main is missing: run electron-vite build there first`)
    process.exit(2)
  }
mkdirSync(SHOTS, { recursive: true })

const host = new Run('doc-gate-host', { repo: HOST_TREE, out: OUT })
const old = new Run('doc-gate-old', { repo: OLD_TREE, out: OUT })
const check = (label: string, ok: boolean, detail = ''): boolean => host.check(label, ok, detail)
const note = (line: string): void => host.note(line)
const remotePort = { host: 0, old: 0 }

// ── The documents' words ────────────────────────────────────────────────

const CLASSIC_MD = '# Doors and desks\n\nDoors open at nine for the check-in line.\n\nThe front desk keeps the spare cables and the wristbands.\n\nTeams sit by seed in rows A to D.\n'
const CLASSIC_WORDS = ['Doors and desks', 'Doors open at nine', 'spare cables', 'rows A to D']
const STYLED_TITLE = 'Styled bracket notes'
/** Words only the styled document's body holds: none may reach OLD's page or relay. */
const STYLED_WORDS = ['Marigold seeding', 'quartzline', 'Vermilion caster desk']
const FONT = 'Georgia'
const COLOUR = '#B22222'
const OLD_TYPED = ' Lanyards at the door.'
const HOST_TYPED = ' Water at every row.'
const OLD_AFTER = ' Typed after the rise.'
const OLD_HOST_MD = '# Old host notes\n\nThe old host keeps this list of chairs.\n'

const text = (value: string, styles: Record<string, string | boolean> = {}): Inline => ({ type: 'text', text: value, styles }) as Inline
const block = (id: string, content: Inline[], type = 'paragraph', props: Block['props'] = {}): Block => ({ id, type, props, content, children: [] })

async function styledDocx(): Promise<Uint8Array> {
  return writeDocx(
    [
      block('head', [text('Marigold seeding')], 'heading', { level: 1 }),
      block('one', [text('The quartzline bracket is drawn at noon. '), text('Vermilion caster desk', { fontFamily: FONT, fontSize: '16', color: COLOUR })]),
      block('two', [text('Seeds follow last season’s quartzline order.', { fontFamily: 'Calibri', fontSize: '12', color: '#0F4761' })])
    ],
    { ...emptySidecar(), document: { schema: 1, styles: Object.fromEntries(DEFAULT_STYLES.map((s) => [s.name, s])), theme: TEMPCODE_THEME, setup: defaultSetup() } } as never,
    { title: STYLED_TITLE }
  )
}

// ── The stored document, read from its .tcdoc on HOST's disk ────────────

type Stored = { fileSha: string; stateSha: string; schema: number; blocks: number; xml: string; clients: number[] }
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 16)
function stored(path: string): Stored {
  const bytes = new Uint8Array(readFileSync(path))
  const state = unzipSync(bytes)['state.yjs'] ?? new Uint8Array()
  const doc = new Y.Doc({ gc: false })
  if (state.length) Y.applyUpdate(doc, state)
  const xml = doc.getXmlFragment(DOCUMENT_FRAGMENT).toString()
  return { fileSha: sha(bytes), stateSha: sha(state), schema: schemaOf(doc), blocks: (xml.match(/<blockcontainer\b/gi) ?? []).length, xml, clients: [...Y.decodeStateVector(Y.encodeStateVector(doc)).keys()] }
}

// ── The windows ─────────────────────────────────────────────────────────

/** The editor on screen: a window keeps the editor of every open tab in its page, and all but one are hidden. */
const ED = `([...document.querySelectorAll('.bn-editor')].find((e) => e.getClientRects().length > 0) ?? null)`
const editorText = `(${ED}?.textContent ?? '')`
const PANE = `(() => { const ed = ${ED}; const pane = ed?.closest('[data-canvas-pane], [data-doc-row], [data-slot="canvas"]') ?? ed?.parentElement?.parentElement?.parentElement; return { editor: !!ed, editorText: ed?.textContent ?? '', pane: (pane?.innerText ?? '').slice(0, 600), bones: document.querySelectorAll('[data-slot="skeleton"], .animate-pulse').length, alerts: [...document.querySelectorAll('[role="alert"], [role="status"]')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 6) } })()`
type Pane = { editor: boolean; editorText: string; pane: string; bones: number; alerts: string[] }

/** Both themes of the window, told as the app tells it (the class and the scheme's event). */
async function shot(run: Run, name: string): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await run.page(`(document.documentElement.classList.toggle('theme-light', ${scheme === 'light'}), window.dispatchEvent(new CustomEvent('monocode:schemechange', { detail: ${JSON.stringify(scheme)} })))`)
    await sleep(700)
    const { data } = (await run.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    writeFileSync(join(SHOTS, `${name}.${scheme}.png`), Buffer.from(data, 'base64'))
  }
  await run.page(`(document.documentElement.classList.toggle('theme-light', false), window.dispatchEvent(new CustomEvent('monocode:schemechange', { detail: 'dark' })))`)
  await sleep(300)
}
const both = async (name: string): Promise<void> => {
  await shot(host, `${name}-host`)
  await shot(old, `${name}-old`)
}

/** Asks until `test` is true or `ms` is over, and says nothing either way: the caller's check line says what was read. */
async function poll(ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(400)
  }
  return false
}

/** Puts a thread on screen, asking again until the window knows it (a remote host's thread arrives with its link's list). */
async function showIn(run: Run, sessionId: string, ready: string): Promise<boolean> {
  return run.until(`thread ${sessionId} on screen`, 90_000, async () => {
    await run.page(`window.__monocode.open(${JSON.stringify(sessionId)}).then(() => true, () => false)`)
    return poll(8000, () => run.page<boolean>(ready))
  })
}

/** A real click at the end of the editor's text node that holds `word`, End, then the words typed. */
async function typeAfter(run: Run, word: string, words: string): Promise<boolean> {
  const at = await run.page<{ x: number; y: number } | null>(
    `(() => { const ed = ${ED}; if (!ed) return null; const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes(${JSON.stringify(word)})) { n.parentElement.scrollIntoView({ block: 'center' }); const r = document.createRange(); r.setStart(n, n.nodeValue.length); r.collapse(true); const b = r.getClientRects()[0] ?? n.parentElement.getBoundingClientRect(); return { x: Math.max(b.left - 1, 1), y: b.top + b.height / 2 } } return null })()`
  )
  if (!at) return false
  await run.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
  for (const type of ['mousePressed', 'mouseReleased']) await run.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await sleep(200)
  await run.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
  await run.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
  await run.send('Input.insertText', { text: words })
  return true
}

// ── Each window's side of the relay, recorded in its own page ───────────

type Entry = { m: string; at: number; path: string | null; socket: string | null; done?: number; got?: string; frames?: string[]; sent?: string[]; closed?: { code: number; reason: string } | null; error?: string; schema?: number | null }
/** Wraps `request` on the link to `env` and on every other link the window holds, so each `work.docs.*` call and its answer is kept in the page. */
const recorder = (env: string): string =>
  `(() => { const reg = window.__monocode.registry; const log = (window.__gateLog ??= []); for (const link of new Set([reg.linkOf(${JSON.stringify(env)}), ...(reg.links?.() ?? [])])) { if (link.__gate) continue; const orig = link.request.bind(link); link.request = (m, p, o) => { const r = orig(m, p, o); if (typeof m === 'string' && m.startsWith('work.docs.')) { const e = { m, at: Date.now(), path: p?.source?.path ?? null, socket: p?.socket ?? null }; if (m === 'work.docs.send') e.sent = [...(p?.frames ?? [])]; log.push(e); r.then((v) => { e.done = Date.now(); if (m === 'work.docs.connect') e.got = v?.socket; if (m === 'work.docs.recv') { e.frames = v?.frames ?? []; e.closed = v?.closed ?? null } if (m === 'work.docs.open') e.schema = v?.schema ?? null }, (err) => { e.done = Date.now(); e.error = String(err?.message ?? err) }) } return r }; link.__gate = true } return true })()`
const relayLogOf = (run: Run): Promise<Entry[]> => run.page<Entry[]>('window.__gateLog ?? []')
const relayLog = (): Promise<Entry[]> => relayLogOf(old)

/** Hocuspocus's message types; 2 (auth), 7 (close), 9 and 10 (ping, pong) carry nothing of a document. */
const BARE = new Set([2, 7, 9, 10])
/** The types that can carry a document's content: 0 and 4 (sync and its reply), 5 and 6 (stateless). 1 and 3 are awareness, 8 says an update was taken. */
const CARRIES = new Set([0, 4, 5, 6])
/** What a sync frame writes: the units it adds and the units it deletes, by the Yjs client whose units they are. */
type Wrote = { made: Record<string, number>; cut: Record<string, number> }
type Frame = { at: number; socket: string; dir: 'got' | 'sent'; type: number; kind: string; bytes: number; words: string[]; wrote: Wrote | null }
const SYNC = ['step1', 'step2', 'update']
function readFrame(base64: string, watch: string[]): Pick<Frame, 'type' | 'kind' | 'bytes' | 'words' | 'wrote'> {
  const raw = Buffer.from(base64, 'base64')
  let type = -1
  let kind = ''
  let wrote: Wrote | null = null
  try {
    const d = decoding.createDecoder(new Uint8Array(raw))
    decoding.readVarString(d)
    type = decoding.readVarUint(d)
    if (type === 0 || type === 4) {
      const step = decoding.readVarUint(d)
      kind = SYNC[step] ?? `sync ${step}`
      if (step === 1 || step === 2) {
        const { structs, ds } = Y.decodeUpdate(decoding.readVarUint8Array(d))
        wrote = { made: {}, cut: {} }
        for (const s of structs) if (s.constructor.name === 'Item') wrote.made[s.id.client] = (wrote.made[s.id.client] ?? 0) + s.length
        for (const [client, runs] of ds.clients) wrote.cut[client] = (wrote.cut[client] ?? 0) + runs.reduce((n, r) => n + r.len, 0)
      }
    }
  } catch {
    /* not a hocuspocus frame */
  }
  const body = raw.toString('latin1')
  return { type, kind, bytes: raw.length, words: watch.filter((w) => body.includes(w) || body.toLowerCase().includes(w.toLowerCase())), wrote }
}
function framesOf(log: Entry[], path: string, watch: string[]): { sockets: string[]; frames: Frame[]; sent: Frame[]; closes: { at: number; socket: string; code: number; reason: string }[] } {
  const sockets = log.filter((e) => e.m === 'work.docs.connect' && e.path === path && e.got).map((e) => e.got!)
  const frames: Frame[] = []
  const sent: Frame[] = []
  const closes: { at: number; socket: string; code: number; reason: string }[] = []
  for (const e of log) {
    if (!e.socket || !sockets.includes(e.socket)) continue
    if (e.m === 'work.docs.send') for (const f of e.sent ?? []) sent.push({ at: e.at, socket: e.socket, dir: 'sent', ...readFrame(f, watch) })
    if (e.m !== 'work.docs.recv' || !e.done) continue
    for (const f of e.frames ?? []) frames.push({ at: e.done, socket: e.socket, dir: 'got', ...readFrame(f, watch) })
    if (e.closed) closes.push({ at: e.done, socket: e.socket, ...e.closed })
  }
  return { sockets, frames, sent, closes }
}
const units = (by: Record<string, number>): number => Object.values(by).reduce((n, v) => n + v, 0)
/** The frames a window sent that add to the document or delete from it, in words. */
const writesOf = (sent: Frame[]): string[] =>
  sent.filter((f) => f.wrote && units(f.wrote.made) + units(f.wrote.cut) > 0).map((f) => `${f.kind} of ${f.bytes} bytes at ${new Date(f.at).toISOString().slice(11, 23)}: adds ${JSON.stringify(f.wrote!.made)}, deletes ${JSON.stringify(f.wrote!.cut)}`)
/** True once every send on the document was answered and a read after the last one came back: what the window sent has reached the host. */
function settled(log: Entry[], path: string): boolean {
  const sockets = log.filter((e) => e.m === 'work.docs.connect' && e.path === path && e.got).map((e) => e.got!)
  const last = sockets.at(-1)
  if (!last) return false
  const mine = log.filter((e) => e.socket === last)
  const sends = mine.filter((e) => e.m === 'work.docs.send')
  if (sends.some((e) => !e.done)) return false
  const after = Math.max(0, ...sends.map((e) => e.done ?? 0))
  return mine.some((e) => e.m === 'work.docs.recv' && (e.done ?? 0) >= after) && mine.some((e) => e.m === 'work.docs.recv' && e.done && (e.frames ?? []).some((f) => CARRIES.has(readFrame(f, []).type)))
}

/** The controls of the format row on screen, those folded into its More menu at this width among them (a hidden tab's row is not read). */
const ITEMS = `(() => { const row = [...document.querySelectorAll('[data-slot="format-row"]')].find((e) => e.getClientRects().length > 0); return row ? [...new Set([...row.querySelectorAll('[data-format-item]')].map((e) => e.dataset.formatItem))] : [] })()`
const STYLING = ['font', 'size', 'colour', 'highlight', 'spacing']
/** A control pair's end: thrown past the later steps, and no failure. */
class Stop extends Error {}

try {
  remotePort.host = await freePort()
  remotePort.old = await freePort()
  await host.start({ env: { TEMP_CODE_REMOTE_PORT: String(remotePort.host) } })
  await old.start({ env: { TEMP_CODE_REMOTE_PORT: String(remotePort.old) } })
  const hostEnv = (await host.call<{ environmentId: string }>('remote.status')).environmentId
  const oldEnv = (await old.call<{ environmentId: string }>('remote.status')).environmentId
  note(`HOST ${hostEnv} from ${HOST_TREE} (${host.root}); OLD ${oldEnv} from ${OLD_TREE} (${old.root})${CONTROL ? '; a control: the classic document alone' : ''}${HOST_WINDOW_LATER ? "; HOST's window opens the classic document after OLD" : ''}`)

  // OLD saves HOST with a client key minted for the run, as his Mac's window saves the box.
  const key = await host.call<{ token: string; id?: string; key?: { id: string } }>('remote.keys.create', { name: 'doc gate (proof)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  const keyId = key.id ?? key.key?.id
  if (keyId) host.later('revoke the run key', () => host.call('remote.keys.revoke', { id: keyId }))
  await old.call('remote.environments.add', { url: `http://127.0.0.1:${remotePort.host}`, key: key.token, name: 'HOST' })
  // Asked, not awaited: the page's promise can be left with no holder while the window takes the new host in (CDP then answers "Promise was collected"); the wait below is the condition.
  await old.page('(void window.__monocode.loadSavedEnvironments(), true)')
  const linked = await old.until('OLD reaches HOST', 90_000, () => old.page<boolean>(`window.__monocode.registry.has(${JSON.stringify(hostEnv)}) && window.__monocode.registry.statusOf(${JSON.stringify(hostEnv)}).transport === 'open'`))
  if (!check("OLD's window reaches HOST over its saved link (a remote key there)", linked)) throw new Error('no link from OLD to HOST')
  await old.page(recorder(hostEnv))
  await host.page(recorder(await host.page<string>('window.__monocode.registry.primaryEnvironmentId')))

  // ── 1. HOST's documents ──
  const threadA = await host.thread(null, 'Classic run sheet', { firstMessage: 'Keep the run sheet.' })
  const a = await host.call<ImportAnswer>('work.formats.import', { sessionId: threadA, from: { at: 'bytes', name: 'Classic run sheet.md', data: Buffer.from(CLASSIC_MD).toString('base64') } }, 300_000)
  const pathA = a.source.at === 'file' ? a.source.path : ''
  const sA0 = stored(pathA)
  copyFileSync(pathA, join(OUT, 'classic-0-imported.tcdoc'))
  check('HOST: the .md imports as a classic document (schema 0)', !!a.itemId && sA0.schema === 0, `schema ${sA0.schema}, ${sA0.blocks} blocks, written by Yjs client ${sA0.clients.join(', ')}, ${pathA}`)
  const readA = async (): Promise<string> => textOf(await host.tool(threadA, 'doc_read', { item: a.itemId! }))
  const wholeA = (words: string): boolean => CLASSIC_WORDS.every((w) => words.includes(w))
  check('HOST reads every line of it (doc_read)', wholeA(await readA()))

  // HOST's own window on A: the row it offers its own classic document, for step 5's contrast.
  const hostOpensA = async (): Promise<void> => {
    const hostDrawsA = await showIn(host, threadA, `${editorText}.includes('Doors open at nine')`)
    check("HOST's window draws its classic document", hostDrawsA, (await host.page<string>(editorText)).slice(0, 120) || '(nothing drawn)')
    if (CONTROL) return
    await host.until('the row', 20_000, () => host.page<boolean>(`${ITEMS}.length > 0`))
    const hostRowOwn = await host.page<string[]>(ITEMS)
    check("HOST's window on its own classic document offers the styling controls (its host keeps schema 2)", ['font', 'size', 'colour'].every((i) => hostRowOwn.includes(i)), hostRowOwn.join(' '))
  }
  if (!HOST_WINDOW_LATER) {
    await hostOpensA()
    await shot(host, '00-classic-before-old-opens-host')
    const quiet = await host.until("HOST's window has its first copy", 30_000, async () => settled(await relayLogOf(host), pathA))
    const hostWrote = writesOf(framesOf(await relayLogOf(host), pathA, []).sent)
    check("HOST's window opened it and wrote nothing into it", quiet && hostWrote.length === 0 && wholeA(await readA()), hostWrote.join('; ') || 'no frame it sent adds or deletes anything')
  }

  // ── 2. OLD opens the classic document ──
  // It is asked to open until it draws the words, or until the document on HOST no longer holds them: that is the damage this proof is for.
  const tOpen = Date.now()
  const oldDrawsA = await old.until("OLD draws the classic document, or HOST's copy changes", 90_000, async () => {
    await old.page(`window.__monocode.open(${JSON.stringify(threadA)}).then(() => true, () => false)`)
    return poll(8000, async () => (await old.page<boolean>(`${editorText}.includes('Doors open at nine')`)) || !wholeA(await readA()))
  })
  await old.until("OLD's window has its first copy", 30_000, async () => settled(await relayLog(), pathA))
  // A watch, not a wait: nothing may change for 15 s after OLD's first copy, on HOST or in either window's frames.
  await poll(15_000, async () => !wholeA(await readA()))
  const oldA = await old.page<string>(editorText)
  const afterOpen = await readA()
  const seenOpen = { old: framesOf(await relayLog(), pathA, []), host: framesOf(await relayLogOf(host), pathA, []) }
  writeFileSync(join(OUT, 'frames-classic-open.json'), JSON.stringify({ openedAt: tOpen, importClients: sA0.clients, old: seenOpen.old, host: seenOpen.host }, null, 1))
  await poll(10_000, () => stored(pathA).stateSha !== sA0.stateSha)
  const sAopen = stored(pathA)
  copyFileSync(pathA, join(OUT, 'classic-1-after-old-opened.tcdoc'))
  await both('01-classic-open')
  const oldWrote = writesOf(seenOpen.old.sent)
  const hostWroteNow = writesOf(seenOpen.host.sent)
  const intact = wholeA(afterOpen) && sAopen.blocks === sA0.blocks
  // The three lines that say whether an old window may be let onto a classic document at all.
  check("HOST's classic document is whole after OLD's window opened it (doc_read on HOST, and the stored file's blocks)", intact, `doc_read: ${afterOpen.replace(/\n+/g, ' / ').slice(0, 160) || '(empty)'}; stored blocks ${sA0.blocks} → ${sAopen.blocks}, Yjs clients ${sA0.clients.join(', ')} → ${sAopen.clients.join(', ')}`)
  check("OLD's window opened it and wrote nothing into it (the frames it sent)", oldWrote.length === 0, oldWrote.join('; ') || 'no frame it sent adds or deletes anything')
  check("HOST's window wrote nothing into it while OLD opened it (the frames it sent)", hostWroteNow.length === 0, hostWroteNow.join('; ') || (HOST_WINDOW_LATER ? "HOST's window was not on the document" : 'no frame it sent adds or deletes anything'))
  check("OLD's window draws HOST's classic document, every line", oldDrawsA && wholeA(oldA), oldA.slice(0, 200) || '(nothing drawn)')
  if (HOST_WINDOW_LATER) await hostOpensA()
  if (intact) {
    check('OLD types into it', await typeAfter(old, 'Doors open at nine', OLD_TYPED))
    check("OLD's typing reaches HOST (doc_read on HOST)", await host.until('OLD typed', 30_000, async () => (await readA()).includes(OLD_TYPED.trim())), (await readA()).replace(/\n+/g, ' / ').slice(0, 300))
    check('HOST types into it', await typeAfter(host, 'spare cables and the wristbands', HOST_TYPED))
    check("HOST's typing reaches OLD's window", await old.until('HOST typed', 30_000, () => old.page<boolean>(`${editorText}.includes(${JSON.stringify(HOST_TYPED.trim())})`)), await old.page<string>(`${editorText}.slice(0, 300)`))
    const both2 = await readA()
    check('HOST keeps every line and both sides’ words after the typing', wholeA(both2) && both2.includes(OLD_TYPED.trim()) && both2.includes(HOST_TYPED.trim()), both2.replace(/\n+/g, ' / ').slice(0, 300))
    await both('02-classic-typed')
  } else {
    check('typing both ways on the classic document', false, 'not run: the document was no longer whole once OLD had opened it')
  }
  if (CONTROL) throw new Stop()

  // The styled document, made only now: a control pair stops before it.
  const threadB = await host.thread(null, STYLED_TITLE, { firstMessage: 'Keep the bracket notes.' })
  const b = await host.call<ImportAnswer>('work.formats.import', { sessionId: threadB, from: { at: 'bytes', name: `${STYLED_TITLE}.docx`, data: Buffer.from(await styledDocx()).toString('base64') } }, 300_000)
  const pathB = b.source.at === 'file' ? b.source.path : ''
  const sB0 = stored(pathB)
  check(`HOST: the .docx imports as a styled document (schema 1, ${FONT} and ${COLOUR} in its state)`, !!b.itemId && sB0.schema === 1 && sB0.xml.includes(FONT) && sB0.xml.toLowerCase().includes(COLOUR.toLowerCase()), `schema ${sB0.schema}, ${sB0.blocks} blocks`)
  const readB = async (): Promise<string> => textOf(await host.tool(threadB, 'doc_read', { item: b.itemId! }))
  const bText0 = await readB()

  // ── 3. OLD opens the styled document ──
  const connectsB = async (): Promise<boolean> => framesOf(await relayLog(), pathB, STYLED_WORDS).closes.length > 0
  const refusedB = await old.until("OLD's relay on the styled document is closed", 90_000, async () => {
    await old.page(`window.__monocode.open(${JSON.stringify(threadB)}).then(() => true, () => false)`)
    return poll(8000, connectsB)
  })
  const seenB = framesOf(await relayLog(), pathB, STYLED_WORDS)
  check("HOST refuses OLD's socket on the styled document: OLD's relay is answered with a close", refusedB, JSON.stringify(seenB.closes.slice(0, 3)))
  const contentB = seenB.frames.filter((f) => !BARE.has(f.type))
  check('nothing of the styled document is sent down OLD\'s relay: only auth and close frames', seenB.frames.length > 0 && contentB.length === 0, `frames by type: ${JSON.stringify(seenB.frames.map((f) => f.type))}`)
  check("none of the styled document's words is in any frame OLD was handed", seenB.frames.every((f) => f.words.length === 0), JSON.stringify(seenB.frames.filter((f) => f.words.length)))
  await sleep(1500) // the pane settles after the close; what it draws now is the finding, read below
  const paneB = await old.page<Pane>(PANE)
  note(`OLD's window on the refused styled document: ${JSON.stringify(paneB)}`)
  const oldBody = await old.page<string>('document.body.innerText + " " + document.body.textContent')
  check("none of the styled document's words is in OLD's page", STYLED_WORDS.every((w) => !oldBody.includes(w)), STYLED_WORDS.filter((w) => oldBody.includes(w)).join(', ') || 'none of them')
  // An old build predates the line "Update TempCode to open this document."; what it says instead is the finding, and it must be in words.
  const refusalLine = ['Update TempCode to open this document.', 'This document could not be opened for editing.'].find((line) => oldBody.includes(line))
  check("OLD's window says in words that it could not open the styled document", !!refusalLine, refusalLine ? `it reads "${refusalLine}"${refusalLine.startsWith('Update') ? '' : ' (this build has no "Update TempCode" line)'}` : `no such line; the pane reads: ${paneB.pane.replace(/\n+/g, ' / ').slice(0, 200) || '(nothing)'}`)
  await both('03-styled-refused')
  // Wait on a second refusal (the old provider tries again), then read HOST's file: nothing it sent was taken.
  await poll(45_000, async () => framesOf(await relayLog(), pathB, STYLED_WORDS).closes.length > 1)
  const sB1 = stored(pathB)
  check("HOST's stored styled document is byte for byte what it was", sB1.fileSha === sB0.fileSha && sB1.stateSha === sB0.stateSha && sB1.blocks === sB0.blocks && sB1.schema === 1, `file ${sB0.fileSha} → ${sB1.fileSha}, state ${sB0.stateSha} → ${sB1.stateSha}, blocks ${sB0.blocks} → ${sB1.blocks}`)
  check("HOST reads the styled document as it was (doc_read)", (await readB()) === bText0)

  // ── 4. HOST styles the classic document while OLD has it open ──
  // If OLD's open emptied it, HOST writes it again first, so the rise is still shown against a real old window; the check lines say which document it was.
  let ready4 = intact
  if (!intact) {
    const rewritten = textOf(await host.tool(threadA, 'doc_write', { item: a.itemId!, markdown: CLASSIC_MD, because: 'own' }))
    const lost = await poll(10_000, async () => !wholeA(await readA()))
    ready4 = !lost && wholeA(await readA())
    check('HOST writes the emptied classic document again (doc_write) and it stays whole for 10 s', ready4, `${rewritten.replace(/\n+/g, ' / ').slice(0, 160)}; doc_read now: ${(await readA()).replace(/\n+/g, ' / ').slice(0, 160) || '(empty)'}`)
  }
  if (!ready4) {
    check('the rise: HOST styles the classic document while OLD has it open', false, 'not run: there is no whole classic document to style')
  } else {
    const backOnA = await showIn(old, threadA, `${editorText}.includes(${JSON.stringify(intact ? HOST_TYPED.trim() : 'Doors open at nine')})`)
    check(intact ? "OLD's window is on the classic document again, with both sides' words" : "OLD's window draws the classic document HOST wrote again", backOnA, (await old.page<string>(editorText)).slice(0, 160) || '(nothing drawn)')
    const live = await old.until("OLD's relay on the classic document carries frames", 30_000, async () => {
      const f = framesOf(await relayLog(), pathA, [])
      const last = f.sockets.at(-1)
      return !!last && f.frames.some((x) => x.socket === last && CARRIES.has(x.type)) && !f.closes.some((c) => c.socket === last)
    })
    check("OLD holds a live socket on the classic document (its sync frames arrive)", live)
    const sA1 = stored(pathA)
    const t0 = await old.page<number>('Date.now()')
    const formatted = textOf(await host.tool(threadA, 'doc_format', { item: a.itemId!, because: 'own', on: { quote: 'Doors open at nine' }, run: { font: FONT, color: COLOUR } }))
    check(`HOST: doc_format sets ${FONT} and ${COLOUR} on a quote`, /^Formatted/.test(formatted), formatted)
    const closedA = await old.until("OLD's socket on the classic document is closed", 30_000, async () => framesOf(await relayLog(), pathA, []).closes.some((c) => c.at >= t0))
    const seenA = framesOf(await relayLog(), pathA, [FONT, COLOUR.slice(1)])
    check("the rise closes OLD's socket on the classic document", closedA, JSON.stringify(seenA.closes.filter((c) => c.at >= t0).slice(0, 3)))
    const after = seenA.frames.filter((f) => f.at >= t0)
    check(`the styled write never reaches OLD: no frame after the format holds ${FONT} or the colour, and none carries the document`, after.every((f) => f.words.length === 0) && after.every((f) => !CARRIES.has(f.type)), `frames after: ${JSON.stringify(after.map((f) => ({ type: f.type, bytes: f.bytes, words: f.words })))}`)
    check(`the frames before the format did carry the document (the recorder reads true)`, seenA.frames.some((f) => f.at < t0 && CARRIES.has(f.type)))
    await sleep(1500) // the pane settles after the close; what it draws now is the finding, read below
    const paneA = await old.page<Pane>(PANE)
    note(`OLD's window after the rise: ${JSON.stringify({ ...paneA, editorText: paneA.editorText.slice(0, 300) })}`)
    check("the styling is not drawn in OLD's window", !(await old.page<boolean>(`[...(${ED}?.querySelectorAll('*') ?? [])].some((e) => /georgia/i.test(getComputedStyle(e).fontFamily) || e.getAttribute('style')?.toLowerCase().includes('b22222'))`)))
    await both('04-classic-styled-by-host')
    const typedLate = await typeAfter(old, 'Teams sit by seed', OLD_AFTER)
    const tTyped = await old.page<number>('Date.now()')
    const drawnLate = typedLate && (await old.until('OLD draws its own late words', 10_000, () => old.page<boolean>(`${editorText}.includes(${JSON.stringify(OLD_AFTER.trim())})`)))
    note(`OLD typed after the rise: ${typedLate ? (drawnLate ? 'its editor drew the words locally' : 'its editor did not take the words') : 'no editor text to type into'}`)
    // Wait for OLD's next try at the document to be refused (that is when its words would go up), then read HOST.
    const retried = await old.until("OLD's next try is refused", 30_000, async () => framesOf(await relayLog(), pathA, []).closes.some((c) => c.at >= tTyped))
    if (!retried) {
      note('OLD made no new try within 30 s; HOST is read after 10 s more')
      await sleep(10_000)
    }
    const aText = await readA()
    check("OLD's typing after the rise reaches nothing on HOST (doc_read)", !aText.includes(OLD_AFTER.trim()), aText.replace(/\n+/g, ' / ').slice(0, 300))
    check(intact ? 'HOST keeps every block and both sides’ earlier words' : 'HOST keeps every block', wholeA(aText) && (!intact || (aText.includes(OLD_TYPED.trim()) && aText.includes(HOST_TYPED.trim()))), aText.replace(/\n+/g, ' / ').slice(0, 300))
    const risen = await host.until('the file says schema 1', 60_000, () => stored(pathA).schema === 1)
    const sA2 = stored(pathA)
    check(`HOST's stored classic document rose to schema 1 and holds ${FONT} and ${COLOUR}, every block kept`, risen && sA2.xml.includes(FONT) && sA2.xml.toLowerCase().includes(COLOUR.toLowerCase()) && sA2.blocks === sA1.blocks && !sA2.xml.includes(OLD_AFTER.trim()), `schema ${sA2.schema}, blocks ${sA1.blocks} → ${sA2.blocks}`)
    check(`HOST's window draws the quote in ${FONT}`, await host.until('styled in HOST', 20_000, () => host.page<boolean>(`[...(${ED}?.querySelectorAll('*') ?? [])].some((e) => e.textContent.includes('Doors open at nine') && /georgia/i.test(getComputedStyle(e).fontFamily))`)))
    await both('05-old-typed-after-rise')
  }

  // ── 5. The other way: HOST's window on a document OLD serves ──
  const back = await old.call<{ token: string; id?: string; key?: { id: string } }>('remote.keys.create', { name: 'doc gate back (proof)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  const backId = back.id ?? back.key?.id
  if (backId) old.later('revoke the run key', () => old.call('remote.keys.revoke', { id: backId }))
  await host.call('remote.environments.add', { url: `http://127.0.0.1:${remotePort.old}`, key: back.token, name: 'OLD' })
  await host.page('(void window.__monocode.loadSavedEnvironments(), true)')
  const linkedBack = await host.until('HOST reaches OLD', 90_000, () => host.page<boolean>(`window.__monocode.registry.has(${JSON.stringify(oldEnv)}) && window.__monocode.registry.statusOf(${JSON.stringify(oldEnv)}).transport === 'open'`))
  if (check("HOST's window reaches OLD over its saved link", linkedBack)) {
    const threadC = await old.thread(null, 'Old host notes', { firstMessage: 'Keep the chairs list.' })
    const c = await old.call<ImportAnswer>('work.formats.import', { sessionId: threadC, from: { at: 'bytes', name: 'Old host notes.md', data: Buffer.from(OLD_HOST_MD).toString('base64') } }, 300_000)
    const opened = await host.page<{ ok: boolean; value?: Record<string, unknown>; error?: string }>(
      `window.__monocode.registry.linkOf(${JSON.stringify(oldEnv)}).request('work.docs.open', { source: ${JSON.stringify(c.source)} }).then((value) => ({ ok: true, value }), (e) => ({ ok: false, error: String(e?.message ?? e) }))`
    )
    check("OLD's work.docs.open answers no schema", opened.ok && !('schema' in (opened.value ?? {})), opened.ok ? `keys: ${Object.keys(opened.value ?? {}).join(' ')}` : opened.error)
    const hostDrawsC = await showIn(host, threadC, `${editorText}.includes('list of chairs')`)
    check("HOST's window draws OLD's document", hostDrawsC)
    await host.until('the row', 20_000, () => host.page<boolean>(`${ITEMS}.length > 0`))
    const rowOnOld = await host.page<string[]>(ITEMS)
    check("HOST's window on OLD's document offers no styling control (no font, size, colour, highlight or spacing)", rowOnOld.length > 0 && STYLING.every((i) => !rowOnOld.includes(i)), rowOnOld.join(' '))
    await both('06-new-window-old-host')
  }

  writeFileSync(join(OUT, 'relay-old.json'), JSON.stringify({ classic: framesOf(await relayLog(), pathA, [FONT, COLOUR.slice(1)]), styled: framesOf(await relayLog(), pathB, STYLED_WORDS), hostEnv, oldEnv }, null, 1))
  throw new Stop()
} catch (err) {
  // Stop is the job's own end (a control pair's, or the whole run's); anything else is a failure of the run.
  const failure = err instanceof Stop ? undefined : err
  if (failure) console.error(failure)
  await old.stop().catch(() => undefined)
  for (const line of old.results) host.results.push(`OLD ${line}`)
  if (old.failed) check('OLD stopped clean', false, `${old.failed} failure(s) on OLD's side`)
  await host.finish(failure)
}
