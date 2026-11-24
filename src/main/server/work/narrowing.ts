import { errorText } from '@shared/work/ids'
import { WORK_TOOL_SERVER } from '@shared/work/tools'
import { WORK_MODULES, type CallAsk, type WorkCtx, type WorkModule } from './modules'

/**
 * A pillar narrowing one thread's powers (docs/agents/work.md "Narrowing a
 * thread"): the frame's two asks of every module. The mail chat is the first
 * to answer (mail/chat/refusal.ts).
 */

/** What the model reads when a module's check itself failed: the call is refused, never let through unchecked. */
export const REFUSED_UNCHECKED = 'This call was refused: the host could not check whether this thread may make it. Carry on without it.'

/** The first module's words refusing the call, or null when every module lets it run. A module that throws refuses it. */
export function callRefusalOf(modules: readonly WorkModule[], ctx: WorkCtx, call: CallAsk, log: (line: string) => void = ctx.log): string | null {
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

/** Why a narrowed thread may not call this Claude Code MCP tool (`mcp__<server>__<tool>`), or null; a built-in is not this check's. */
export function narrowedToolRefusal(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null
  const [server, ...rest] = toolName.slice('mcp__'.length).split('__')
  const tool = rest.join('__')
  if (server === 'app' ? NARROWED_APP_TOOLS.includes(tool) : NARROWED_SERVERS.includes(server!)) return null
  return `${toolName} is not available in this thread.`
}

/** Why a narrowed thread may not make this app bridge call, or null. */
export const narrowedMethodRefusal = (method: string): string | null => (NARROWED_BRIDGE_METHODS.includes(method) ? null : `forbidden: ${method} is not available to this thread`)
