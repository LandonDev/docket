import type { DatabaseSync } from 'node:sqlite'
import { screenOfObservation, type Screen } from '@shared/computer/outward'
import type { ComputerAction } from '@shared/computer/protocol'
import type { MsFormFolder, MsFormWorkbook } from '@shared/contract-work-msforms'
import { workbookNameOf } from '@shared/work/msforms'
import { BOX_BROWSER_APP } from '../../browser/box/service'
import { BOX_OWNER_DRIVES, carrierComputer, type CarrierComputer } from '../../browser/box'
import { librariesHere, vmLibrariesHere } from '../../files/places/libraries'
import { workspaceHere } from '../../files/policy'
import { folderOf as folderOfLibrary, folderPageOf, folderServerPath } from '../place'
import { opsCarrier, type RowFacts } from './ops'
import type { FormsComputer } from './steps'
import { CarrierBusy, CarrierRefused, configureMsCarrier } from './types'

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

/**
 * A page the carrier drives is named by Chromium's own target id (`t:<target>`), never by the window number the
 * service gives it: every step asks which number that target has now, and a target that is gone is driven no more.
 */
const refOf = (target: string): string => `t:${target}`
const GONE = 'The page the carrier opened is gone. Nothing more was done on it.'
const UNCHECKED = 'The carrier refused: it acts only on the read it checked, and the page was read again since. Nothing was done in Forms.'

export function formsComputerOn(c: CarrierComputer): FormsComputer {
  /** The window number a ref's page has now, by its target. */
  const numberOf = async (ref: string): Promise<number> => {
    const target = ref.startsWith('t:') ? ref.slice(2) : null
    const page = target ? (await c.pages()).find((p) => p.target === target) : undefined
    if (!page) throw new Error(GONE)
    return page.window
  }
  /** The last read of each page, as the screen it answered and the window number it was read at: an act runs only on it. */
  const checked = new Map<string, { screen: Screen; window: number }>()
  const read = async (ref: string): Promise<Screen> => {
    checked.delete(ref)
    const n = await numberOf(ref)
    const window = `#${n}`
    // no picture of any page the carrier drives (review 21): the read is words alone
    const o = await c.run('computer_observe', { app: APP, window, full: true, screenshot: false })
    if (o.isError) {
      if ((o.body ?? '').includes(BOX_OWNER_DRIVES)) throw new CarrierBusy(BOX_OWNER_DRIVES)
      // a fixed sentence: the body may quote the page
      throw new Error('The box browser could not read the page.')
    }
    const screen = screenOfObservation(o.body ?? '', { bundleId: BOX_BROWSER_APP.bundleId, name: APP })
    if (!screen) throw new Error('The box browser\'s read of the page did not parse.')
    // the page is still the one read: a number given to another page meanwhile (a service started again) is no read of it
    if ((await numberOf(ref)) !== n) throw new Error(GONE)
    checked.set(ref, { screen, window: n })
    return screen
  }
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
        if (page) return refOf(page.target)
        await new Promise((r) => setTimeout(r, OPEN_EVERY_MS))
      }
      throw new Error('The box browser opened no window for the page.')
    },

    read,
    /**
     * Runs steps on the page by the read they were guarded against: that read must be the page's last, of the same
     * window, and an act uses it up (review 16). Another read since, of this page or another, refuses before anything runs.
     */
    async act(ref, screen: Screen, steps: readonly ComputerAction[]) {
      const last = checked.get(ref)
      if (!last || last.screen !== screen) throw new CarrierRefused(UNCHECKED)
      checked.delete(ref)
      if ((await numberOf(ref)) !== last.window) throw new CarrierRefused(UNCHECKED)
      const window = `#${last.window}`
      const o = steps.length === 1 ? await c.run('computer_act', { app: APP, window, screenshot: false, ...steps[0] }) : await c.run('computer_batch', { app: APP, window, screenshot: false, actions: steps })
      if (o.isError && (o.body ?? '').includes(BOX_OWNER_DRIVES)) throw new CarrierBusy(BOX_OWNER_DRIVES)
      // the page's own words stay out of what a stop says (review 21)
      return o.isError ? { ok: false } : { ok: true }
    },
    async windows() {
      return (await c.pages()).map((p) => ({ id: refOf(p.target), url: p.url, ...(p.opener ? { opener: refOf(p.opener) } : {}) }))
    },
    async close(ref) {
      checked.delete(ref)
      const n = await numberOf(ref).catch(() => null)
      if (n !== null) await c.close(n)
    },
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    fetch: async (ref, url, o) => c.fetch(await numberOf(ref), url, o),
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

