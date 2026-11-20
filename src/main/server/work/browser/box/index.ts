import { join } from 'node:path'
import type { z } from 'zod'
import type { SessionMeta } from '@shared/events'
import { computerToolSpecs, type ComputerToolName } from '@shared/computer/tools'
import { workText, type WorkToolResult } from '@shared/work'
import { computerContent } from '../../../computer/mcp'
import type { ComputerRegistry } from '../../../computer/run'
import { ComputerService } from '../../../computer/service'
import type { PreviewSessions, PreviewTarget } from '../../../computer/preview'
import { ComputerSessions } from '../../../computer/sessions'
import type { SettingsStore } from '../../../computer/verdicts'
import type { WorkCtx, WorkTool } from '../../modules'
import { DriveStore } from '../drive'
import type { ComputerSessionRow } from '@shared/contract-computer'
import type { VideoRelay } from '../../../video/relay'
import type { VideoRpc } from '../../../video/rpc'
import { BoxChromium } from './chromium'
import { BoxEngines } from './engine'
import { takeImports } from './logins'
import { BOX_BROWSER_APP, BoxComputerService, closedToAgents, inProcessSpawn } from './service'
import { BoxStage } from './stage'
import { BoxVideo } from './video'
import { videoToolsAt } from './videoSetting'

/**
 * The box's browser for Work threads (docs/agents/work-browser.md "The box's
 * browser"): the Linux service behind a computer service and sessions of its
 * own, so a box thread drives the box's Chromium through the same host code
 * as the Mac's computer use. A Work thread's step that the host reads on the
 * screen as a submit, a send or the like is held by run.ts's hold, whatever
 * the model flagged, and carried out on these sessions at the owner's press.
 */

export interface BoxBrowserHost {
  /** <dataDir>/work-browser/box: the profile, the import folder and the carrier's marker live here */
  root: string
  browser: BoxChromium
  /** where a headed browser's windows are and which is on top (stage.ts) */
  stage: BoxStage
  service: ComputerService
  sessions: ComputerSessions
  /** the browser as a source of live video (video.ts); null where the host gave it no relay */
  video: BoxVideo | null
  /** what the host lists and stops: the sessions' rows, and a row for each pane he drives himself */
  rows: Pick<ComputerSessions, 'rows' | 'onRows' | 'stop'>
  /** what the 4 fps picture is drawn from: a session's window, and the page of a pane he drives, which has no session */
  previews: PreviewSessions
}

let host: BoxBrowserHost | null = null
/** held steps waiting on a page of the box browser, by thread, each with when it was held: it is not stopped for idleness while one waits */
const waiting = new Map<string, number[]>()
/** calls in flight that use the browser outside the computer sessions (the Outlook on the web carrier's) */
let inUse = 0
const WAIT_MAX_MS = 24 * 3_600_000
/** while a page asks for him or he drives, he may be signing in there: the browser stays up, for at most two hours */
const ASKED_MAX_MS = 2 * 3_600_000
let started: WorkCtx | null = null

/** Something waits on a page of the box browser: a held step, a viewer of its video, or him. */
function busy(): boolean {
  const now = Date.now()
  if (inUse > 0 || [...waiting.values()].flat().some((at) => now - at < WAIT_MAX_MS)) return true
  if (host?.video?.inUse()) return true
  return !!started?.db
    .prepare("SELECT 1 FROM work_browser_drive WHERE (driver = 'owner' OR needs IS NOT NULL) AND since > ? LIMIT 1")
    .get(now - ASKED_MAX_MS)
}

export interface BoxRegistry extends ComputerRegistry {
  rootSessionOf(id: string): string
  onMeta(fn: (m: SessionMeta) => void): unknown
  onRemoved(fn: (ids: string[]) => void): unknown
}

/**
 * Made once at boot by index.ts on a Linux host whose computer use is not
 * local; null where there is no Chromium. `dataDir` is <userData>: the
 * profile lives in `work-browser/box/profile`, the service's pictures in
 * `work-browser/box/computer`.
 */
export interface BoxWiring {
  registry: BoxRegistry
  store: SettingsStore
  dataDir: string
  log?: (line: string) => void
  /** `work.browser.video` (video/settings.ts): off keeps the browser headless whatever is installed. Read at every start of the browser. */
  videoOn?: () => boolean
  /** the host's video relay and where a source is added; absent (a test of the browser alone) there is no video */
  video?: { relay: VideoRelay; rpc: Pick<VideoRpc, 'addSource'> }
  /** how long a page stays listed idle after its last act; IDLE_ROW_MS but in a test */
  idleMs?: number
}

