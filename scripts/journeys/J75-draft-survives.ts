import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { editShape, replaceText, TEXT_EDITOR, waitForFocus } from './lib/edit'
import { openRow, unzip } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { a1Point, cellValue } from './lib/sheet'
import { revealView } from './lib/more'

const NAME = 'TempCode proof draft.txt'
const FIRST = 'First practice note'
const TWO = FIRST + ' one' + ' two'
const MINE = TWO + ' and mine'
const THEIRS = 'Changed on the holder while win was gone'
const DECK = 'TempCode proof draft.pptx'
const TITLE = 'Kept through a crash'
const SHEET = 'TempCode proof draft.xlsx'
const CELL = '4242'

/** His draft on win's own disk: a file of the store main writes (src/main/drafts.ts) that holds these words. */
function draftOnDisk({ pair }: Context, words: string): boolean {
  const root = join(pair.win.data, 'drafts')
  if (!existsSync(root)) return false
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).some((f) => f.endsWith('.json') && readFileSync(join(root, f), 'utf8').includes(words))
}

/** Cuts win's link to box and waits until the window knows it. */
async function cut({ pair }: Context): Promise<void> {
  pair.later(async () => pair.cutWindowLink(false))
  pair.cutWindowLink(true)
  await pair.page.until('the window to lose the link while box stays up', 15_000, async () => {
    await pair.rpc(pair.box, 'work.get')
    return pair.page.eval(`window.__docket.registry.statusOf(${JSON.stringify(pair.box.host)}).transport !== 'open'`)
  })
}

/** Two edits typed apart into the open editor, with the link closed: neither reaches box. */
async function typeTwo({ pair }: Context, words: string[], end: string): Promise<void> {
  const { page } = pair
  // Focus first: a restored draft redraws the editor, which takes no keys until it is clicked.
  await page.clickOn(TEXT_EDITOR)
  await waitForFocus(page, TEXT_EDITOR)
  await page.key('Control+End')
  for (const w of words) {
    await page.typeKeys(w)
    await Bun.sleep(900)
  }
  await page.until('the typed words while the save line says they wait', 22_000, async () =>
    /wait|offline/i.test(await page.saveLine() ?? '') &&
    await page.eval(`document.querySelector('[data-files-file] .cm-content')?.textContent === ${JSON.stringify(end)}`))
}

/** Win killed with no word to it, the link opened again, and win started again on the same data. */
async function crashAndBack(context: Context, between?: () => void, name = NAME): Promise<void> {
  const { pair } = context
  pair.later(async () => { if (!pair.abort.signal.aborted) await pair.restart(pair.win) })
  await pair.halt(pair.win, true)
  between?.()
  pair.cutWindowLink(false)
  await pair.restart(pair.win)
  // The relaunched window reaches box again before Files is asked for: a press before it opens nothing.
  const host = JSON.stringify(pair.box.host)
  await pair.page.until('the relaunched window’s link to box', 60_000, () =>
    pair.page.eval(`!!window.__docket && window.__docket.registry.has(${host}) && window.__docket.registry.statusOf(${host}).transport === 'open'`))
  await showPlace(context).catch(async () => {
    // The pane may have kept a new thread over Files: Files is asked for once more.
    await revealView(pair.page, 'button, a, [role="link"]', 'Files')
    await pair.page.clickOn('button, a, [role="link"]', 'Files')
    await showPlace(context)
  })
  // The file opened again from its row: its tab comes to the front, and the session reads it afresh.
  await openRow(pair.page, name)
}

async function offered(context: Context, words: RegExp, label: string): Promise<void> {
  const { page } = context.pair
  await page.until('the draft offered in the save line: ' + label, 40_000, async () => words.test(await page.saveLine() ?? ''))
  await page.shot(join(context.folder, label + '.png'))
}

