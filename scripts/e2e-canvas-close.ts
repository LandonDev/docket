import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PREFIX, REPO, Run, sleep } from './e2e-work-lib'

/**
 * Closing an item beside a Work thread's chat, in a real window (docs/agents/work-canvas.md "Closing an item"; the
 * owner's words of 2026-11-24, "there is no way right now to close them"):
 *  1. two dummy workbooks open beside the chat as two tabs, each with its ×
 *  2. a cell typed in the workbook, Return, and its × pressed at once: the close sends the edit first, so the file
 *     holds it (the loss of F-workbook-not-saved.md, from the chat's pane)
 *  3. the other workbook, left alone, shows; ⌘W with focus on its tab closes it, and the chat has the whole pane
 *  4. the workbook opened again from the thread (as its chip does: `work.canvas.open {itemId}`) holds the value
 * Pictures of each step go to the out folder. Dummy files only, in a scratch Work workspace the run deletes.
 * Run after `electron-vite build`: env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-canvas-close.ts [--out <dir>]
 */
const run = new Run('canvas-close')
const unzip = (file: string, part: string): string => Bun.spawnSync(['unzip', '-p', file, part]).stdout.toString()
// Univer may give the first key typed its own text run: judge the words with the markup taken out.
const holds = (file: string, word: string): boolean => [unzip(file, 'xl/sharedStrings.xml'), unzip(file, 'xl/worksheets/sheet1.xml')].some((xml) => xml.replace(/<[^>]+>/g, '').includes(word))
const point = async (x: number, y: number): Promise<void> => {
  await run.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (const type of ['mousePressed', 'mouseReleased']) await run.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
}
const centreOf = (selector: string): Promise<{ x: number; y: number } | null> =>
  run.page(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getClientRects().length); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
const key = async (k: string, code: string, vk: number, modifiers = 0): Promise<void> => {
  await run.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(modifiers ? {} : { text: k.length === 1 ? k : k === 'Enter' ? '\r' : undefined }) })
  await run.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
}
const typeText = async (text: string): Promise<void> => {
  for (const ch of text) await key(ch, /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : 'Space', ch.toUpperCase().charCodeAt(0))
}
const tabs = (): Promise<string[]> => run.page(`[...document.querySelectorAll('[data-canvas-tab]')].map((t) => t.textContent.trim())`)
const lone = (): Promise<string | null> => run.page(`document.querySelector('[data-canvas-title] [data-view-title]')?.textContent ?? null`)
const boardShown = (): Promise<boolean> => run.page(`!!document.querySelector('[data-board] [data-canvas-pane]')`)

try {
  await run.start()
  const ws = await run.call<{ id: string; path: string }>('workspace.create', { kind: 'work', name: `${PREFIX} close`, sector: 'dummy' })
  run.later('delete the workspace', () => run.call('workspace.delete', { workspaceId: ws.id }))
  const thread = await run.thread(ws.id, `${PREFIX} close thread`)
  mkdirSync(ws.path, { recursive: true })
  const book = join(ws.path, 'Dummy budget.xlsx')
  copyFileSync(join(REPO, 'src/main/server/work/sheets/harness/corpus/formulas.xlsx'), book)
  const roster = join(ws.path, 'Dummy roster.xlsx')
  copyFileSync(join(REPO, 'src/main/server/work/sheets/harness/corpus/formulas.xlsx'), roster)
  const env = await run.page<string>('window.__monocode.registry.primaryEnvironmentId')

  // 1. Two items beside the chat.
  const sheet = await run.call<{ id: string }>('work.canvas.open', { sessionId: thread, kind: 'sheet', source: { at: 'file', host: env, path: book }, title: 'Dummy budget.xlsx' })
  await run.call('work.canvas.open', { sessionId: thread, kind: 'sheet', source: { at: 'file', host: env, path: roster }, title: 'Dummy roster.xlsx' })
  await run.show(thread)
  await run.until('two tabs', 30_000, async () => (await tabs()).length === 2)
  await run.page(`document.querySelector('[data-canvas-tab="${sheet.id}"]')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`)
  run.check('both items show as tabs beside the chat', (await tabs()).join(' | ') === 'Dummy budget.xlsx | Dummy roster.xlsx', (await tabs()).join(' | '))
  run.check('the shown tab has its × where a person looks', await run.page<boolean>(`!!document.querySelector('[data-canvas-tab="${sheet.id}"]')?.parentElement?.querySelector('[data-canvas-close][aria-label="Close Dummy budget.xlsx"]')`))
  const cell = (): Promise<{ x: number; y: number } | null> =>
    run.page(`(() => { const c = [...document.querySelectorAll('[data-sheet-item] canvas')].find((e) => e.getBoundingClientRect().width > 100); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + 78), y: Math.round(r.y + 30) } })()`)
  run.check('the workbook draws', await run.until('the sheet', 60_000, async () => !!(await cell())))
  await sleep(1500)
  await run.shot('1-open-beside-chat')

  // 2. A cell typed, Return, and the × at once.
  const value = `Close ${Date.now() % 100000}`
  const a1 = (await cell())!
  await point(a1.x, a1.y)
  await sleep(300)
  await typeText(value)
  await key('Enter', 'Enter', 13)
  const x = await centreOf(`[aria-label="Close Dummy budget.xlsx"]`)
  run.check('the × is on screen', !!x)
  if (x) await point(x.x, x.y)
  run.check('the workbook leaves the row, the other shows alone', await run.until('one item', 15_000, async () => (await lone()) === 'Dummy roster.xlsx'), `${await lone()}`)
  run.check('the workbook closed by its × holds the cell typed just before', await run.until('the file holds it', 20_000, () => holds(book, value)))
  await sleep(800)
  await run.shot('2-closed-one-the-next-shows')

  // 3. ⌘W (Ctrl+W on Linux) with focus on the item's side.
  await run.page(`document.querySelector('[data-canvas-title] [data-canvas-close]')?.focus()`)
  await key('w', 'KeyW', 87, process.platform === 'darwin' ? 4 : 2)
  run.check('Close Tab with focus on the item closes the item, and the chat has the pane', await run.until('no board', 15_000, async () => !(await boardShown())))
  run.check('the thread is still open', await run.page<boolean>(`!!document.querySelector('[data-chat]') && document.querySelector('[data-chat]').getBoundingClientRect().width > 900`))
  await sleep(600)
  await run.shot('3-chat-full-width')

  // 4. Opened again from the thread, as its chip does.
  await run.call('work.canvas.open', { sessionId: thread, itemId: sheet.id })
  run.check('the workbook opens again beside the chat', await run.until('reopened', 20_000, async () => (await lone()) === 'Dummy budget.xlsx'))
  run.check('it draws again', await run.until('the sheet', 60_000, async () => !!(await cell())))
  await sleep(1500)
  run.check('and still holds the value', holds(book, value))
  await run.shot('4-reopened')
} catch (err) {
  await run.finish(err)
}
await run.finish()
