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
 * row; find counts its matches on the text; an agent's formatting waits as a
 * suggestion that says what it does; Preview draws the Word file's pages.
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
    const { data } = (await run.send('Page.captureScreenshot', { format: 'png', clip: { x: CLIP.clipLeft, y: 0, width: 1440 - CLIP.clipLeft, height: 900, scale: 1 } })) as { data: string }
    writeFileSync(join(run.out, `${name}.${scheme}.png`), Buffer.from(data, 'base64'))
  }
  await run.page(`(document.documentElement.classList.toggle('theme-light', false), window.dispatchEvent(new CustomEvent('monocode:schemechange', { detail: 'dark' })))`)
  await sleep(300)
}
const command = (id: string) => `window.dispatchEvent(new CustomEvent('work:command', { detail: { id: ${JSON.stringify(id)} } }))`

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
  await shot('01-document')

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
  // Three steps on, to matches further down: each is brought into view.
  for (let i = 0; i < 3; i++) {
    await run.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await run.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(150)
  }
  run.check('Enter steps to the next match', await run.until('the fourth', 5000, () => run.page<boolean>(`/^4 of /.test(document.querySelector('.te-find-count')?.textContent ?? '')`)), await run.page<string>(`document.querySelector('.te-find-count')?.textContent ?? ''`))
  await sleep(600)
  await shot('02-find')
  await run.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await run.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  // The scroller holds its sideways place (the comments rail lies 4px past the column: nothing may scroll the text toward it, a step of find least of all).
  const sideways = await run.page<number>(`document.querySelector('[data-doc-scroller]')?.scrollLeft ?? -1`)
  run.check('stepping through find never moves the document sideways', sideways === 0, String(sideways))
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
