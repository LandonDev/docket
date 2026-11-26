import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOC_EDITOR, TEXT_EDITOR } from '../../journeys/lib/edit'
import { closeSelectedFile, dummyPdf, openRow, rowAt } from '../../journeys/lib/files'
import { fixtureTool } from '../../journeys/lib/fixtures'
import { INPUT } from '../../journeys/lib/lifeosJourney'
import { fileAt, goPlace, holderFolder, selectFolderTab, showPlace } from '../../journeys/lib/place'
import { FILES_FIELD } from '../../journeys/lib/search'
import type { Shape } from '../../journeys/lib/shape'
import { thrice, type PerfCtx, type Row } from '../lib/row'

/** Where a file may sit: the job's own folder on box, a library on the window's machine, one on a third machine. */
export const PLACES: Shape[] = ['A', 'B1', 'B2']
export const BENCH = 'Bench'
export const BENCH_ENTRIES = 300
const needs = (shape: Shape): Row['needs'] => ({ fake: true, ...(shape === 'B2' ? { desk: true } : {}) })
const crumb = (name: string): string => `document.querySelector('[data-files-bar] [aria-current="page"]')?.textContent.trim() === ${JSON.stringify(name)}`
const rows = (n: number): string => `document.querySelectorAll('[data-files-body] [data-files-row]').length >= ${n} && !document.querySelector('[data-files-body] [aria-busy="true"], [data-files-body] [data-files-skeleton]')`

/** The bench folder in a shape's holder: 300 dummy text files, made once. */
function bench(ctx: PerfCtx, shape: Shape): void {
  const folder = join(holderFolder(ctx.at(shape)), BENCH)
  if (existsSync(folder)) return
  mkdirSync(folder, { recursive: true })
  for (let i = 1; i <= BENCH_ENTRIES; i++) writeFileSync(join(folder, `practice-${String(i).padStart(3, '0')}.txt`), 'A dummy line.\n')
}

/**
 * The shape's holder folder shown. The rail is pressed only when the job's Files view is not already up: a job with a
 * thread at work says so in its rail row, and the journeys' press looks for the bare name.
 */
async function shown(ctx: PerfCtx, shape: Shape): Promise<void> {
  const context = ctx.at(shape)
  await ctx.page.dismissPopups()
  if (await ctx.page.centre('[data-files-sidebar] button', ctx.workspace.name)) await goPlace(context)
  else await showPlace(context)
}

async function place(ctx: PerfCtx, shape: Shape): Promise<void> {
  bench(ctx, shape)
  await shown(ctx, shape)
  await ctx.page.until('the bench folder row', 40_000, () => rowAt(ctx.page, BENCH))
}

const list = (shape: Shape): Row => ({
  id: 'list-' + shape,
  title: `Open a folder of ${BENCH_ENTRIES} entries (${shape})`,
  needs: needs(shape),
  run: (ctx) => thrice(ctx, async () => {
    const at = await ctx.page.steadyPoint(BENCH + ' row', () => rowAt(ctx.page, BENCH), 30_000)
    return {
      region: '[data-files-body]',
      usable: `${crumb(BENCH)} && ${rows(15)}`,
      press: () => ctx.page.click(at, 2)
    }
  }, () => place(ctx, shape))
})

const back = (shape: Shape): Row => ({
  id: 'back-' + shape,
  title: `Back from that folder to the one he came from (${shape})`,
  needs: needs(shape),
  run: (ctx) => thrice(ctx, () => ({
    region: '[data-files-body]',
    usable: `!(${crumb(BENCH)}) && ${rows(1)}`,
    press: () => ctx.page.press('button', 'Back')
  }), async () => {
    await place(ctx, shape)
    await openRow(ctx.page, BENCH)
    await ctx.page.until('the bench folder listed', 40_000, () => ctx.page.eval(`${crumb(BENCH)} && ${rows(15)}`))
  })
})

