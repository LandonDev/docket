import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_STYLES, defaultSetup } from 'work-kit/editor/page'
import { paraText } from 'work-kit/editor/para'
import { TEMPCODE_THEME } from 'work-kit/format/theme'
import { emptySidecar, type Block, type Inline } from 'work-kit/formats'
import { writeDocx } from 'work-kit/formats/docx'
import type { ImportAnswer } from '../src/shared/contract-work-formats'
import { Run, sleep, textOf } from './e2e-work-lib'

/**
 * The document pane in a running window (docs/agents/work-docs.md "The first
 * copy", "Styling: the format row", "Find…", "Preview"): a styled Word file
 * is imported into a Work Chat's canvas of an isolated instance, and the
 * window must DRAW it: the words, in the document's fonts, under the format
 * row, as sheets of its paper (docs/agents/work-docs.md "Pages": the canvas
 * here is wider than 640px, so a styled document opens in Pages); the bar
 * says the sheet he is on; Flow and back; Page set-up moves the breaks and
 * Undo puts them back; find counts its matches on the sheets; an agent's
 * formatting waits as a suggestion that says what it does; Preview draws
 * the Word file's pages, the PDF is the sheets page for page, and Preview's
 * Page rows set the document's own margins.
 * Every check reads the window over CDP, and each state is shot in both
 * themes into the run's out folder (DOC_WINDOW_SHOTS copies them elsewhere).
 *
 *   env -u ELECTRON_RUN_AS_NODE heavy bun scripts/proof-doc-window.ts
 *
 * It needs this tree built (out/). Dummy words only; no model runs.
 */
const run = new Run('doc-window')
const TITLE = 'Spring LAN run of show'
const CLIP = { clipLeft: 460 }
/** The window's width: 1440 leaves the canvas 620px beside the thread (under Pages' 640), 1760 leaves it 940 (a US Letter sheet at true size). */
let WIDTH = 1440

const text = (value: string, styles: Record<string, string | boolean> = {}): Inline => ({ type: 'text', text: value, styles } as Inline)
const line = (id: string, value: string, type = 'paragraph', props: Block['props'] = {}): Block => ({ id, type, props, content: [text(value)], children: [] })
const cell = (value: string) => ({ type: 'tableCell' as const, props: {}, content: [text(value)] })

const BODY = 'Setup starts at 8:00 AM. Every station needs power and a wired line before the first team checks in at 9:30.'
const filler = (n: number): Block[] =>
  Array.from({ length: n }, (_, i) => line(`fill${i}`, `Round ${i + 1}: the bracket moves on the hour, the casters call the stage match, and the crew resets the stations between maps while the next teams check in at the front table.`))

function blocks(): Block[] {
  const body = line('setup', BODY)
  body.content = [text('Setup starts at 8:00 AM. '), text('Every station needs power and a wired line', { bold: true }), text(' before the first team checks in at 9:30.', { fontFamily: 'Calibri', fontSize: '12', color: '#0F4761' })]
  return [
    line('title', TITLE, 'paragraph', { para: paraText({ style: 'Title' }) }),
    line('sub', 'Purdue esports, Saturday April 18, Ballroom A', 'paragraph', { para: paraText({ style: 'Subtitle' }) }),
    line('before', 'Before doors', 'heading', { level: 1 }),
    body,
    line('rows', 'Forty stations in four rows', 'bulletListItem'),
    line('desk', "Casters' desk on the riser, facing the stage", 'bulletListItem'),
    line('spare', 'Spare headsets in the green room', 'bulletListItem'),
    line('match', 'Match day', 'heading', { level: 1 }),
    line('hour', 'Matches start on the hour, and the bracket moves on without a team that is not seated.', 'paragraph', { para: paraText({ lineSpacing: 1.5 }) }),
    {
      id: 'stations', type: 'table', props: {}, children: [],
      content: { type: 'tableContent', columnWidths: [160, 120], headerRows: 1, rows: [{ cells: [cell('Station'), cell('Time')] }, { cells: [cell('Check-in'), cell('9:00 AM')] }, { cells: [cell('Finals'), cell('6:00 PM')] }] }
    } as unknown as Block,
    line('rounds', 'The rounds', 'heading', { level: 1 }),
    ...filler(28)
  ]
}