export function wireBoxBrowser(o: BoxWiring): BoxBrowserHost | null {
  const root = join(o.dataDir, 'work-browser', 'box')
  const log = o.log ?? ((line: string) => console.log(`[box browser] ${line}`))
  const videoOn = (): boolean => o.videoOn?.() !== false
  // Headed for live video when the tools are installed and the setting is on (videoSetting.ts); read at every start of the browser.
  const browser = new BoxChromium({ root, log, busy, video: () => (videoOn() ? videoToolsAt(o.dataDir) : null) })
  if (browser.unavailable()) return null
  const stage = new BoxStage({ endpoint: () => browser.endpoint(), wm: () => browser.wm }, { closed: closedToAgents, log })
  const paneOf = (thread: string): string => {
    try {
      return o.registry.rootSessionOf(thread) || thread
    } catch {
      return thread
    }
  }
  /** the page each thread, and each pane, last used: what a stream shows after the session that used it stopped */
  const lastPage = new Map<string, string>()
  const make = () =>
    new BoxComputerService({
      browser: {
        endpoint: () => browser.endpoint(),
        pid: () => browser.pid,
        touch: () => browser.touch(),
        headed: () => stage.headed(),
        open: (url) => stage.open(url),
        ready: () => stage.ready(),
        scale: () => browser.scale
      },
      onPage: (session, targetId) => {
        // his own look at a page he drives is no thread's use of it
        if (session.startsWith(OWNER_SESSION)) return
        const thread = sessions.threadOfServiceSession(session) ?? session
        lastPage.set(thread, targetId)
        lastPage.set(paneOf(thread), targetId)
      },
      use: (cdp) => takeImports(root, cdp, log),
      log
    })
  const service = new ComputerService({
    dataDir: join(root, 'computer'),
    bin: () => 'box-browser',
    spawn: inProcessSpawn(make),
    unavailable: () => browser.unavailable()
  })
  const sessions = new ComputerSessions({
    service,
    registry: o.registry,
    store: o.store,
    dataDir: join(root, 'computer'),
    rootOf: (id) => o.registry.rootSessionOf(id),
    log
  })
  o.registry.onMeta((m) => sessions.onMeta(m))
  o.registry.onRemoved((ids) => {
    void sessions.end(ids)
    // a removed thread's page is no longer anyone's to open, and what plays of it ends
    for (const id of ids) {
      lastPage.delete(id)
      lastAct.delete(id)
    }
    video?.removed(ids)
  })

  // A headed browser's pages are the stage's windows, and it knows when one closed. A headless one has no stage:
  // there a page a thread used is taken to be open for as long as the browser runs.
  const pageOf = (thread: string): string | null => {
    const target = lastPage.get(thread) ?? lastPage.get(paneOf(thread))
    return target && (stage.headed() ? stage.knows(target) : browser.running) ? target : null
  }
  const drives = (pane: string): boolean => !!started && new DriveStore(started.db).get(pane).driver === 'owner'
  let video: BoxVideo | null = null
  const engines = new BoxEngines({ root, tools: () => browser.tools, display: () => browser.display, log })
  if (o.video) {
    video = new BoxVideo({
      browser,
      stage,
      engines,
      relay: o.video.relay,
      pageOf,
      paneOf,
      drives,
      urlOf: (targetId) => stage.urlOf(targetId),
      closed: closedToAgents,
      setting: videoOn,
      installed: () => videoToolsAt(o.dataDir) !== null,
      log
    })
    o.video.rpc.addSource(video)
  }
  browser.onStop(() => {
    // the display goes with the browser: its streams end, its engines stop, and no page of it is left to show
    video?.stopped()
    void engines.stopAll()
    lastPage.clear()
    stage.close()
    rowsChanged()
  })

  // A pane he drives has no session (Take over stops it), so the host would list nothing for it: a row is kept, so
  // every list can show the page with Hand back, and its video can be asked for by the pane's own thread.
  const rowListeners = new Set<(rows: ComputerSessionRow[]) => void>()
  const ownerRows = (live: ComputerSessionRow[]): ComputerSessionRow[] => {
    if (!started) return []
    const rows = started.db.prepare("SELECT session_id, since FROM work_browser_drive WHERE driver = 'owner'").all() as { session_id: string; since: number }[]
    return rows.flatMap((r) =>
      pageOf(r.session_id) && !live.some((l) => paneOf(l.threadId) === r.session_id)
        ? [{ threadId: r.session_id, since: r.since, lastCallAt: r.since, apps: [{ name: BOX_BROWSER_APP.name, bundleId: BOX_BROWSER_APP.bundleId, window: null }], running: null, tier: null, driver: 'owner' as const }]
        : []
    )
  }
  // A pane's page after its last act stays listed for IDLE_ROW_MS, idle, so he can still watch it and take over;
  // its picture is the one the session last read, on the service session that only looks, as for a pane he drives.
  const lastAct = new Map<string, { since: number; at: number }>()
  const idleMs = o.idleMs ?? IDLE_ROW_MS
  let idleTimer: NodeJS.Timeout | null = null
  const idleNow = (pane: string, now = Date.now()): boolean => {
    const act = lastAct.get(pane)
    return !!act && now - act.at < idleMs
  }
  const idleRows = (live: ComputerSessionRow[], now = Date.now()): ComputerSessionRow[] =>
    [...lastAct].flatMap(([pane, act]) =>
      idleNow(pane, now) && !drives(pane) && pageOf(pane) && !live.some((l) => paneOf(l.threadId) === pane)
        ? [{ threadId: pane, since: act.since, lastCallAt: act.at, apps: [{ name: BOX_BROWSER_APP.name, bundleId: BOX_BROWSER_APP.bundleId, window: null }], running: null, tier: null, idle: true as const }]
        : []
    )
  /** The next idle row to end ends on time: the rows are told, and its look at the page is closed. */
  const scheduleIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    const now = Date.now()
    for (const [pane, act] of lastAct) {
      if (now - act.at < idleMs) continue
      lastAct.delete(pane)
      if (!drives(pane)) void service.request('session.close', { session: OWNER_SESSION + pane }).catch(() => {})
    }
    const next = Math.min(...[...lastAct.values()].map((a) => a.at + idleMs))
    if (Number.isFinite(next))
      idleTimer = setTimeout(() => {
        scheduleIdle()
        rowsChanged()
      }, next - now)
    idleTimer?.unref?.()
  }
  const allRows = (): ComputerSessionRow[] => {
    const live = sessions.rows()
    // a session still live in a pane he has just taken is his page already: its row says so until the session is stopped
    const rows = [...live.map((r) => (drives(paneOf(r.threadId)) ? { ...r, driver: 'owner' as const } : r)), ...ownerRows(live), ...idleRows(live)]
    return rows.map((r) => ({ ...r, computer: `browser:${paneOf(r.threadId)}` }))
  }
  const rowsChanged = (): void => {
    if (!rowListeners.size) return
    const rows = allRows()
    for (const fn of rowListeners) fn(rows)
  }
  sessions.onRows((live) => {
    // a session's last act is its pane's: the page is listed idle from when that session ends
    for (const r of live) {
      const pane = paneOf(r.threadId)
      const was = lastAct.get(pane)
      lastAct.set(pane, { since: was && was.at >= r.since ? was.since : r.since, at: Math.max(was?.at ?? 0, r.lastCallAt) })
    }
    scheduleIdle()
    rowsChanged()
  })
  const rows: BoxBrowserHost['rows'] = {
    rows: allRows,
    onRows: (fn) => {
      rowListeners.add(fn)
      return () => rowListeners.delete(fn)
    },
    // a pane he drives has nothing to stop: Hand back is how it ends
    stop: (threadId) => (sessions.rowOf(threadId) ? sessions.stop(threadId) : Promise.resolve(false))
  }
  // The 4 fps picture of a pane he drives. Take over stops the pane's sessions, and the picture was a session's: it
  // goes on from the window that session last read, on a session of the service that only looks, until he hands back.
  const lastTarget = new Map<string, PreviewTarget>()
  const targetListeners = new Set<(threadId: string) => void>()
  const ownerTarget = (thread: string): PreviewTarget | null => {
    const kept = lastTarget.get(thread)
    return kept && (drives(thread) || idleNow(thread)) && pageOf(thread) ? { ...kept, serviceSession: OWNER_SESSION + thread } : null
  }
  sessions.onTarget((thread) => {
    const target = sessions.previewTarget(thread)
    if (!target) return
    lastTarget.set(thread, target)
    lastTarget.set(paneOf(thread), target)
  })
  const previews: PreviewSessions = {
    previewTarget: (thread) => sessions.previewTarget(thread) ?? ownerTarget(thread),
    onTarget: (fn) => {
      targetListeners.add(fn)
      const off = sessions.onTarget(fn)
      return () => {
        targetListeners.delete(fn)
        off()
      }
    },
    onRows: rows.onRows,
    ensureOpen: async (thread) => {
      if (sessions.previewTarget(thread)) return sessions.ensureOpen(thread)
      await service.request('session.open', { session: OWNER_SESSION + thread })
      return OWNER_SESSION + thread
    }
  }
  driveChanged = (pane, owner) => {
    const told = (): void => {
      rowsChanged()
      // the pane's picture is drawn from another session of the service now
      for (const fn of targetListeners) fn(pane)
    }
    if (!owner) {
      // handed back, the page is idle until the agent acts again, and his look at it goes on while it is listed
      lastAct.set(pane, { since: lastAct.get(pane)?.since ?? Date.now(), at: Date.now() })
      scheduleIdle()
    }
    return (video ? video.driver(pane, owner) : Promise.resolve()).then(told, told)
  }
  browser.onStop(() => {
    lastTarget.clear()
    lastAct.clear()
    scheduleIdle()
  })
  host = { root, browser, stage, service, sessions, video, rows, previews }
  return host
}