const search = (shape: Shape): Row => ({
  id: 'search-' + shape,
  title: `Search every place for a file by name: Return to its row among the results (${shape})`,
  needs: needs(shape),
  run: (ctx) => thrice(ctx, async (i) => {
    const name = `practice-${150 + i}`
    // The field opens from the bar's Search. Typing narrows the folder shown; Return asks every place.
    if (!await ctx.page.centre(FILES_FIELD)) await ctx.page.clickOn('[data-files-bar] button', 'Search')
    await ctx.page.clickOn(FILES_FIELD)
    await ctx.page.key('Control+a')
    await ctx.page.typeKeys(name)
    return {
      region: '[data-files-page]',
      usable: `(() => {
        const panel = document.querySelector('[data-files-page]');
        // The row, or the page's own word that nothing was found (a third machine's folders are named as not searched).
        return !!panel?.querySelector('[data-files-filters]') && !panel.querySelector('[aria-label="Loading"][aria-busy="true"]') &&
          ([...panel.querySelectorAll('[data-files-body] [data-files-row]')].some((row) => row.innerText.includes(${JSON.stringify(name)})) ||
            (panel.querySelector('[data-files-body]')?.innerText ?? '').includes('Nothing found'));
      })()`,
      press: () => ctx.page.key('Enter')
    }
  }, async () => {
    if (await ctx.page.centre(FILES_FIELD)) await ctx.page.key('Escape')
    await place(ctx, shape)
  }).finally(async () => { if (await ctx.page.centre(FILES_FIELD).catch(() => null)) await ctx.page.key('Escape').catch(() => undefined) })
})

/** The kinds a file opens as, each with a dummy and what "he can use it" means for it. */
const KINDS = {
  document: { name: 'Practice plan.tcdoc', usable: `!!document.querySelector(${JSON.stringify(DOC_EDITOR)})?.getClientRects().length` },
  word: { name: 'Practice letter.docx', usable: `!!document.querySelector(${JSON.stringify(DOC_EDITOR)})?.getClientRects().length` },
  workbook: { name: 'Practice sums.xlsx', usable: `[...document.querySelectorAll('[data-sheet-item] canvas')].some((c) => c.getBoundingClientRect().width > 100) && !document.querySelector('[data-files-file] [aria-busy="true"][aria-label="Loading"]')` },
  deck: { name: 'Practice briefing.pptx', usable: `!!document.querySelector('[data-slides-stage] [data-slide-picture]')?.childElementCount` },
  pdf: { name: 'Practice sheet.pdf', usable: `!!document.querySelector('[data-pdf-page="1"] canvas')?.width` },
  image: { name: 'Practice picture.png', usable: `[...document.querySelectorAll('[data-media-body] img')].some((img) => img.naturalWidth > 0)` },
  video: { name: 'Practice clip.mp4', usable: `[...document.querySelectorAll('video')].some((v) => v.readyState >= 2)` },
  text: { name: 'Practice notes.txt', usable: `!!document.querySelector(${JSON.stringify(TEXT_EDITOR)})?.getClientRects().length` }
} as const
type Kind = keyof typeof KINDS