const parse = <T>(v: unknown): T | null => {
  try {
    return typeof v === 'string' && v ? (JSON.parse(v) as T) : null
  } catch {
    return null
  }
}

/**
 * A form as the pillar's own rows and this host's libraries say it is, read inside the queue: the job and rev a grant
 * must name, and the folder and workbook a pull must be of (review 15).
 */
export function rowFactsOf(ctx: { db: DatabaseSync; host: string }) {
  return (formId: string): RowFacts | null => {
    // one row a form id: two jobs keeping the same form is no form the carrier can be sure of
    const rows = ctx.db.prepare('SELECT workspace_id, rev, title, folder, workbook FROM work_msforms WHERE form_id = ? LIMIT 2').all(formId) as { workspace_id: string; rev: number; title: string; folder: string; workbook: string | null }[]
    if (rows.length !== 1) return null
    const r = rows[0]!
    const folder = parse<MsFormFolder>(r.folder)
    const workbook = parse<MsFormWorkbook>(r.workbook)
    const library = folder ? [...librariesHere(ctx), ...vmLibrariesHere(ctx)].find((l) => l.id === folder.libraryId) : undefined
    const server = folder && library ? folderServerPath(folder, library.web) : null
    return {
      workspaceId: r.workspace_id,
      rev: Number(r.rev),
      pull: folder && server ? { siteUrl: folder.siteUrl, folderServerPath: server, uniqueId: workbook?.uniqueId ?? null, name: workbook?.name ?? workbookNameOf(r.title) } : null
    }
  }
}

/** The folder's SharePoint page as this host makes it, from the library it reaches, for a Work job of this host. */
export function folderPagesOf(ctx: { db: DatabaseSync; host: string }) {
  return (workspaceId: string, at: { libraryId: string; path: string }): { url: string } | null => {
    if (!workspaceHere(ctx.db, workspaceId)) return null
    const library = [...librariesHere(ctx), ...vmLibrariesHere(ctx)].find((l) => l.id === at.libraryId)
    const folder = library ? folderOfLibrary(library, at.path) : null
    if (!library || !folder || folder.path !== at.path) return null
    const url = folderPageOf(folder, library.web)
    return url ? { url } : null
  }
}

/** Set once at boot on a host with the box browser. */
export function wireMsCarrier(db: DatabaseSync, host: string): void {
  const exclusive = exclusiveOn(carrierComputer)
  // Every operation's computer is the session made for it; `computer` below forwards to the one running now.
  let current: FormsComputer | null = null
  // TC_CARRIER_DEBUG: each call to the page timed, for a proof's own log (names and times, never the page's words)
  const timed = <T>(what: string, run: () => Promise<T>): Promise<T> => {
    if (!process.env.TC_CARRIER_DEBUG) return run()
    const t0 = Date.now()
    return run().finally(() => console.error(`[carrier] ${new Date().toISOString()} ${what} ${Date.now() - t0} ms`))
  }
  const forward: FormsComputer = {
    open: (u) => timed('open', () => current!.open(u)),
    read: (w) => timed('read', () => current!.read(w)),
    act: (w, s, steps) => timed(`act ${steps.map((x) => x.action).join('+')}`, () => current!.act(w, s, steps)),
    windows: () => current!.windows(),
    close: (w) => timed('close', () => current!.close(w)),
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
      rowOf: rowFactsOf({ db, host }),
      folderOf: folderPagesOf({ db, host })
    })
  )
}