/** How long a pane's page stays listed after its last act (or his Hand back), idle. */
export const IDLE_ROW_MS = 10 * 60_000

/** The service session his own look at a pane's page runs on, by the pane. */
const OWNER_SESSION = 'owner:'

/** Told who drives a pane each time it changes (work/browser `computer.drive`, and a pane's thread being removed); resolves once the picture's driver has changed. */
let driveChanged: (pane: string, owner: boolean) => Promise<void> = async () => {}
export function boxDriveChanged(pane: string, owner: boolean): Promise<void> {
  return driveChanged(pane, owner)
}

/** The box browser of this host, once wired. A test sets its own. */
export const boxBrowser = (): BoxBrowserHost | null => host
export const setBoxBrowser = (h: BoxBrowserHost | null): void => {
  host = h
  waiting.clear()
}

/** Work started on this host: a held step that is decided lets its page go when the browser is next idle. */
export function startBoxBrowser(ctx: WorkCtx): () => void {
  started = ctx
  const off = ctx.held.onDecided((item) => {
    if (item.kind !== 'computer.act' || !item.sessionId) return
    const left = (waiting.get(item.sessionId) ?? []).slice(1)
    if (left.length) waiting.set(item.sessionId, left)
    else waiting.delete(item.sessionId)
  })
  return () => {
    off()
    started = null
    host?.browser.stop()
  }
}