export default journey({
  id: 'J75',
  title: 'A draft survives an abrupt exit, and a changed base keeps both',
  tier: 1,
  shapes: ['A', 'B1'],
  steps: [
    step('Open the text file and write its first line', async (context) => {
      writeFileSync(fileAt(context, NAME), 'Original')
      await showPlace(context)
      await openRow(context.pair.page, NAME)
      await replaceText(context.pair.page, FIRST)
      await context.pair.page.until('the first line on box', 20_000, () => readFileSync(fileAt(context, NAME), 'utf8') === FIRST)
    }),
    step('Cut win’s link, type two edits, and kill win with no word', async (context) => {
      await cut(context)
      await typeTwo(context, [' one', ' two'], TWO)
      await crashAndBack(context)
    }),
    step('The draft is offered on reopen, and Restore puts both edits on the holder', async (context) => {
      await offered(context, /were not saved$/, 'offered')
      await context.pair.page.press('button', 'Restore')
      await context.pair.page.until('both edits on the holder', 30_000, () => readFileSync(fileAt(context, NAME), 'utf8') === TWO)
    }),
    step('Cut again, type, kill win, and change the file on its holder while win is gone', async (context) => {
      await cut(context)
      await typeTwo(context, [' and', ' mine'], MINE)
      await crashAndBack(context, () => writeFileSync(fileAt(context, NAME), THEIRS))
      const { page } = context.pair
      if (context.shape === 'A') {
        // The file the draft was made on changed: the offer is Keep Both alone, never Restore over it.
        await offered(context, /The file changed since$/, 'changed-base')
        return page.press('button', 'Keep Both')
      }
      // A library file is edited as box's copy of it: the copy did not change, so the draft goes back into the copy,
      // and the copy's own send meets the newer file on win and offers Keep Both there (copies.ts), never a write over it.
      await offered(context, /were not saved$/, 'copy-base')
      await page.press('button', 'Restore')
      await page.until('the copy’s line to say the file changed there', 40_000, async () => /changed on/i.test(await page.saveLine() ?? ''))
      await page.shot(join(context.folder, 'changed-there.png'))
      await page.press('button', 'Keep Both')
    }),
    step('A deck’s open box: type a title with the link cut, kill win, and Restore it', async (context) => {
      const { page } = context.pair
      copyFileSync(join(context.pair.repo, 'src/main/server/work/slides/fixtures/steps-talk.pptx'), fileAt(context, DECK))
      await showPlace(context)
      await openRow(page, DECK)
      // The deck is drawn before the link goes: a box opens on a shape the window holds.
      await page.until('the deck’s title shape', 60_000, () => page.eval(`!!document.querySelector('[data-shape][aria-label$=": Spring season"]')`))
      await cut(context)
      await editShape(page, '[data-shape][aria-label$=": Spring season"]')
      await page.key('Control+a')
      await page.typeKeys(TITLE)
      await page.until('the box’s words in win’s draft store', 15_000, () => draftOnDisk(context, TITLE))
      await crashAndBack(context, undefined, DECK)
      // The relaunched window is another page.
      const again = context.pair.page
      await offered(context, /were not saved$/, 'deck-offered')
      await again.press('button', 'Restore')
      await again.until('the title in the holder’s first slide', 40_000, () =>
        [...unzip(fileAt(context, DECK), 'ppt/slides/slide1.xml').matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('').includes(TITLE))
    }),
    step('A sheet’s cell: type it with the link cut, kill win, and Restore it', async (context) => {
      const { page } = context.pair
      copyFileSync(join(context.pair.repo, 'src/main/server/work/sheets/harness/corpus/formulas.xlsx'), fileAt(context, SHEET))
      await showPlace(context)
      await openRow(page, SHEET)
      await page.until('the worksheet', 60_000, () => a1Point(page))
      await cut(context)
      await page.click((await a1Point(page))!)
      await page.typeKeys(CELL)
      await page.key('Enter')
      await page.until('the cell in win’s draft store', 15_000, () => draftOnDisk(context, CELL))
      await crashAndBack(context, undefined, SHEET)
      const again = context.pair.page
      await again.until('the reopened worksheet', 60_000, () => a1Point(again))
      await offered(context, /were not saved$/, 'sheet-offered')
      await again.press('button', 'Restore')
      await again.until('the cell in the holder’s workbook', 40_000, () =>
        cellValue(unzip(fileAt(context, SHEET), 'xl/worksheets/sheet1.xml'), unzip(fileAt(context, SHEET), 'xl/sharedStrings.xml'), 'A1') === CELL)
    }),
    step('end: the holder keeps the newer file and his draft beside it', async (context) => {
      const file = fileAt(context, NAME)
      const folder = dirname(file)
      const besides = (): string[] => readdirSync(folder).filter((n) => n !== NAME && n.endsWith('.txt') && readFileSync(join(folder, n), 'utf8') === MINE)
      try {
        await context.pair.page.until('his draft kept beside the newer file', 30_000, () => besides().length === 1)
        if (readFileSync(file, 'utf8') !== THEIRS) throw new Error('The newer file was written over')
      } finally {
        writeFileSync(join(context.folder, 'holder.txt'), readFileSync(file))
      }
    })
  ]
})