const editorText = `(document.querySelector('.bn-editor')?.textContent ?? '')`

/**
 * Both themes of the pane. The window is told the theme as the app tells it (the class and the
 * scheme's event): an editor that is told its theme in JS draws a styled document's colours for
 * that theme, which a class alone would leave as they were.
 */
async function shot(name: string): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await run.page(`(document.documentElement.classList.toggle('theme-light', ${scheme === 'light'}), window.dispatchEvent(new CustomEvent('monocode:schemechange', { detail: ${JSON.stringify(scheme)} })))`)
    await sleep(700)
    const { data } = (await run.send('Page.captureScreenshot', { format: 'png', clip: { x: CLIP.clipLeft, y: 0, width: WIDTH - CLIP.clipLeft, height: 900, scale: 1 } })) as { data: string }
    writeFileSync(join(run.out, `${name}.${scheme}.png`), Buffer.from(data, 'base64'))
  }
  await run.page(`(document.documentElement.classList.toggle('theme-light', false), window.dispatchEvent(new CustomEvent('monocode:schemechange', { detail: 'dark' })))`)
  await sleep(300)
}
const command = (id: string) => `window.dispatchEvent(new CustomEvent('work:command', { detail: { id: ${JSON.stringify(id)} } }))`

/** A real press of the mouse on what `expr` finds (twice for a double press); false when nothing is there to press. */
async function press(expr: string, clicks = 1, at: { x?: number; y?: number } = {}): Promise<boolean> {
  const spot = await run.page<{ x: number; y: number } | null>(
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return r.width ? { x: ${at.x === undefined ? 'r.left + r.width / 2' : `r.left + ${at.x}`}, y: ${at.y === undefined ? 'r.top + r.height / 2' : `r.top + ${at.y}`} } : null })()`
  )
  if (!spot) return false
  for (let n = 1; n <= clicks; n++) {
    await run.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: n })
    await run.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: n })
  }
  return true
}
/** A control by the name he reads on it, inside `scope`, where it is drawn. */
const control = (scope: string, name: string): string =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} :is(button, [role=radio], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option])`)})].find((e) => [e.getAttribute('aria-label'), (e.textContent ?? '').trim()].includes(${JSON.stringify(name)}) && e.getBoundingClientRect().width > 0)`

/** Pages as the window draws it: the sheets, the stage against its scroller, the bar's fact, where the text's column stands. */
interface Sheets {
  stage: boolean
  sheets: number
  fact: string
  sheetWidth: number
  left: number
  right: number
  edge: number
  pad: string
  ground: boolean
  column: number
  marginLeft: string
  lastTop: number
}
const sheets = (): Promise<Sheets> =>
  run.page<Sheets>(`(() => {
    const scroller = document.querySelector('[data-doc-scroller]')
    const stage = scroller?.querySelector('.te-pages-stage')
    const all = [...(stage?.querySelectorAll('.te-page-sheet') ?? [])]
    const s = scroller?.getBoundingClientRect(), g = stage?.getBoundingClientRect(), first = all[0]?.getBoundingClientRect()
    const last = [...document.querySelectorAll('.bn-editor [data-content-type="paragraph"]')].find((e) => e.textContent.startsWith('Round 28'))
    return {
      stage: !!stage,
      sheets: all.length,
      fact: document.querySelector('[data-canvas-bar] [data-doc-page]')?.textContent ?? '',
      sheetWidth: first?.width ?? 0,
      left: first && g ? first.left - g.left : -1,
      right: first && g ? g.right - first.right : -1,
      edge: s && g ? Math.abs(g.left - s.left) + Math.abs(g.width - scroller.clientWidth) : -1,
      pad: scroller ? getComputedStyle(scroller).padding : '',
      ground: !!scroller && !!stage && getComputedStyle(scroller).backgroundColor === getComputedStyle(stage).backgroundColor,
      column: document.querySelector('.bn-editor')?.getBoundingClientRect().width ?? 0,
      marginLeft: stage?.querySelector('.te-pages')?.style.getPropertyValue('--te-ml') ?? '',
      lastTop: last && scroller ? Math.round(last.getBoundingClientRect().top + scroller.scrollTop) : -1
    }
  })()`)
const sideways = () => run.page<number>(`(() => { const s = document.querySelector('[data-doc-scroller]'); return s ? s.scrollWidth - s.clientWidth : -1 })()`)
/** What stands furthest past the scroller's right edge, for a failed check's words. */
const widest = () =>
  run.page<string>(`(() => { const s = document.querySelector('[data-doc-scroller]'); if (!s) return 'no scroller'; const edge = s.getBoundingClientRect().left + s.clientWidth; const past = [...s.querySelectorAll('*')].map((e) => ({ e, by: Math.round(e.getBoundingClientRect().right - edge) })).filter((x) => x.by > 0).sort((a, b) => b.by - a.by).slice(0, 4); return JSON.stringify({ sideways: s.scrollWidth - s.clientWidth, past: past.map((x) => x.e.tagName.toLowerCase() + '.' + String(x.e.className).slice(0, 60) + ' +' + x.by) }) })()`)
const scrollTo = (top: string) => run.page(`(() => { const s = document.querySelector('[data-doc-scroller]'); s.scrollTop = ${top} })()`)
const previewCount = () => run.page<number>(`Number((document.querySelector('[data-doc-preview] [data-preview-count]')?.textContent ?? '').match(/of ([\\d,]+)/)?.[1]?.replace(/,/g, '') ?? 0)`)

try {
  await run.start()
  const thread = await run.thread(null, `E2E-DOC ${TITLE}`, { firstMessage: 'Look over the run of show.' })
  const docx = await writeDocx(blocks(), {
    ...emptySidecar(),
    document: {
      schema: 1,
      styles: Object.fromEntries(DEFAULT_STYLES.map((style) => [style.name, style])),
      theme: TEMPCODE_THEME,
      setup: defaultSetup(),
      header: { start: [{ text: TITLE }], center: [], end: [] },
      footer: { start: [], center: [{ text: 'Page ' }, { field: 'page' }, { text: ' of ' }, { field: 'pages' }], end: [] }
    }
  } as never, { title: TITLE })
  const imported = await run.call<ImportAnswer>('work.formats.import', { sessionId: thread, from: { at: 'bytes', name: `${TITLE}.docx`, data: Buffer.from(docx).toString('base64') } }, 300_000)
  run.check('the styled .docx imports into the canvas', !!imported.itemId && imported.source.at === 'file', JSON.stringify(imported.warnings))
  const item = imported.itemId!
  const source = imported.source

  // 1. The window draws the document: the first copy came in whole.
  await run.show(thread)
  const drawn = await run.until('the words', 60_000, () => run.page<boolean>(`${editorText}.includes('Before doors') && ${editorText}.includes('Finals')`))
  run.check('the pane draws the document: its words, its list and its table', drawn, await run.page<string>(`${editorText}.slice(0, 160)`))
  const agentSees = textOf(await run.tool(thread, 'doc_read', { item }))
  run.check('the stored document is whole after the window opened it', ['Before doors', 'Forty stations', 'Finals', 'Round 28'].every((w) => agentSees.includes(w)), agentSees.slice(0, 200))
  const rowShown = await run.until('the row', 20_000, () => run.page<boolean>(`!!document.querySelector('[data-doc-row] [data-slot="format-row"]')`))
  run.check('the format row is the body\'s first row', rowShown)
  await sleep(1500)
  const fonts = await run.page<{ family: string; size: string; loaded: boolean; title: string }>(
    `(() => { const p = [...document.querySelectorAll('.bn-editor [data-content-type="paragraph"]')].find((e) => e.textContent.startsWith('Matches start')); const t = [...document.querySelectorAll('.bn-editor [data-content-type="paragraph"] .bn-inline-content')].find((e) => e.textContent.startsWith(${JSON.stringify(TITLE)})); const cs = p ? getComputedStyle(p) : null; return { family: cs?.fontFamily ?? '', size: cs?.fontSize ?? '', loaded: [...document.fonts].some((f) => /Carlito/.test(f.family) && f.status === 'loaded'), title: t ? getComputedStyle(t).fontSize : '' } })()`
  )
  run.check('the text is drawn in the document\'s own styles: Calibri as Carlito, 11 pt body, 22 pt title', /Carlito/.test(fonts.family) && fonts.loaded && Math.abs(parseFloat(fonts.size) - 14.667) < 0.2 && Math.abs(parseFloat(fonts.title) - 29.333) < 0.3, JSON.stringify(fonts))
  const named = await run.page<{ titles: number; headCells: number; cells: number }>(`({ titles: [...document.querySelectorAll('[data-doc-scroller] h1, [data-doc-scroller] .bn-inline-content')].filter((e) => e.textContent.trim() === ${JSON.stringify(TITLE)}).length, headCells: document.querySelectorAll('.bn-editor th').length, cells: document.querySelectorAll('.bn-editor td').length })`)
  run.check('the name is said once in the text (the document\'s own Title), and the table has one header row of two cells', named.titles === 1 && named.headCells === 2 && named.cells === 4, JSON.stringify(named))
  // In Flow the comments rail lies 4px past the scroller's padding (work-kit's own number; asked of the package), under
  // `overflow-x: hidden`: nothing he can scroll to. What must hold is that the text is never moved toward it.
  run.check('the document is not scrolled sideways', (await run.page<number>(`document.querySelector('[data-doc-scroller]')?.scrollLeft ?? -1`)) === 0, await widest())
  const beside = await sheets()
  const canvasWidth = () => run.page<number>(`document.querySelector('[data-doc-scroller]')?.parentElement?.parentElement?.clientWidth ?? 0`)
  const at620 = await canvasWidth()
  run.check(`on a canvas under 640px (${at620}px beside the thread) a styled document opens in Flow, and the bar says no page`, at620 > 0 && at620 < 640 && !beside.stage && beside.fact === '', JSON.stringify({ canvas: at620, stage: beside.stage, fact: beside.fact }))
  await shot('01-document')

  // 1b. Pages: a styled document on a canvas of 640px or more is sheets of its paper.
  WIDTH = 1760
  await run.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(1200)
  const widened = await sheets()
  run.check(`a later resize changes nothing: still Flow on ${await canvasWidth()}px`, !widened.stage && widened.fact === '' && (await canvasWidth()) >= 864, JSON.stringify({ canvas: await canvasWidth(), stage: widened.stage }))
  // The item opened anew at this width: the window is loaded again, his state untouched (he pressed nothing).
  await run.send('Page.reload')
  await sleep(1500)
  await run.until('the window again', 90_000, () => run.page<boolean>(`!!window.__monocode && document.readyState === 'complete'`).catch(() => false))
  await sleep(2500)
  await run.show(thread)
  const again = await run.until('the words again', 90_000, () => run.page<boolean>(`${editorText}.includes('Before doors') && ${editorText}.includes('Finals')`).catch(() => false))
  run.check('the window loaded again draws the document', again)
  const drew = await run.until('the sheets', 20_000, async () => (await sheets()).sheets > 1 && /^Page 1 of \d+$/.test((await sheets()).fact))
  const open = await sheets()
  const N = open.sheets
  run.check('a styled document opens in Pages on this canvas: sheets on the stage', drew && open.stage && N > 1, JSON.stringify(open))
  run.check('the stage takes the scroller edge to edge, on its own ground and padding', open.edge < 1 && open.pad === '0px' && open.ground, JSON.stringify({ edge: open.edge, pad: open.pad, ground: open.ground }))
  run.check('a sheet is drawn at true size (US Letter, 816px) in the middle of the stage', Math.abs(open.sheetWidth - 816) < 1 && Math.abs(open.left - open.right) <= 1, JSON.stringify({ width: open.sheetWidth, left: open.left, right: open.right }))
  run.check(`the kind's bar says "Page 1 of ${N}", once`, open.fact === `Page 1 of ${N}` && (await run.page<number>(`[...document.querySelectorAll('[data-canvas-bar] *')].filter((e) => e.children.length === 0 && /^Page \\d+ of \\d+$/.test(e.textContent ?? '')).length`)) === 1, open.fact)
  run.check('in Pages the pane does not scroll sideways', (await sideways()) === 0, await widest())
  run.check('no title of the pane\'s stands over the sheets', (await run.page<number>(`[...document.querySelectorAll('[data-doc-scroller] h1, [data-doc-scroller] input[aria-label="Title"]')].filter((e) => !e.closest('.bn-editor') && e.getBoundingClientRect().height > 0).length`)) === 0)
  await shot('05-pages')
  await scrollTo('s.scrollHeight')
  const followed = await run.until('the last sheet', 10_000, async () => (await sheets()).fact === `Page ${N} of ${N}`)
  run.check('scrolled to the last sheet, the fact follows', followed, (await sheets()).fact)
  await sleep(400)
  await shot('05-pages-last-sheet')
  await scrollTo('0')

  // Flow and back: his switch in the row.
  const toFlow = await press(control('[data-doc-row]', 'Flow'))
  const flow = await run.until('Flow', 10_000, async () => !(await sheets()).stage)
  const inFlow = await sheets()
  const flowLook = await run.page<{ width: number; pad: string }>(`(() => { const s = document.querySelector('[data-doc-scroller]'); return { width: document.querySelector('.bn-editor')?.getBoundingClientRect().width ?? 0, pad: getComputedStyle(s).paddingLeft } })()`)
  run.check('Flow in the row puts the text back in its column, and the fact leaves the bar', toFlow && flow && inFlow.fact === '' && flowLook.pad === '24px' && flowLook.width <= 672 + 1, JSON.stringify({ toFlow, fact: inFlow.fact, ...flowLook }))
  await sleep(400)
  await shot('06-flow')
  const toPages = await press(control('[data-doc-row]', 'Pages'))
  const back = await run.until('Pages again', 10_000, async () => (await sheets()).sheets === N && (await sheets()).fact === `Page 1 of ${N}`)
  run.check('Pages in the row draws the same sheets again', toPages && back, JSON.stringify(await sheets()))

  // Page set-up: a double press on a sheet's margin opens it; Narrow margins move the breaks; Undo puts them back.
  const before = await sheets()
  await press(`document.querySelector('[data-doc-scroller] .te-pages')`, 2, { x: 24, y: 320 })
  const dialog = await run.until('Page set-up', 10_000, () => run.page<boolean>(`!!document.querySelector('[data-slot="page-setup"]')`))
  run.check('a double press on a sheet\'s margin opens Page set-up', dialog)
  await sleep(400)
  await shot('07-page-setup')
  const narrow = await press(control('[data-slot="page-setup"]', 'Narrow'))
  const applied = await press(control('[data-slot="page-setup"]', 'Apply'))
  const moved = await run.until('narrow margins', 15_000, async () => (await sheets()).marginLeft === '48px' && !(await run.page<boolean>(`!!document.querySelector('[data-slot="page-setup"]')`)))
  await sleep(600)
  const after = await sheets()
  run.check(
    'Narrow margins widen the text on every sheet and move the page breaks',
    narrow && applied && moved && after.column - before.column > 90 && (after.sheets < before.sheets || after.lastTop !== before.lastTop) && after.fact === `Page 1 of ${after.sheets}`,
    JSON.stringify({ before: { sheets: before.sheets, column: before.column, margin: before.marginLeft, last: before.lastTop }, after: { sheets: after.sheets, column: after.column, margin: after.marginLeft, last: after.lastTop } })
  )
  await shot('08-narrow-margins')
  // Undo: the row's own button, then the key, with the caret in the text.
  await run.page(`document.querySelector('.bn-editor')?.focus()`)
  const undoAt = await run.page<string>(`(() => { const b = ${control('[data-doc-row]', 'Undo')}; return b ? (b.disabled || b.getAttribute('aria-disabled') === 'true' ? 'greyed' : 'live') : 'not in the row' })()`)
  await press(control('[data-doc-row]', 'Undo'))
  let undone = await run.until('the margins back', 5000, async () => (await sheets()).marginLeft === before.marginLeft)
  if (!undone) {
    await run.page(`document.querySelector('.bn-editor')?.focus()`)
    for (const type of ['keyDown', 'keyUp']) await run.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
    undone = await run.until('the margins back by the key', 5000, async () => (await sheets()).marginLeft === before.marginLeft)
  }
  const restored = await sheets()
  run.check('Undo puts the margins and the breaks back', undone && restored.sheets === before.sheets && restored.lastTop === before.lastTop && Math.abs(restored.column - before.column) < 1, JSON.stringify({ undo: undoAt, sheets: restored.sheets, column: restored.column, margin: restored.marginLeft, last: restored.lastTop }))
  if (!undone) {
    // The rest of the job starts from the document's own margins: put back through the dialog.
    await press(`document.querySelector('[data-doc-scroller] .te-pages')`, 2, { x: 16, y: 320 })
    await run.until('Page set-up again', 10_000, () => run.page<boolean>(`!!document.querySelector('[data-slot="page-setup"]')`))
    await press(control('[data-slot="page-setup"]', 'Normal'))
    await press(control('[data-slot="page-setup"]', 'Apply'))
    run.check('Normal in Page set-up puts them back', await run.until('normal margins', 15_000, async () => (await sheets()).marginLeft === before.marginLeft && (await sheets()).lastTop === before.lastTop))
  }

  // 2. Find: the bar, its count, the tints on the text.
  await run.page(`(document.querySelector('.bn-editor')?.focus(), ${command('find')})`)
  const bar = await run.until('the find bar', 10_000, () => run.page<boolean>(`!!document.querySelector('.te-find-bar input')`))
  run.check('Edit → Find… opens the editor\'s find', bar)
  await run.page(`document.querySelector('.te-find-bar input')?.focus()`)
  await run.send('Input.insertText', { text: 'the' })
  const counted = await run.until('the count', 10_000, () => run.page<boolean>(`/\\d+ of \\d+/.test(document.querySelector('.te-find-count')?.textContent ?? '')`))
  const hits = await run.page<{ count: string; hits: number; current: number }>(`({ count: document.querySelector('.te-find-count')?.textContent ?? '', hits: document.querySelectorAll('.bn-editor .te-find-hit').length, current: document.querySelectorAll('.bn-editor .te-find-current').length })`)
  run.check('find counts its matches and tints them on the text, one in hand', counted && hits.hits > 20 && hits.current === 1, JSON.stringify(hits))
  const barFits = await run.page<boolean>(`(() => { const b = document.querySelector('.te-find-bar')?.getBoundingClientRect(); const s = document.querySelector('[data-doc-scroller]')?.getBoundingClientRect(); return !!b && !!s && b.left >= s.left && b.right <= s.right && b.top >= s.top; })()`)
  run.check('the find bar sits inside the document\'s scroller', barFits)
  const onSheets = await run.page<boolean>(`(() => { const hits = [...document.querySelectorAll('[data-doc-scroller] .te-pages .bn-editor .te-find-hit')]; const sheet = document.querySelector('.te-page-sheet')?.getBoundingClientRect(); return hits.length > 20 && !!sheet && hits.every((h) => { const r = h.getBoundingClientRect(); return r.left >= sheet.left && r.right <= sheet.right }) })()`)
  run.check('in Pages its hits are drawn on the sheets', onSheets)
  await sleep(600)
  await shot('02-find')
  await run.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await run.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  run.check('Escape closes it and the tints go', await run.until('closed', 5000, () => run.page<boolean>(`!document.querySelector('.te-find-bar') && document.querySelectorAll('.bn-editor .te-find-hit').length === 0`)))

  // 3. An agent's formatting waits as a suggestion that says what it does.
  await run.call('work.docs.mode', { source, mode: 'suggests' })
  const asked = textOf(await run.tool(thread, 'doc_format', { item, because: 'own', on: { quote: 'Match day' }, paragraph: { style: 'Heading 2' } }))
  run.check('doc_format on a document set to suggest only suggests', /uggest/.test(asked), asked.slice(0, 200))
  const said = await run.until('the words over the block', 30_000, () => run.page<boolean>(`(document.querySelector('.bn-editor .te-change-words')?.textContent ?? '').includes('Heading 1 becomes Heading 2')`))
  run.check('the suggestion says "Heading 1 becomes Heading 2" over its block', said, await run.page<string>(`document.querySelector('.bn-editor .te-change-words')?.textContent ?? 'no words drawn'`))
  await run.page(`document.querySelector('.bn-editor .te-change-words')?.scrollIntoView({ block: 'center' })`)
  await sleep(800)
  await shot('03-suggested-format')
  const { branches } = await run.call<{ branches: { id: string }[] }>('work.history.branches', { source })
  if (branches[0]) await run.call('work.history.decide', { source, branchId: branches[0].id, which: 'all', accept: false })
  await run.call('work.docs.mode', { source, mode: 'writes' })

  // 4. Preview: the Word file's own pages, drawn by LibreOffice.
  await run.page(command('export'))
  const frame = await run.until('Preview', 15_000, () => run.page<boolean>(`!!document.querySelector('[data-doc-preview] *')`))
  run.check('File → Export… opens Preview over the document', frame)
  const pages = await run.until('its pages', 180_000, () => run.page<boolean>(`document.querySelectorAll('[data-doc-preview] canvas').length > 0`))
  run.check('Preview draws the file\'s pages', pages, await run.page<string>(`(document.querySelector('[data-doc-preview]')?.textContent ?? '').slice(0, 200)`))
  await sleep(2500)
  const stage = await run.page<number>(`(() => { const s = document.querySelector('[data-doc-preview] [data-paged-view]'); return s ? s.scrollWidth - s.clientWidth : -1 })()`)
  run.check('Preview\'s stage does not scroll sideways at Fit width', stage === 0, String(stage))
  await shot('04-preview')

  // 5. One print contract: the PDF is the sheets, page for page; LibreOffice's count of the Word file is said beside it.
  const word = await previewCount()
  // The formats are a segment where it fits and a menu where it does not.
  const toPdf = (await press(control('[data-doc-preview]', 'PDF'))) || ((await press(control('[data-doc-preview]', 'Format: Word'))) && (await run.until('the formats', 5000, () => run.page<boolean>(`!!(${control('body', 'PDF')})`))) && (await press(control('body', 'PDF'))))
  const pdfDrawn = await run.until('the PDF', 120_000, async () => (await run.page<boolean>(`(document.querySelector('[data-doc-preview]')?.textContent ?? '').includes('The file itself')`)) && (await previewCount()) > 0)
  await sleep(1500)
  const pdf = await previewCount()
  run.check(`the printed PDF has the sheets' own number of pages (Pages ${N}, PDF ${pdf})`, toPdf && pdfDrawn && pdf === N, JSON.stringify({ pages: N, pdf }))
  run.note(`page counts: Pages ${N}, the printed PDF ${pdf}, LibreOffice's drawing of the Word file ${word}`)
  run.check(`LibreOffice draws the Word file within a page of Pages (Pages ${N}, Word ${word})`, word > 0 && Math.abs(word - N) <= 1, JSON.stringify({ pages: N, word }))
  await shot('09-preview-pdf')

  // Preview's Page rows are the document's own set-up: Narrow there moves the sheets under Preview and the PDF.
  const openMargins = await press(control('[data-doc-preview]', 'Margins: Normal'))
  const pick = (await run.until('the margins menu', 5000, () => run.page<boolean>(`!!(${control('body', 'Narrow')})`))) && (await press(control('body', 'Narrow')))
  const setThere = await run.until('the document\'s margins', 15_000, async () => (await sheets()).marginLeft === '48px')
  const redrawn = await run.until('the PDF again', 120_000, async () => (await run.page<boolean>(`!!(${control('[data-doc-preview]', 'Margins: Narrow')})`)) && (await previewCount()) === (await sheets()).sheets)
  await sleep(1500)
  const narrowed = await sheets()
  const narrowPdf = await previewCount()
  run.check(
    `Margins in Preview's Page rows set the document's own margins, and the PDF is the new sheets (Pages ${narrowed.sheets}, PDF ${narrowPdf})`,
    openMargins && pick && setThere && redrawn && narrowPdf === narrowed.sheets,
    JSON.stringify({ openMargins, pick, setThere, redrawn, sheets: narrowed.sheets, pdf: narrowPdf })
  )
  await shot('10-preview-page-rows')
  await press(control('[data-doc-preview]', 'Margins: Narrow'))
  if (await run.until('the margins menu', 5000, () => run.page<boolean>(`!!(${control('body', 'Normal')})`))) await press(control('body', 'Normal'))
  run.check('and Normal puts them back', await run.until('normal margins', 15_000, async () => (await sheets()).marginLeft === '96px'))

  const copyTo = process.env.DOC_WINDOW_SHOTS
  if (copyTo) {
    mkdirSync(copyTo, { recursive: true })
    const { readdirSync, copyFileSync } = await import('node:fs')
    for (const name of readdirSync(run.out)) if (name.endsWith('.png')) copyFileSync(join(run.out, name), join(copyTo, name))
    writeFileSync(join(copyTo, 'README.txt'), 'Pictures of the document pane in a running instance (scripts/proof-doc-window.ts), each state in dark and light.\n')
  }
  await run.finish()
} catch (err) {
  await run.finish(err)
}
