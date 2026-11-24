import type { DatabaseSync } from 'node:sqlite'
import { screenOfObservation, type Screen } from '@shared/computer/outward'
import type { ComputerAction } from '@shared/computer/protocol'
import { BOX_BROWSER_APP } from '../../browser/box/service'
import { BOX_OWNER_DRIVES, carrierComputer, type CarrierComputer } from '../../browser/box'
import { opsCarrier } from './ops'
import type { FormsComputer } from './steps'
import { CarrierBusy, configureMsCarrier } from './types'

/**
 * The carrier on this host's box browser (docs/agents/work-msforms.md "The
 * carrier"): one operation at a time, each on a session of its own that only
 * host code makes (`carrierComputer`, the only session Forms pages open to),
 * ended after the operation. Refused while he drives the box browser.
 */

const APP = BOX_BROWSER_APP.name

/** The box browser's carrier session as the carrier's computer. */
/** How long a page-open waits for its page to show: 20 looks, a quarter second apart. */
export const OPEN_TRIES = 20
export const OPEN_EVERY_MS = 250

export function formsComputerOn(c: CarrierComputer): FormsComputer {
  const read = async (window: string): Promise<Screen> => {
    // no picture of any page the carrier drives (review 21): the read is words alone
    const o = await c.run('computer_observe', { app: APP, window, full: true, screenshot: false })
    if (o.isError) {
      if ((o.body ?? '').includes(BOX_OWNER_DRIVES)) throw new CarrierBusy(BOX_OWNER_DRIVES)
      // a fixed sentence: the body may quote the page
      throw new Error('The box browser could not read the page.')
    }
    const screen = screenOfObservation(o.body ?? '', { bundleId: BOX_BROWSER_APP.bundleId, name: APP })
    if (!screen) throw new Error('The box browser\'s read of the page did not parse.')
    return screen
  }
  const windowOf = (ref: string): number => Number(ref.replace(/^#/, ''))
  return {
    async open(url) {
      // Pages are matched by Chromium's own target id: the service numbers windows afresh when it starts again (a
      // host or browser restart between the two lists), so a number seen before may name another page after.
      const before = new Map((await c.pages()).map((p) => [p.target, p.url]))
      const o = await c.run('computer_apps', { launch: APP, open: [url] })
      if (o.isError) throw new Error('The box browser did not open the page.')
      // A new page, or the blank page the launch used for it (a browser just started has one, P1): its address moves
      // off about:blank once the navigation commits, which may come after the launch answered.
      for (let tries = 0; tries < OPEN_TRIES; tries++) {
        const now = await c.pages()
        const page = now.filter((p) => !before.has(p.target)).at(-1) ?? now.find((p) => before.get(p.target)?.startsWith('about:blank') && !p.url.startsWith('about:blank'))
        if (page) return `#${page.window}`
        await new Promise((r) => setTimeout(r, OPEN_EVERY_MS))
      }
      throw new Error('The box browser opened no window for the page.')
    },

    read,
    async act(window, _screen: Screen, steps: readonly ComputerAction[]) {
      const o = steps.length === 1 ? await c.run('computer_act', { app: APP, window, screenshot: false, ...steps[0] }) : await c.run('computer_batch', { app: APP, window, screenshot: false, actions: steps })
      if (o.isError && (o.body ?? '').includes(BOX_OWNER_DRIVES)) throw new CarrierBusy(BOX_OWNER_DRIVES)
      // the page's own words stay out of what a stop says (review 21)
      return o.isError ? { ok: false } : { ok: true }
    },
    async windows() {
      return (await c.pages()).map((p) => ({ id: `#${p.window}`, url: p.url }))
    },
    close: (window) => c.close(windowOf(window)),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    fetch: (window, url, o) => c.fetch(windowOf(window), url, o),
    clearData: (origins: readonly string[]) => c.clear(origins)
  } as FormsComputer
}

let queue: Promise<unknown> = Promise.resolve()

/** Runs one operation after the one before it, on a fresh carrier session ended after it. */
export function exclusiveOn(make: () => CarrierComputer | null) {
  return <T>(fn: (computer: FormsComputer) => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      const c = make()
      if (!c) throw new CarrierBusy('The box browser is not running on this computer.')
      try {
        return await fn(formsComputerOn(c))
      } finally {
        await c.end().catch(() => {})
      }
    })
    queue = run.catch(() => {})
    return run
  }
}

/** The workspace each form or folder page belongs to, from the pillar's own rows: what an authorization must name. */
function workspaceOfRows(db: DatabaseSync) {
  return (at: { formId: string }): { workspaceId: string; rev: number } | null => {
    // one row a form id: two jobs keeping the same form is no form the carrier can be sure of
    const rows = db.prepare('SELECT workspace_id, rev FROM work_msforms WHERE form_id = ? LIMIT 2').all(at.formId) as { workspace_id: string; rev: number }[]
    return rows.length === 1 ? { workspaceId: rows[0]!.workspace_id, rev: Number(rows[0]!.rev) } : null
  }
}

/** Set once at boot on a host with the box browser. */
export function wireMsCarrier(db: DatabaseSync, host: string): void {
  const exclusive = exclusiveOn(carrierComputer)
  // Every operation's computer is the session made for it; `computer` below forwards to the one running now.
  let current: FormsComputer | null = null
  const forward: FormsComputer = {
    open: (u) => current!.open(u),
    read: (w) => current!.read(w),
    act: (w, s, steps) => current!.act(w, s, steps),
    windows: () => current!.windows(),
    close: (w) => current!.close(w),
    wait: (ms) => current!.wait(ms),
    fetch: (w, u, o) => current!.fetch(w, u, o),
    clearData: (o: readonly string[]) => (current as { clearData?: (o: readonly string[]) => Promise<void> })?.clearData?.(o) ?? Promise.resolve()
  } as FormsComputer
  configureMsCarrier(
    opsCarrier({
      computer: forward,
      host,
      exclusive: (fn) =>
        exclusive(async (c) => {
          current = c
          try {
            return await fn()
          } finally {
            current = null
          }
        }),
      workspaceOf: workspaceOfRows(db)
    })
  )
}
