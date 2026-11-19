import { join } from 'node:path'
import type { z } from 'zod'
import type { SessionMeta } from '@shared/events'
import { computerToolSpecs, type ComputerToolName } from '@shared/computer/tools'
import { workText, type WorkToolResult } from '@shared/work'
import { computerContent } from '../../../computer/mcp'
import type { ComputerRegistry } from '../../../computer/run'
import { ComputerService } from '../../../computer/service'
import { ComputerSessions } from '../../../computer/sessions'
import type { SettingsStore } from '../../../computer/verdicts'
import type { WorkCtx, WorkTool } from '../../modules'
import { DriveStore } from '../drive'
import { BoxChromium } from './chromium'
import { takeImports } from './logins'
import { BoxComputerService, inProcessSpawn } from './service'

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
  service: ComputerService
  sessions: ComputerSessions
}

let host: BoxBrowserHost | null = null
/** threads with a held step waiting on a page of the box browser: it is not stopped for idleness while one waits */
const waiting = new Map<string, number>()
const WAIT_MAX_MS = 24 * 3_600_000
/** while a page asks for him or he drives, he may be signing in there: the browser stays up, for at most two hours */
const ASKED_MAX_MS = 2 * 3_600_000
let started: WorkCtx | null = null

/** Something waits on a page of the box browser: a held step, or him. */
function busy(): boolean {
  const now = Date.now()
  if ([...waiting.values()].some((at) => now - at < WAIT_MAX_MS)) return true
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
export function wireBoxBrowser(o: { registry: BoxRegistry; store: SettingsStore; dataDir: string; log?: (line: string) => void }): BoxBrowserHost | null {
  const root = join(o.dataDir, 'work-browser', 'box')
  const log = o.log ?? ((line: string) => console.log(`[box browser] ${line}`))
  const browser = new BoxChromium({ root, log, busy })
  if (browser.unavailable()) return null
  const make = () => new BoxComputerService({ browser: { endpoint: () => browser.endpoint(), pid: () => browser.pid, touch: () => browser.touch() }, use: (cdp) => takeImports(root, cdp, log), log })
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
  o.registry.onRemoved((ids) => void sessions.end(ids))
  host = { root, browser, service, sessions }
  return host
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
    if (item.kind === 'computer.act' && item.sessionId) waiting.delete(item.sessionId)
  })
  return () => {
    off()
    started = null
    host?.browser.stop()
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
  "The box's own browser, Chromium, which runs on this host whatever Mac is awake: its app is \"Chromium\", each of its pages a window, and its address bar takes a web address and Return. Call browser_open first so the owner sees it beside the thread. A submit, a send or the like on its final screen is held for his press on its own: drive up to it and stop. Never type a password: call browser_needs_you. Below, \"the Mac\" and \"computer_*\" mean this browser and these box_browser_* tools.\n\n"

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
      if (spec.name !== 'computer_observe' && new DriveStore(ctx.db).get(pane).driver === 'owner') return { ...workText(BOX_OWNER_DRIVES), isError: true }
      const outcome = await h.sessions.run({ threadId: ctx.sessionId, signal: ctx.signal }, spec.name, args)
      // A step kept for his press: the page it waits on stays until he decides.
      if (!outcome.isError && !outcome.steps.length && (spec.name === 'computer_act' || spec.name === 'computer_batch')) waiting.set(ctx.sessionId, Date.now())
      return computerContent(outcome, 'parts')
    }
  }))
}
