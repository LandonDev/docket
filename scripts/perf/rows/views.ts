import { thrice, type PerfCtx, type Row } from '../lib/row'
import { BONES, settled, type Sample } from '../lib/probe'

const RAIL = 'nav [data-rail-path] button'
const VIEW = '[data-rail-row] > button > span.truncate'
const region = (label: string): string => `[role="region"][aria-label=${JSON.stringify(label)}]`

/** The views under a job in the rail, and the pages above the jobs. */
export const VIEWS = ['Mail', 'Files', 'Tasks', 'Agenda', 'Messages', 'People', 'Outbox', 'Money'] as const
const PLACES = [['Today', '[data-work-place="today"]'], ['Review', '[data-work-place="review"]']] as const

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
  run: (ctx) => thrice(ctx, () => ({
    region: region(label),
    usable: settled(region(label)),
    press: () => ctx.page.clickOn(VIEW, label)
  }), () => shown(ctx, label === 'Files' ? 'Mail' : 'Files'))
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

export const VIEW_ROWS: Row[] = [...VIEWS.map(view), ...PLACES.map(place), switchWorkspace, returned, launch]
