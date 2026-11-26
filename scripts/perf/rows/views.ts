import { revealView } from '../../journeys/lib/more'
import { thrice, type PerfCtx, type Row } from '../lib/row'
import { gone, paneReady, shownIn, typing, type Picker } from './code'
import { BONES, settled, type Sample } from '../lib/probe'

const RAIL = 'nav [data-rail-path] button'
const VIEW = '[data-rail-row] > button > span.truncate'
const region = (label: string): string => `[role="region"][aria-label=${JSON.stringify(label)}]`

/** The views under a job in the rail, and the pages above the jobs. */
export const VIEWS = ['Mail', 'Files', 'Tasks', 'Agenda', 'Messages', 'People', 'Outbox', 'Money'] as const
const PLACES = [['Today', '[data-work-place="today"]'], ['Projects', '[data-work-place="projects"]'], ['Review', '[data-work-place="review"]']] as const

async function shown(ctx: PerfCtx, label: string): Promise<void> {
  await ctx.pair.showWork(ctx.workspace, label)
  await ctx.page.until(label + ' drawn', 30_000, () => ctx.page.eval(settledNow(region(label))))
}

/** `settled` without the probe in the page: the launch row asks it of a document that has just started. */
export const settledNow = (selector: string): string => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getClientRects().length && !e.closest('[inert], [aria-hidden="true"]'));
  return !!el && !el.matches(${JSON.stringify(BONES)}) && !el.querySelector(${JSON.stringify(BONES)}) && (el.innerText ?? '').trim().length > 0;
})()`

const view = (label: typeof VIEWS[number]): Row => ({
  id: 'view-' + label,
  title: `Switch to ${label} from another view of the job (the first press is its first time)`,
  needs: { sandbox: true },
  run: (ctx) => thrice(ctx, async () => {
    // A view past the column's four daily rows sits under More: the fold is opened before the timed press, which is the view's own row.
    await revealView(ctx.page, VIEW, label)
    return { region: region(label), usable: settled(region(label)), press: () => ctx.page.clickOn(VIEW, label) }
  }, () => shown(ctx, label === 'Files' ? 'Mail' : 'Files'))
})

const place = ([label, root]: typeof PLACES[number]): Row => ({
  id: 'view-' + label,
  title: `Open ${label}, the page above the jobs, from a job's view`,
  needs: { sandbox: true },
  run: (ctx) => thrice(ctx, () => ({
    region: root,
    usable: settled(root),
    press: () => ctx.page.clickOn('nav button', label)
  }), () => shown(ctx, 'Files'))
})

const switched = (ctx: PerfCtx, name: string): string =>
  `[...document.querySelectorAll(${JSON.stringify(RAIL + '[aria-current="true"]')})].some((b) => b.textContent.trim() === ${JSON.stringify(name)}) && ${settled(region('Mail'))}`

/** A flip between two jobs: back within the 5 s a job's LifeOS session lives after he leaves it. */
const switchWorkspace: Row = {
  id: 'switch-workspace',
  title: 'Switch to another job and straight back (Mail shown in both)',
  needs: { sandbox: true },
  run: async (ctx) => {
    await shown(ctx, 'Mail')
    await ctx.pair.showWork(ctx.other, 'Mail')
    return thrice(ctx, () => ({
      region: 'main, [role="region"]',
      usable: switched(ctx, ctx.workspace.name),
      press: () => ctx.page.clickOn(RAIL, ctx.workspace.name)
    }), async (i) => {
      if (i > 0) await ctx.page.clickOn(RAIL, ctx.other.name)
      await ctx.page.until('the other job', 20_000, () => ctx.page.centre(RAIL + '[aria-current="true"]', ctx.other.name))
    })
  }
}

/** A return after he has been away from the job for longer than its session lives today. */
export const AWAY_MS = 7000
const returned: Row = {
  id: 'return',
  title: `Return to a job after ${AWAY_MS / 1000} s in another (its LifeOS session closed 5 s after he left)`,
  needs: { sandbox: true },
  run: async (ctx) => {
    await shown(ctx, 'Mail')
    return thrice(ctx, () => ({
      region: 'main, [role="region"]',
      usable: switched(ctx, ctx.workspace.name),
      press: () => ctx.page.clickOn(RAIL, ctx.workspace.name)
    }), async () => {
      await ctx.page.clickOn(RAIL, ctx.other.name)
      await ctx.page.until('the other job', 20_000, () => ctx.page.centre(RAIL + '[aria-current="true"]', ctx.other.name))
      await new Promise((resolve) => setTimeout(resolve, AWAY_MS))
    })
  }
}

/** The window's own launch: its document loaded again, timed from the navigation to the job's view drawn. */
const launch: Row = {
  id: 'launch',
  title: "The window's document from its start to the job's last view drawn (a reload: the main process is up)",
  needs: { sandbox: true },
  run: async (ctx) => {
    await shown(ctx, 'Mail')
    const watch = `(() => {
      const look = () => {
        if (window.__perfBoot) return;
        let ok = false;
        try { ok = ${settledNow(region('Mail'))}; } catch {}
        if (ok) window.__perfBoot = performance.now(); else requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    })()`
    // A script for new documents is put in only while the Page domain is on.
    await ctx.page.send('Page.enable')
    const { identifier } = await ctx.page.send('Page.addScriptToEvaluateOnNewDocument', { source: watch }) as { identifier: string }
    try {
      const samples: Sample[] = []
      for (let i = 0; i < 3 && !samples.some((sample) => sample.usable === null); i++) {
        ctx.counter.take()
        ctx.pair.windowLink?.reset()
        await ctx.page.reload()
        let error: string | undefined
        await ctx.page.until('the job drawn again', 60_000, () => ctx.page.eval('window.__perfBoot > 0')).catch((cause) => { error = String(cause?.message ?? cause) })
        const usable = await ctx.page.eval<number | null>('window.__perfBoot ?? null')
        const counts = ctx.counter.take()
        const wire = ctx.pair.windowLink?.reset()
        await new Promise((resolve) => setTimeout(resolve, 1000))
        samples.push({ first: null, usable, longest: 0, counts, after: ctx.counter.take(), ...(wire ? { wire: { up: wire.up, down: wire.down, turns: wire.turns } } : {}), ...(error ? { error } : {}) })
      }
      return samples
    } finally {
      await ctx.page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
    }
  }
}

