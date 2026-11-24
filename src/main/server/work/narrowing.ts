import { errorText } from '@shared/work/ids'
import { WORK_TOOL_SERVER } from '@shared/work/tools'
import type { DatabaseSync } from 'node:sqlite'
import { WORK_LOAD_FAULTS, WORK_MODULES, type CallAsk, type WorkCtx, type WorkModule } from './modules'

/**
 * The frame's own mark of a narrowed thread (a mail chat): which pillar narrows it, kept where the frame reads it
 * without that pillar. A thread so marked whose pillar did not load, or could not make its tables, runs nothing: no
 * turn, no tool. Closed, never open.
 */
let marks: DatabaseSync | null = null
/** Pillars that loaded but could not make their tables this run (startWork). */
export const NARROWING_BROKEN = new Set<string>()
const PILLAR_NAMES: Record<string, string> = { mail: 'Mail' }

export function ensureNarrowMarks(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS work_narrowed (session_id TEXT PRIMARY KEY, module TEXT NOT NULL, at INTEGER NOT NULL)')
  marks = db
}

/** Marks a thread narrowed by `module`; the pillar's own row stays the pillar's. */
export function markNarrowed(db: DatabaseSync, sessionId: string, module: string, at = Date.now()): void {
  ensureNarrowMarks(db)
  db.prepare('INSERT OR IGNORE INTO work_narrowed (session_id, module, at) VALUES (?, ?, ?)').run(sessionId, module, at)
}

/** The words a thread marked by a pillar that is not here reads, for every turn and every tool; else null. */
export function unloadedRefusal(sessionId: string, db: DatabaseSync | null = marks): string | null {
  if (!db || !sessionId) return null
  try {
    const mark = db.prepare('SELECT module FROM work_narrowed WHERE session_id = ?')
    const up = db.prepare('SELECT parent_id, started_by FROM sessions WHERE id = ?')
    // The thread, then what it hangs under (a subagent, a thread it started), as the pillar reads it.
    let id: string | null = sessionId
    for (let hop = 0; id && hop < 32; hop++) {
      const row = mark.get(id) as { module: string } | undefined
      if (row) {
        if (!WORK_LOAD_FAULTS.has(row.module as never) && !NARROWING_BROKEN.has(row.module)) return null
        const name = PILLAR_NAMES[row.module] ?? row.module
        return `${name} did not load on this computer, so this chat cannot run. Open it once ${name} is back.`
      }
      const next = up.get(id) as { parent_id: string | null; started_by: string | null } | undefined
      id = next?.parent_id ?? next?.started_by ?? null
    }
    return null
  } catch {
    return null
  }
}

/**
 * A pillar narrowing one thread's powers (docs/agents/work.md "Narrowing a
 * thread"): the frame's two asks of every module. The mail chat is the first
 * to answer (mail/chat/refusal.ts).
 */

/** What the model reads when a module's check itself failed: the call is refused, never let through unchecked. */
export const REFUSED_UNCHECKED = 'This call was refused: the host could not check whether this thread may make it. Carry on without it.'

/** The first module's words refusing the call, or null when every module lets it run. A module that throws refuses it. */
export function callRefusalOf(modules: readonly WorkModule[], ctx: WorkCtx, call: CallAsk, log: (line: string) => void = ctx.log): string | null {
  const unloaded = unloadedRefusal(call.sessionId)
  if (unloaded) return unloaded
  for (const module of modules) {
    if (!module.callRefusal) continue
    try {
      const why = module.callRefusal(ctx, call)
      if (why) return why
    } catch (err) {
      log(`work: ${module.id}'s check on ${call.server}/${call.tool} failed, so the call is refused: ${errorText(err)}`)
      return REFUSED_UNCHECKED
    }
  }
  return null
}

/** What a thread is denied when a module's check on it threw: no shell, no file writes, no web, no subagent. Closed, never open. */
export const DENIED_UNCHECKED: readonly string[] = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Workflow', 'DesignSync']

/** Every harness tool some module denies this thread, read at its harness's start. A module that throws is logged and the thread is denied `DENIED_UNCHECKED`. */
export function harnessDeniedOf(sessionId: string, modules: readonly WorkModule[] = WORK_MODULES, log: (line: string) => void = (line) => console.error(`[work] ${line}`)): string[] {
  // A thread its pillar would narrow, with that pillar not here: every harness tool the frame knows to deny.
  if (unloadedRefusal(sessionId)) return [...DENIED_UNCHECKED]
  const denied = new Set<string>()
  for (const module of modules) {
    if (!module.harnessDenied) continue
    try {
      for (const tool of module.harnessDenied(sessionId)) denied.add(tool)
    } catch (err) {
      log(`${module.id}'s harness denial for ${sessionId} failed, so the thread starts narrowed: ${errorText(err)}`)
      for (const tool of DENIED_UNCHECKED) denied.add(tool)
    }
  }
  return [...denied]
}

/**
 * What a narrowed thread (one some pillar's `harnessDenied` names anything for) may reach beyond its harness: the
 * Work tools and LifeOS, both checked call by call (`callRefusal`), and of the app's own tools only its notes and
 * decisions and citations: no other thread's words. No page tool (a page may fetch from the web), no thread or agent, no
 * add-on or skill change, no desktop and no Mac: refused by server and name on Claude Code's fence, by method on the
 * app bridge.
 */
export const NARROWED_APP_TOOLS: readonly string[] = ['update_notes', 'note_decision', 'cite_source']
export const NARROWED_SERVERS: readonly string[] = [WORK_TOOL_SERVER, 'lifeos']
export const NARROWED_BRIDGE_METHODS: readonly string[] = [
  'app.updateNotes',
  'app.noteDecision',
  'app.citeSource',
  'app.addonFind',
  'app.addonCall',
  'app.workTools',
  'app.workCall',
  'app.workCancel'
]

/**
 * The harness's own tools a narrowed thread keeps: finding a deferred tool (LifeOS's are) and its own list. An
 * allow-list, so a built-in a CLI adds later (one that runs a command or opens a socket) is refused until named here.
 */
export const NARROWED_BUILTINS: readonly string[] = ['ToolSearch', 'TodoWrite']

/**
 * Why a narrowed thread may not call this Claude Code tool, or null. An add-on's tool on the app server
 * (`mcp__app__lifeos__…`) is the add-on gate's to judge call by call (`callRefusal`); LifeOS's alone passes here.
 */
export function narrowedToolRefusal(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return NARROWED_BUILTINS.includes(toolName) ? null : `${toolName} is not available in this thread.`
  const [server, ...rest] = toolName.slice('mcp__'.length).split('__')
  const tool = rest.join('__')
  if (server === 'app' ? NARROWED_APP_TOOLS.includes(tool) || tool.startsWith('lifeos__') : NARROWED_SERVERS.includes(server!)) return null
  return `${toolName} is not available in this thread.`
}

/** Why a narrowed thread may not make this app bridge call, or null. */
export const narrowedMethodRefusal = (method: string): string | null => (NARROWED_BRIDGE_METHODS.includes(method) ? null : `forbidden: ${method} is not available to this thread`)
