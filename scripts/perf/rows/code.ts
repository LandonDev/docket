/**
 * The rest of Docket, in his shape (`bun run perf --family code`): a window paired to a box that holds a plain
 * workspace on a scratch repo and the seeded threads (scripts/perf/seed-box.ts), 40 plain threads streaming beside.
 * Each row is one thing he does outside Work; `scripts/perf/budgets.ts` (D, G and L) says which budget it times.
 */
import { SEED_SHORT, SEED_THREADS, SEED_WORKSPACE } from '../lib/seedNames'
import { thrice, type PerfCtx, type Row } from '../lib/row'

const RAIL = 'nav [data-rail-path] button'
const THREAD = '[data-thread-row] [data-row-open]'
const boxHost = (ctx: PerfCtx): string => JSON.stringify(ctx.pair.box.host)

/** A thread's pane with rows he can read: mounted, on screen, not loading, rows drawn. */
export const paneReady = (id: string): string => `(() => {
  const pane = document.querySelector('[data-session-drop=${JSON.stringify(id)}]');
  return !!pane && pane.getClientRects().length > 0 && !pane.closest('[inert], [aria-hidden="true"]')
    && !pane.querySelector('[data-transcript-loading], [data-transcript-empty]') && pane.querySelectorAll('[data-row]').length > 0;
})()`

const threadRow = (title: string): string => `[...document.querySelectorAll(${JSON.stringify(THREAD)})].some((b) => (b.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(title)}) && b.getClientRects().length)`

/** The seeded workspace shown in the rail, its threads listed. */
export async function shownCode(ctx: PerfCtx, title: string = SEED_THREADS.long.title): Promise<void> {
  const page = ctx.page
  await page.dismissPopups()
  if (!await page.centre(RAIL + '[aria-current="true"]', SEED_WORKSPACE)) await page.clickOn(RAIL, SEED_WORKSPACE)
  await page.until(`${title} in the column`, 30_000, async () => {
    if (await page.eval(threadRow(title))) return true
    // A project's threads sit under its card: open it once.
    const card = await page.centre('[data-project-card]', 'perf')
    if (card) await page.click(card)
    return false
  })
}

const pressThread = (ctx: PerfCtx, title: string) => async (): Promise<void> => {
  const at = await ctx.page.eval<{ x: number; y: number } | null>(`(() => {
    const row = [...document.querySelectorAll(${JSON.stringify(THREAD)})].find((b) => (b.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(title)}) && b.getClientRects().length);
    if (!row) return null;
    row.scrollIntoView({ block: 'nearest' });
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (!at) throw new Error(`No thread row "${title}" in the column`)
  await ctx.page.click(at)
}

/** The window's document started again and linked to box: every thread is unseen once more. */
async function fresh(ctx: PerfCtx): Promise<void> {
  await ctx.page.reload()
  await ctx.page.until('the window link to box again', 60_000, () => ctx.page.eval(
    `window.__docket?.registry.has(${boxHost(ctx)}) && window.__docket.registry.statusOf(${boxHost(ctx)}).transport === 'open'`))
}

/** D04, D05: a box thread not yet seen, from the rail, and the 15 s after it. */
const threadOpenFar: Row = {
  id: 'thread-open-far',
  family: 'code',
  title: 'Open the 30,000-row box thread from the rail, never seen by this window; then watch 15 s for a freeze',
  run: (ctx) => thrice(ctx, () => ({
    region: 'main',
    usable: paneReady(SEED_THREADS.long.id),
    press: pressThread(ctx, SEED_THREADS.long.title),
    settle: 15_000,
    wait: 60_000
  }), async () => {
    await fresh(ctx)
    await shownCode(ctx)
  })
}

/** D08: back and forth between two threads both seen. */
const threadSwitch: Row = {
  id: 'thread-switch',
  family: 'code',
  title: 'Switch between two threads this window has seen (a rail row)',
  run: async (ctx) => {
    const [a, b] = [SEED_SHORT[0]!, SEED_SHORT[1]!]
    await shownCode(ctx, a.title)
    for (const thread of [a, b, a]) {
      await pressThread(ctx, thread.title)()
      await ctx.page.until(thread.title + ' drawn', 30_000, () => ctx.page.eval(paneReady(thread.id)))
    }
    return thrice(ctx, (i) => {
      const to = i % 2 ? a : b
      return { region: 'main', usable: paneReady(to.id), press: pressThread(ctx, to.title) }
    })
  }
}

/** D09: the other workspace and back, each with a thread shown. */
const projectSwitch: Row = {
  id: 'project-switch',
  family: 'code',
  title: 'Switch to another workspace of the box and back to a thread seen',
  run: async (ctx) => {
    const thread = SEED_SHORT[0]!
    await shownCode(ctx, thread.title)
    await pressThread(ctx, thread.title)()
    await ctx.page.until(thread.title + ' drawn', 30_000, () => ctx.page.eval(paneReady(thread.id)))
    const current = (name: string): string => `[...document.querySelectorAll(${JSON.stringify(RAIL + '[aria-current="true"]')})].some((b) => b.textContent.trim() === ${JSON.stringify(name)})`
    return thrice(ctx, () => ({
      region: 'main, nav',
      usable: `${current(SEED_WORKSPACE)} && ${paneReady(thread.id)}`,
      press: () => ctx.page.clickOn(RAIL, SEED_WORKSPACE)
    }), async () => {
      await ctx.page.clickOn(RAIL, ctx.other.name)
      await ctx.page.until('the other workspace', 20_000, () => ctx.page.eval(current(ctx.other.name)))
    })
  }
}

export const CODE_ROWS: Row[] = [threadOpenFar, threadSwitch, projectSwitch]
