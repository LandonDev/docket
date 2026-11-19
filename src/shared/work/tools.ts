import { z, type ZodType } from 'zod'

/**
 * The tools Work gives a thread: one set for Claude, Codex and Muse. A
 * module answers them from `WorkModule.tools(scope)`; Claude gets them on an
 * MCP server named `work` (`withWorkTools`), Codex and Muse through the
 * bridge (`app.workTools`, `app.workCall`).
 */

/** The MCP server Claude's Work tools ride: a tool is `mcp__work__<name>` there. */
export const WORK_TOOL_SERVER = 'work'
export const workToolId = (name: string): string => `mcp__${WORK_TOOL_SERVER}__${name}`
/** Claude's limit on a tool's whole name. */
export const TOOL_ID_MAX = 64
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/

/** What is wrong with a tool's name, or null: lower snake case, and short enough once Claude wraps it. */
export function workToolNameProblem(name: string): string | null {
  if (!TOOL_NAME_RE.test(name)) return `${name}: a tool name is lower snake case`
  if (workToolId(name).length > TOOL_ID_MAX) return `${name}: ${workToolId(name)} is over ${TOOL_ID_MAX} characters`
  return null
}

/** A tool's answer: MCP's own result shape, passed to the harness whole. (A type, not an interface: the SDK's result type has an index signature.) */
export type WorkToolResult = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
  structuredContent?: Record<string, unknown>
}
export const WorkToolResultSchema = z.object({
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() })
    ])
  ),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional()
})
export const workText = (text: string): WorkToolResult => ({ content: [{ type: 'text', text }] })

/**
 * One tool, over the context its `run` gets. `input` is a `z.object`: its
 * shape is what Claude's server registers and its JSON schema what the
 * bridge lists. A module writes `WorkTool` (src/main/server/work/modules.ts),
 * which is this with the host's `ToolCtx`.
 */
export interface WorkToolOf<C> {
  name: string
  description: string
  input: ZodType
  /** true: the tool changes nothing, anywhere */
  readOnly: boolean
  run(args: unknown, ctx: C): Promise<WorkToolResult>
}

/** A tool as the bridge lists it (`app.workTools`). */
export interface WorkToolListing {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
}
export interface AppWorkToolsAnswer {
  tools: WorkToolListing[]
}