const SHEET = '[data-slot=sheet-content]'
const digestDrawn = `(() => {
  const sheet = [...document.querySelectorAll(${JSON.stringify(SHEET)})].find((e) => e.getClientRects().length && !e.hasAttribute('data-ending-style'));
  return !!sheet && sheet.querySelector('[data-slot=sheet-title]')?.textContent.trim() === 'Digest' && ${settled(SHEET)};
})()`

/**
 * The Digest (B24) to its sheet drawn. The native menu's Go → Digest is the OS's and cannot be pressed over CDP, so
 * the row presses Settings → Work's "Open the digest", which opens the same sheet (`openDigestSheet`); the menu's
 * cold load of the digest's chunk is not in it.
 */
const digest: Row = {
  id: 'digest-open',
  title: 'Open the Digest (Settings → Work → Open the digest) to its sheet drawn',
  needs: { sandbox: true },
  run: (ctx) => thrice(ctx, () => ({ region: 'body', usable: digestDrawn, press: () => ctx.page.clickOn('[data-app-settings] button', 'Open the digest') }), async () => {
    await ctx.page.dismissPopups()
    await ctx.page.until('the Digest sheet closed', 10_000, async () => !await ctx.page.eval(digestDrawn))
    await ctx.page.eval(`window.dispatchEvent(new CustomEvent('docket:open-settings', { detail: 'work' }))`)
    await ctx.page.until('Open the digest', 20_000, () => ctx.page.centre('[data-app-settings] button', 'Open the digest'))
  }).finally(() => ctx.page.dismissPopups().catch(() => undefined))
}

/**
 * A Work thread of the job opened from its row in the column, to its rows: the first press a thread this window never
 * showed, the next two back to it from the Files view.
 */
const workThread: Row = {
  id: 'work-thread-open',
  title: "Open a Work thread from the job's column to its rows (the first press never seen)",
  needs: { sandbox: true, fake: true },
  run: async (ctx) => {
    const { id } = await ctx.pair.rpc<{ id: string }>(ctx.pair.box, 'session.create', {
      workspaceId: ctx.workspace.id, title: 'Practice cones', provider: 'claude', permission: 'auto', threadType: 'chat', scope: 'work'
    })
    await ctx.pair.rpc(ctx.pair.box, 'session.send', { sessionId: id, text: 'What time is practice?' }, 60_000)
    const row = `[data-work-thread=${JSON.stringify(id)}] [data-row-open]`
    return thrice(ctx, () => ({ region: 'main', usable: paneReady(id), press: () => ctx.page.clickOn(row), wait: 30_000 }), async () => {
      await shown(ctx, 'Files')
      await ctx.page.until('the thread in the column', 30_000, () => ctx.page.centre(row))
    })
  }
}

const SEARCH = '[data-work-search]'
/**
 * Work search (⌘⇧K, Ctrl+Shift+K here) opened three times to its field ready (a fresh profile has no Recent rows),
 * then five keys typed, each to the rows for what is typed with every source answered (`keyMs`, `asksPerKey`).
 */
const workSearch: Picker = {
  id: 'work-search',
  title: 'Open Work search (Ctrl+Shift+K) to its field ready; then type "sprin", a key at a time',
  region: SEARCH,
  shown: `${shownIn(SEARCH)} && !!document.activeElement?.closest(${JSON.stringify(SEARCH)})`,
  open: (ctx) => ctx.page.key('Control+Shift+K'),
  close: async (ctx) => {
    if (await ctx.page.eval(shownIn(SEARCH))) await ctx.page.key('Escape')
    await gone(ctx, 'Work search', SEARCH)
  },
  query: 'sprin',
  ready: (typed) => `document.querySelector('${SEARCH} input')?.value === ${JSON.stringify(typed)} && document.querySelectorAll('${SEARCH} [role="option"]').length > 0 && !document.querySelector('${SEARCH} [data-work-search-busy]')`
}
const searchRow: Row = {
  id: workSearch.id,
  title: workSearch.title,
  needs: { sandbox: true },
  run: async (ctx) => {
    await shown(ctx, 'Mail')
    const samples = await thrice(ctx, () => ({ region: workSearch.region, usable: workSearch.shown, press: () => workSearch.open(ctx) }), async (i) => {
      if (i > 0) await workSearch.close(ctx)
    })
    try {
      if (samples.length === 3 && samples.every((sample) => sample.usable !== null)) Object.assign(samples[2]!, await typing(ctx, workSearch))
    } finally {
      await workSearch.close(ctx)
    }
    return samples
  }
}

export const VIEW_ROWS: Row[] = [...VIEWS.map(view), ...PLACES.map(place), switchWorkspace, returned, launch, digest, workThread, searchRow]