const ownerDrives = (db: WorkCtx['db']): boolean => !!db.prepare("SELECT 1 FROM work_browser_drive WHERE driver = 'owner' LIMIT 1").get()

/** Use of the browser outside the computer sessions: it stays up, and its idle clock restarts, until the returned `done`. */
export function useBoxBrowser(): () => void {
  inUse++
  host?.browser.touch()
  let done = false
  return () => {
    if (done) return
    done = true
    inUse--
    host?.browser.touch()
  }
}

export const BOX_OWNER_DRIVES = 'He is driving the browser now. Do not use the box browser until he hands it back; end your turn and say where you will pick up.'

const NAMES: Record<ComputerToolName, string> = {
  computer_apps: 'box_browser_open',
  computer_observe: 'box_browser_observe',
  computer_act: 'box_browser_act',
  computer_batch: 'box_browser_batch'
}

const LEAD =
  "The box's own browser, Chromium, which runs on this host whatever Mac is awake: its app is \"Chromium\", each of its pages a window, and its address bar takes a web address and Return. Call browser_open first so the owner sees it beside the thread. A submit, a send or the like on its final screen is held for his press on its own: drive up to it and stop. Never type a password: call browser_needs_you. His mailbox (Outlook on the web) does not open here: use the office_* tools for his mail and calendar. A form drawn in an embedded frame is read, filled and clicked like the page around it: the frame is a group by its title, its controls under it. Below, \"the Mac\" and \"computer_*\" mean this browser and these box_browser_* tools.\n\n"

/** The four computer tools, renamed for the box browser and run on its sessions. Listed only where the box has one. */
export function boxBrowserTools(): WorkTool[] {
  if (!host) return []
  return computerToolSpecs('anthropic', 'act').map((spec) => ({
    name: NAMES[spec.name as ComputerToolName] ?? `box_${spec.name}`,
    description: LEAD + spec.description,
    input: spec.input as z.ZodType,
    readOnly: spec.name === 'computer_observe',
    async run(args, ctx): Promise<WorkToolResult> {
      const h = host
      if (!h) return { ...workText('refused: the box browser is not on this host'), isError: true }
      const pane = ctx.canvas.paneOf(ctx.sessionId)
      // One browser for every thread: while he drives any page of it, no thread acts in it.
      if (spec.name !== 'computer_observe' && (new DriveStore(ctx.db).get(pane).driver === 'owner' || ownerDrives(ctx.db))) return { ...workText(BOX_OWNER_DRIVES), isError: true }
      const outcome = await h.sessions.run({ threadId: ctx.sessionId, signal: ctx.signal }, spec.name, args)
      // A step kept for his press: the page it waits on stays until he decides, and what he judges is its kept picture, so the live one ends.
      if (!outcome.isError && !outcome.steps.length && (spec.name === 'computer_act' || spec.name === 'computer_batch')) {
        waiting.set(ctx.sessionId, [...(waiting.get(ctx.sessionId) ?? []), Date.now()])
        h.video?.held(pane)
      }
      return computerContent(outcome, 'parts')
    }
  }))
}