/** Puts the kind's dummy in the shape's holder, once. A document is made on box, where its service keeps it. */
async function dummy(ctx: PerfCtx, shape: Shape, kind: Kind): Promise<string> {
  const { name } = KINDS[kind]
  const file = fileAt(ctx.at(shape), name)
  if (existsSync(file)) return name
  const fixture = (path: string): void => copyFileSync(join(ctx.repo, path), file)
  if (kind === 'word') fixture('src/main/server/work/templates/fixtures/split.docx')
  else if (kind === 'workbook') fixture('src/main/server/work/sheets/harness/corpus/formulas.xlsx')
  else if (kind === 'deck') fixture('src/main/server/work/slides/fixtures/kinds.pptx')
  else if (kind === 'pdf') writeFileSync(file, dummyPdf())
  else if (kind === 'image') fixture('src/main/server/work/money/fixtures/gear.png')
  else if (kind === 'video') fixtureTool(ctx.folder, 'ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24', '-t', '4', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', file])
  else if (kind === 'text') writeFileSync(file, 'Original practice notes')
  else {
    // New → Document, named in the list as he would.
    await shown(ctx, shape)
    await ctx.page.press('button', 'New')
    await ctx.page.press('menuitem', 'Document')
    await ctx.page.until('the new document name field', 20_000, () => ctx.page.eval('document.activeElement?.matches("[data-files-row] input")'))
    await ctx.page.typeKeys(name.replace(/\.tcdoc$/, ''))
    await ctx.page.key('Enter')
  }
  return name
}

const open = (kind: Kind, shape: Shape): Row => ({
  id: `open-${kind}-${shape}`,
  title: `Open a ${kind} from the list to a thing he can use (${shape})`,
  needs: needs(shape),
  run: async (ctx) => {
    const name = await dummy(ctx, shape, kind)
    return thrice(ctx, async () => {
      const at = await ctx.page.steadyPoint(name + ' row', () => rowAt(ctx.page, name), 40_000)
      return { region: '[data-files-file], [data-files-main]', usable: KINDS[kind].usable, press: () => ctx.page.click(at, 2), wait: 90_000 }
    }, async (i) => {
      if (i > 0) await closeSelectedFile(ctx.page)
      await shown(ctx, shape)
    }).finally(() => closeSelectedFile(ctx.page).catch(() => undefined))
  }
})

const tab = (kind: Kind): Row => ({
  id: `tab-${kind}-A`,
  title: `Return to an open ${kind}'s tab from the folder's tab`,
  needs: needs('A'),
  run: async (ctx) => {
    const name = await dummy(ctx, 'A', kind)
    await shown(ctx, 'A')
    await openRow(ctx.page, name)
    await ctx.page.until(`the ${kind} open`, 90_000, () => ctx.page.eval(KINDS[kind].usable))
    return thrice(ctx, () => ({
      region: '[data-files-file], [data-files-main]',
      usable: KINDS[kind].usable,
      press: () => ctx.page.clickOn('[data-files-tab][data-tab-kind="file"]')
    }), async () => {
      await selectFolderTab(ctx.at('A'))
      await ctx.page.until('the folder tab shown', 20_000, () => ctx.page.eval(`!(${KINDS[kind].usable})`))
    }).finally(() => closeSelectedFile(ctx.page).catch(() => undefined))
  }
})

const saved = (shape: Shape): Row => ({
  id: 'saved-text-' + shape,
  title: `Type in a text file: the first key to a save line that says saved (${shape})`,
  needs: needs(shape),
  run: async (ctx) => {
    const name = await dummy(ctx, shape, 'text')
    await shown(ctx, shape)
    await openRow(ctx.page, name)
    await ctx.page.until('the text editor', 60_000, () => ctx.page.centre(TEXT_EDITOR))
    return thrice(ctx, async (i) => {
      await ctx.page.clickOn(TEXT_EDITOR)
      await ctx.page.key('Control+End')
      // The line must first say something other than saved, or the old line would pass.
      return {
        region: '[data-files-save-line]',
        usable: `window.__perfDirty === true && /^Saved/.test([...document.querySelectorAll('[data-files-save-line]')].find((e) => e.getClientRects().length)?.textContent.trim() ?? '')`,
        press: async () => {
          await ctx.page.eval(`(() => {
            window.__perfDirty = false;
            const seen = new MutationObserver(() => {
              const line = [...document.querySelectorAll('[data-files-save-line]')].find((e) => e.getClientRects().length)?.textContent.trim() ?? '';
              if (!/^Saved/.test(line)) { window.__perfDirty = true; seen.disconnect(); }
            });
            seen.observe(document.body, { subtree: true, childList: true, characterData: true });
          })()`)
          await ctx.page.typeKeys(` note ${i}`)
        },
        wait: 60_000
      }
    }).finally(() => closeSelectedFile(ctx.page).catch(() => undefined))
  }
})

/** Ask beside a file: the press to a box he can type in, then his first words to the first content back. */
const askBox: Row = {
  id: 'ask-box',
  title: 'Press Ask on an open file: to a box he can type in',
  needs: { fake: true },
  run: (ctx) => thrice(ctx, () => ({
    region: '[data-files-dock]',
    usable: `!!document.querySelector('[data-files-dock] ${INPUT}')?.getClientRects().length`,
    press: () => ctx.page.clickOn('[data-files-header] button', 'Ask')
  }), async (i) => {
    const file = fileAt(ctx.at('A'), `Practice ask ${i + 1}.txt`)
    writeFileSync(file, 'A dummy agenda for the park')
    if (i > 0) await closeSelectedFile(ctx.page)
    await shown(ctx, 'A')
    await openRow(ctx.page, `Practice ask ${i + 1}.txt`)
    await ctx.page.until('the file open', 40_000, () => ctx.page.centre('[data-files-header] button', 'Ask'))
  }).finally(() => closeSelectedFile(ctx.page).catch(() => undefined))
}

const askFirst: Row = {
  id: 'ask-first-content',
  title: "His first words in a file's chat: Send to the first content back (the loopback provider)",
  needs: { fake: true },
  run: (ctx) => thrice(ctx, async () => {
    await ctx.page.clickOn('[data-files-dock] ' + INPUT)
    await ctx.page.typeKeys('What time is practice?')
    return {
      region: '[data-files-dock]',
      usable: `document.querySelector('[data-files-dock]')?.innerText.includes('I have the practice list.')`,
      press: () => ctx.page.clickOn('[data-files-dock] button', 'Send'),
      wait: 60_000
    }
  }, async (i) => {
    const name = `Practice chat ${i + 1}.txt`
    writeFileSync(fileAt(ctx.at('A'), name), 'A dummy agenda for the park')
    if (i > 0) await closeSelectedFile(ctx.page)
    await shown(ctx, 'A')
    await openRow(ctx.page, name)
    await ctx.page.clickOn('[data-files-header] button', 'Ask')
    await ctx.page.until('the chat box', 40_000, () => ctx.page.centre('[data-files-dock] ' + INPUT))
  }).finally(() => closeSelectedFile(ctx.page).catch(() => undefined))
}

/** The link to box cut and given back: from the socket's return to the shown folder current, and what the window asks. */
const reconnect: Row = {
  id: 'reconnect',
  title: 'The link to the host lost for 5 s and back: the shown folder current again, and every ask the window makes',
  needs: { fake: true },
  run: (ctx) => {
    const host = JSON.stringify(ctx.pair.box.host)
    const open = `window.__docket.registry.statusOf(${host}).transport === 'open'`
    return thrice(ctx, () => ({
      region: '[data-files-view]',
      usable: `${open} && ${rows(1)}`,
      // No press of his: the stamp is the moment the link comes back.
      press: async () => {
        await ctx.page.eval('window.__perf.pressed = performance.now()')
        ctx.pair.cutWindowLink(false)
      },
      wait: 60_000
    }), async () => {
      await shown(ctx, 'A')
      ctx.pair.cutWindowLink(true)
      await ctx.page.until('the window to lose the link', 30_000, () => ctx.page.eval(`!(${open})`))
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }).finally(() => ctx.pair.cutWindowLink(false))
  }
}

export const FILE_ROWS: Row[] = [
  ...PLACES.flatMap((shape) => [list(shape), back(shape), search(shape)]),
  ...(['document', 'word', 'workbook', 'deck', 'pdf', 'image', 'video'] as const).flatMap((kind) =>
    (kind === 'document' ? (['A'] as Shape[]) : PLACES).map((shape) => open(kind, shape))),
  ...(['document', 'workbook', 'deck', 'pdf'] as const).map(tab),
  ...PLACES.map(saved),
  askBox, askFirst, reconnect
]
