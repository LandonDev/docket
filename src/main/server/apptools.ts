import { z } from 'zod'
import { BatchStepSpecSchema } from '@shared/contract-batch'
import { NOTE_DECISION_DESCRIPTION, NOTE_DECISION_MAX_CHARS, NOTE_DECISION_PARAMS, NOTE_DECISION_TOOL_NAME } from '@shared/away'
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type Options
} from '@anthropic-ai/claude-agent-sdk'
import {
  CATALOG,
  resolveModel,
  supportsContext1m,
  REASONING_LEVELS,
  type ProviderId
} from '@shared/catalog'
import type { SessionMeta } from '@shared/events'
import { WORK_TOOL_SERVER, workToolId } from '@shared/work/tools'
import { sessionScopeOf } from '@shared/work/ids'
import type { WorkToolMount } from './work/ctx'
import { inputShapeOf } from './work/toolInput'
import {
  HTML_PREVIEW_TOOL_DESCRIPTION,
  HTML_PREVIEW_TOOL_NAME,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_SHOWN_MESSAGE,
  HTML_RENDER_TOOL_DESCRIPTION,
  HTML_RENDER_TOOL_NAME,
  HTML_TOOL_PARAMS,
  type HtmlRenderAppearance,
  type HtmlRenderReference
} from '@shared/htmlRender'
import { CITE_CLAIM_MAX, CITE_TOOL_DESCRIPTION, CITE_TOOL_NAME, CITE_TOOL_PARAMS } from '@shared/research'
import { NOTES_MAX_CHARS } from '@shared/contract'
import {
  SKILL_HARNESSES,
  SKILL_LIST_DESCRIPTION,
  SKILL_LIST_TOOL,
  SKILL_MAX_FILES,
  SKILL_REMOVE_DESCRIPTION,
  SKILL_REMOVE_PARAMS,
  SKILL_REMOVE_TOOL,
  SKILL_WRITE_DESCRIPTION,
  SKILL_WRITE_PARAMS,
  SKILL_WRITE_TOOL
} from '@shared/skills'
import {
  canonicalSection,
  NOTE_SECTIONS,
  NOTES_STREAK_STOP,
  sectionBody,
  UPDATE_NOTES_DESCRIPTION,
  UPDATE_NOTES_PARAMS,
  UPDATE_NOTES_TOOL_NAME
} from '@shared/notes'
import {
  MERGE_BRANCH_PARAMS,
  MERGE_BRANCH_TOOL_DESCRIPTION,
  MERGE_BRANCH_TOOL_NAME,
  REPORT_FINDINGS_PARAMS,
  REPORT_FINDINGS_TOOL_DESCRIPTION,
  REPORT_FINDINGS_TOOL_NAME,
  REVIEW_FINDINGS_MAX,
  REVIEW_FINDING_PARAMS
} from '@shared/review'
import {
  ADOPT_THREAD_PARAMS,
  ADOPT_THREAD_TOOL_DESCRIPTION,
  ADOPT_THREAD_TOOL_NAME,
  ARCHIVE_THREADS_PARAMS,
  ARCHIVE_THREADS_TOOL_DESCRIPTION,
  ARCHIVE_THREADS_TOOL_NAME,
  BATCH_GATE_PARAMS,
  BATCH_GATE_TOOL_DESCRIPTION,
  BATCH_GATE_TOOL_NAME,
  BATCH_RULES_PARAMS,
  BATCH_RULES_TOOL_DESCRIPTION,
  BATCH_RULES_TOOL_NAME
} from '@shared/gate'
import { batches } from './batch'
import {
  ADDON_ADD_DESCRIPTION,
  ADDON_ADD_PARAMS,
  ADDON_ADD_TOOL,
  ADDON_LIST_DESCRIPTION,
  ADDON_LIST_TOOL,
  ADDON_REMOVE_DESCRIPTION,
  ADDON_REMOVE_PARAMS,
  ADDON_REMOVE_TOOL
} from '@shared/addons'
import type { AddonAddArgsSchema, AddonRemoveArgsSchema } from '@shared/contract-addons'
import { deferredTool, type McpServerLike } from './addons/exposure'
import { mergeReviews } from './mergeReview'
import { preview as previewHtml, publish as publishHtml, type HtmlPreview } from './htmlRender'
import { INLINE_DIGEST_MAX_CHARS, mirrorRelPath, threadDigest } from './mirror'
import type { SessionRegistry } from './sessions'
import { MacThreadTokens, macToolsHooks, toolUseIdOf } from './macTools'
import { COMPUTER_APP_TOOLS, computerHooks, computerTools, eagerComputer, type ComputerHost } from './computer/mcp'
import { computerBridgeHooks } from './computer/bridge'
import { provenanceOf, renderComputerMechanics, wordsFor } from './computer/prompts'
import { skillList, skillRemove, skillWrite, type SkillToolDeps } from './skills/tools'
import type { CrossHostAgents } from './crossHostAgents'
import type { ProjectPlans } from './projectPlan'
import {
  batchMembershipOf,
  hostCatalogView,
  hostParamDescription,
  hostServing,
  isMasterSession,
  toolLine,
  // Work's scope rule (work/scope.ts), by way of orchestration.ts: this file loads nothing under work/ but the loader and the input helper (work/load.test.ts).
  mayUseFarDesktop,
  OUTSIDE_FENCE,
  scopeFactsOf,
  withinFence,
  WORK_THREAD_TYPES,
  workHomeOf,
  workHomeOfSession,
  WorkRefused
} from './orchestration'
import { CROSS_HOST_EVENTS_MAX, type ThreadEventsResult } from '@shared/contract-crosshost'

/**
 * App tools (docs/PLAN-2.md M10): every thread is a first-class citizen of
 * the app. list/read siblings on demand, and start new threads — a planning
 * thread whose plan is approved kicks off the implementation itself; a chat
 * that crystallized starts a planning thread seeded from itself. Attached
 * to every claude session (codex/cursor reach the same registry functions
 * through the app.* WS methods + stdio bridge).
 *
 * No delete, no archive, no rules editing — destructive and policy surfaces
 * stay human. app_start_thread's guardrail is social: instruction-gated
 * (only on user ask/agreement), loudly visible in the UI, and the new
 * thread inherits the caller's permission — never more than the user granted.
 */

let registry: SessionRegistry | null = null
// Threads on other hosts (crossHostAgents.ts): app_start_thread with environmentId goes there.
let crossHost: CrossHostAgents | null = null
export function setAppCrossHost(c: CrossHostAgents | null): void {
  crossHost = c
}
export function setAppToolsRegistry(r: SessionRegistry): void {
  registry = r
}

// The add-on registry on the claude path (addons/): each thread's app server
// carries the add-on tools it may see, live (exposure.ts), and the three
// management tools ask the handlers in addons/tools.ts. index.ts sets this once
// the add-on host runs; until then a thread gets no add-on tools.
export interface AppAddons {
  exposure: { attach(session: SessionMeta, instance: McpServerLike): () => void }
  /** The three management tools' answers (addons/tools.ts), for the caller's live meta. */
  list(caller: SessionMeta): string
  add(caller: SessionMeta, args: z.infer<typeof AddonAddArgsSchema>): Promise<string>
  remove(caller: SessionMeta, args: z.infer<typeof AddonRemoveArgsSchema>): Promise<string>
  /** Whether the thread's scope holds an enabled add-on: the bridge lists addon_find and addon_call only then. */
  hasAddons(sessionId: string): boolean
}
let addons: AppAddons | null = null
export function setAppAddons(next: AppAddons | null): void {
  addons = next
}
// Work's tools (docs/agents/work.md): whatever the Work modules register for a thread's scope, through
// one mount. Claude gets them on a server of their own (`withWorkTools`); codex and Muse through the
// bridge's `app.workTools` and `app.workCall`, listed only for a thread that carries a Work token.
export interface AppWork {
  tools: WorkToolMount
}
let work: AppWork | null = null
export function setAppWork(next: AppWork | null): void {
  work = next
}

/**
 * Add the Work tools of a thread's scope to a Claude thread's options, as
 * the `work` MCP server (claude.ts, beside withMacTools). A thread with no
 * Work tools (Work off, or a code thread) gets its options back untouched,
 * so its spawn is what it was. Allowed without the CLI's prompt: a Work
 * tool that acts outward is held by the Outbox, not asked here.
 */
export function withWorkTools(options: Options, session: SessionMeta): Options {
  const mount = work?.tools
  const tools = mount?.of(session)?.tools ?? []
  if (!mount || tools.length === 0) return options
  const server = createSdkMcpServer({
    name: WORK_TOOL_SERVER,
    version: '0.1.0',
    tools: tools.map((t) =>
      tool(
        t.name,
        t.description,
        inputShapeOf(t.input) ?? {},
        async (args, extra) => {
          const live = registry?.get(session.id) ?? session
          const signal = (extra as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal
          try {
            return await mount.call(live, t.name, args, signal)
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
          }
        },
        { annotations: { readOnlyHint: t.readOnly } }
      )
    )
  })
  options.mcpServers = { ...(options.mcpServers ?? {}), [WORK_TOOL_SERVER]: server }
  options.allowedTools = [...(options.allowedTools ?? []), ...tools.map((t) => workToolId(t.name))]
  return options
}

/** The bridge's Work token for a thread that has Work tools at spawn; none otherwise, so its bridge asks nothing new. */
function workBridgeEnv(sessionId: string): Record<string, string> {
  const session = registry?.get(sessionId)
  if (!work || !session || !work.tools.of(session)) return {}
  return { TEMP_CODE_WORK_TOKEN: work.tools.tokenFor(sessionId) }
}

/** Each app server's release of its add-on tools, called where the claude handle ends (drivers/claude.ts). */
const addonReleases = new WeakMap<object, () => void>()
export function releaseAppTools(server: object | undefined): void {
  if (!server) return
  addonReleases.get(server)?.()
  addonReleases.delete(server)
}

// ── the stdio bridge (codex; cursor lacks per-run MCP config) ────────
// scripts/app-mcp-bridge.mjs is a dependency-free stdio MCP server that
// connects back to the app's WS port and forwards the three tools as
// app.* methods. The codex driver registers it per thread.

export interface AppBridgeInfo {
  port: number
  scriptPath: string
  /** node, bun, or the Electron-as-node fallback — resolved once at boot. */
  command: string
  env: Record<string, string>
  /** Each thread's own bridge token (TEMP_CODE_APP_TOKEN), checked on every app.* call by bridgeCallRefusal. */
  tokens: MacThreadTokens
}

let bridge: AppBridgeInfo | null = null
/** The bridge's launch; with no `tokens` given, a fresh random key. */
export function setAppBridge(info: (Omit<AppBridgeInfo, 'tokens'> & { tokens?: MacThreadTokens }) | null): void {
  bridge = info && { ...info, tokens: info.tokens ?? new MacThreadTokens(null, 'app-bridge') }
}
export function hasAppBridge(): boolean {
  return bridge !== null
}

/**
 * Why an app.* request is refused, or null. Every app.* method answers as the
 * thread its `sessionId` names, so the request must carry that thread's own
 * bridge token as `appToken`: only the bridge the app spawned for the thread
 * holds it. A caller naming another thread's id, or none, is refused; with no
 * bridge set up, every app.* call is. Other methods pass.
 */
export function bridgeCallRefusal(method: string, params: unknown, info: AppBridgeInfo | null = bridge): string | null {
  if (!method.startsWith('app.')) return null
  const { sessionId, appToken } = (params ?? {}) as { sessionId?: unknown; appToken?: unknown }
  if (typeof sessionId === 'string' && info?.tokens.check(sessionId, appToken)) return null
  return `forbidden: ${method} needs the calling thread's own app token`
}

/** A Work thread reaches a Mac's desktop (the bridge's tools, bridged computer use) only when its workspace may use that Mac; any other thread as its bridge says. */
function farDesktopOk(sessionId: string): boolean {
  const session = registry?.get(sessionId)
  if (!session || sessionScopeOf(session) !== 'work') return true
  return mayUseFarDesktop(session, macToolsHooks.current?.macPeerOf(sessionId).macPeer ?? null)
}

/**
 * Does this thread get the computer tools, and COMPUTER_MECHANICS with them?
 * Computer use runs on this host, or the thread's Mac bridge names a Mac that
 * offers it, and the thread's harness reaches the app server: claude in
 * process, codex and Muse through the app bridge. A cursor thread gets neither.
 */
export function offersComputerTools(
  session: Pick<SessionMeta, 'provider'> & { id?: string },
  host: ComputerHost | null = computerHooks.current,
  bridged: (session: { id?: string }) => boolean = (s) => !!s.id && !!computerBridgeHooks.current?.offered(s.id) && farDesktopOk(s.id)
): boolean {
  if (!host?.available() && !bridged(session)) return false
  return session.provider === 'claude' || ((session.provider === 'codex' || session.provider === 'muse') && hasAppBridge())
}

/**
 * COMPUTER_MECHANICS for this thread (computer/prompts.ts), or '' when it
 * gets no computer tools. Read once: claude's system prompt (mechanicsFor and
 * the driver's fallback for a subagent), codex's and Muse's first message.
 */
export function computerMechanicsFor(session: SessionMeta, host: ComputerHost | null = computerHooks.current): string {
  if (!offersComputerTools(session, host)) return ''
  // Claude's tools are in process and four, behind tool search unless loaded at spawn (§27.11); the bridge (Codex, Muse) also lists computer_result
  const claude = session.provider === 'claude'
  return renderComputerMechanics({ ...wordsFor(session), search: claude && !eagerComputer(session, host), provenance: provenanceOf(session), held: !claude })
}

/** The code tools' methods: merge, the plan's completion, a batch's gate and landing rules. A Work thread is listed none of them, by any harness. */
export const WORK_HIDDEN_METHODS: ReadonlySet<string> = new Set(['app.mergeBranch', 'app.planComplete', 'app.batchGate', 'app.batchRules'])

/** Why a Work thread's app.* call is refused, or null: the code tools are not a Work thread's, whichever harness asks (the bridge lists them none). */
export function workBridgeRefusal(method: string, params: unknown, get: (sessionId: string) => Pick<SessionMeta, 'scope'> | null | undefined): string | null {
  if (!WORK_HIDDEN_METHODS.has(method)) return null
  const { sessionId } = (params ?? {}) as { sessionId?: unknown }
  const caller = typeof sessionId === 'string' ? get(sessionId) : undefined
  return caller && sessionScopeOf(caller) === 'work' ? `refused: ${method} is not a Work thread's tool` : null
}

/** MCP server entry for a codex thread's config override (config.toml
 *  shape: command/args/env). `computerImages`: whether a computer call's
 *  pictures come back as image parts (Muse and codex's measured default) or only as the file's line
 *  (the isolated codex steer/view proof modes). */
export function bridgeMcpConfig(sessionId: string, opts: { computerImages?: 'parts' | 'none' } = {}): Record<string, unknown> | null {
  if (!bridge) return null
  // Here where computer use runs, else a box thread whose Mac bridge offers it (computer/bridge.ts).
  const desktop = farDesktopOk(sessionId)
  const computer = computerHooks.current?.available()
    ? computerHooks.current
    : desktop && computerBridgeHooks.current?.offered(sessionId) && computerBridgeHooks.tokens
      ? { tokens: computerBridgeHooks.tokens }
      : null
  return {
    command: bridge.command,
    args: [bridge.scriptPath],
    env: {
      ...bridge.env,
      TEMP_CODE_PORT: String(bridge.port),
      TEMP_CODE_SESSION: sessionId,
      // The thread's own token: the server answers an app.* call only for the thread it was made for (bridgeCallRefusal).
      TEMP_CODE_APP_TOKEN: bridge.tokens.tokenFor(sessionId),
      // The Mac bridge's per-thread token, only while the thread's bridge is on (macTools.ts).
      ...(desktop ? (macToolsHooks.current?.bridgeEnv(sessionId) ?? {}) : {}),
      // Fixed at spawn: a scope that gains its first add-on or loses its last reboots the harness at its next turn (addons/scopeFlip.ts).
      ...(addons?.hasAddons(sessionId) ? { TEMP_CODE_ADDONS: '1' } : {}),
      // Work's tools, fixed at spawn like the rest: only a thread whose scope has them carries the token (work/ctx.ts).
      ...workBridgeEnv(sessionId),
      // A Work thread says so to its bridge, which may list less for it (the code tools: merge, plan, batch gate).
      ...(sessionScopeOf(registry?.get(sessionId) ?? {}) === 'work' ? { TEMP_CODE_SCOPE: 'work' } : {}),
      // The computer tools, on a Mac only: the thread's own token, so its bridge never acts as another thread (computer/rpc.ts).
      ...(computer
        ? { TEMP_CODE_COMPUTER_TOKEN: computer.tokens.tokenFor(sessionId), TEMP_CODE_COMPUTER_IMAGES: opts.computerImages ?? 'none' }
        : {})
    },
    // wait_for_agent sleeps until a subagent settles — codex must not
    // kill the call with its default per-tool timeout.
    tool_timeout_sec: 86_400
  }
}

const providerIds = Object.keys(CATALOG) as [ProviderId, ...ProviderId[]]

const threadRow = (s: SessionMeta): Record<string, unknown> => ({
  threadId: s.id,
  title: s.title,
  threadType: s.threadType,
  status: s.status,
  model: `${s.provider} · ${s.model}`,
  ...(s.planPath ? { planPath: s.planPath } : {}),
  transcript: mirrorRelPath(s),
  updated: new Date(s.updatedAt).toISOString()
})

// ── registry-level operations (shared by the MCP tools and, later, the
// app.* WS methods the codex/cursor bridge calls) ─────────────────────

export function appListThreads(
  reg: SessionRegistry,
  caller: SessionMeta,
  allProjects: boolean
): Record<string, unknown>[] {
  // A Work thread lists the threads of its own workspace and no other (work/scope.ts).
  const fenced = sessionScopeOf(caller) === 'work' ? scopeFactsOf(reg) : null
  return reg
    .list()
    .filter((s) => !s.parentId && !s.archived)
    .filter((s) => !fenced || withinFence(fenced, caller, s))
    .filter((s) => allProjects || (caller.projectId && s.projectId === caller.projectId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(threadRow)
}

export async function appReadThread(
  reg: SessionRegistry,
  threadId: string,
  caller?: SessionMeta
): Promise<string | null> {
  // A `<host>:<id>` thread this caller started or spawned on another host:
  // its rows come over the link (crossHostAgents.ts) and read like a digest.
  if (caller && crossHost?.isRemote(threadId)) {
    const r = await crossHost.events(caller, threadId, 0, CROSS_HOST_EVENTS_MAX)
    if (typeof r === 'string') return r
    return remoteDigest(threadId, r)
  }
  const meta = reg.get(threadId)
  if (!meta) return null
  // A Work thread reads the threads of its own workspace and no other.
  if (caller && sessionScopeOf(caller) === 'work' && !withinFence(scopeFactsOf(reg), caller, meta)) return `refused: thread "${threadId}" ${OUTSIDE_FENCE}.`
  let digest = threadDigest(reg, meta)
  if (digest.length > INLINE_DIGEST_MAX_CHARS) {
    digest = `_[earlier turns trimmed]_\n\n…${digest.slice(-INLINE_DIGEST_MAX_CHARS)}`
  }
  return digest
}

/** The file a tool call wrote or saved, by the input keys the harnesses use (Write, Edit, apply_patch's path, a screenshot's path). */
export function writtenPathOf(name: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  const key = ['file_path', 'path', 'filePath', 'notebook_path', 'output_path', 'save_path', 'screenshot_path'].find((k) => typeof i[k] === 'string' && (i[k] as string).startsWith('/'))
  if (!key) return null
  const writes = /write|edit|save|create|patch|screenshot|notebook|put/i.test(name)
  return writes ? (i[key] as string) : null
}

/**
 * The rows of a thread on another host as the same kind of digest:
 * dialogue plus one-line tool actions, then the files it left on its host
 * (what it wrote by tool call, and what sits in its attachments directory:
 * screenshots, notes), each named with the host, so `mac_fetch_file` or a
 * thread there can pull them.
 */
export function remoteDigest(threadId: string, r: ThreadEventsResult): string {
  const host = threadId.slice(0, Math.max(0, threadId.indexOf(':')))
  const lines: string[] = [`_${threadId} on host ${host} · status ${r.status} · ${r.rows.length} rows (through seq ${r.lastSeq})_`, '']
  const written: string[] = []
  for (const { event } of r.rows) {
    const e = event as { type?: string; text?: string; delta?: boolean; name?: string; input?: unknown; message?: string; status?: string; parentCallId?: string }
    switch (e.type) {
      case 'user-text':
        lines.push(`**User:** ${e.text ?? ''}`, '')
        break
      case 'assistant-text':
        if (!e.delta && !e.parentCallId && e.text) lines.push(e.text, '')
        break
      case 'tool-call': {
        if (e.name) lines.push(`- ${toolLine(e.name, e.input)}`)
        const path = e.name ? writtenPathOf(e.name, e.input) : null
        if (path && !written.includes(path)) written.push(path)
        break
      }
      case 'error':
        lines.push(`_error: ${e.message ?? ''}_`, '')
        break
      case 'status':
        if (e.status && e.status !== 'running' && e.status !== 'starting') lines.push(`_status: ${e.status}_`, '')
        break
    }
  }
  const files = [...written, ...(r.attachments ?? []).filter((p) => !written.includes(p))]
  if (files.length) {
    lines.push('', `**Files on host ${host}** (paths there; a Mac path is fetched with mac_fetch_file, a box path read by a thread on the box):`)
    for (const f of files) lines.push(`- ${f}`)
  }
  let digest = lines.join('\n')
  if (digest.length > INLINE_DIGEST_MAX_CHARS) digest = `_[earlier turns trimmed]_\n\n…${digest.slice(-INLINE_DIGEST_MAX_CHARS)}`
  return digest
}

export interface StartThreadArgs {
  threadType: 'chat' | 'planning' | 'project-plan' | 'implementation' | 'orchestration' | 'research'
  provider: ProviderId
  model?: string
  reasoning?: string
  projectId?: string
  planPath?: string
  seedThreadIds?: string[]
  firstMessage: string
  title?: string
  /** Claude models with a 1M window only; refused for anything else. */
  context1m?: boolean
  /** Start it on another host: `mac`, or an environment id (crossHostAgents.ts). */
  environmentId?: string
  /** From a master: a sibling batch thread this one waits for (carried; the scheduler acts on it). */
  after?: string
}

/** Create a thread and kick it off exactly as if the user had — same
 *  preambles, plan seed, project context, thread-reference digests.
 *  Returns a corrective refusal string on invalid input. */
export async function appStartThread(
  reg: SessionRegistry,
  caller: SessionMeta,
  args: StartThreadArgs
): Promise<{ threadId: string; title: string; host?: string; cwd?: string; cwdNote?: string; status?: string } | string> {
  // A thread is a person's choice, whoever starts it: the model policy
  // (shared/rules.ts) governs subagents only. What is checked here is the
  // catalog: the model exists for some provider (a gpt model requested under
  // provider "claude" routes to codex; only a model NO provider serves is
  // refused), the reasoning is on its ladder, context1m where it is offered.
  // On another host it is that host's catalog (peerCatalogs.ts): the box
  // serves no Muse Code rows, the Mac does.
  const view = hostCatalogView(caller.id, args.environmentId)
  if (typeof view === 'string') return view
  const requested = args.model || view.providers[args.provider]?.defaultModel || CATALOG[args.provider].defaultModel
  const { provider, model } = resolveModel(args.provider, requested, (p, id) => !!view.info(p, id))
  const info = view.info(provider, model)
  if (!info) {
    const far = args.environmentId?.trim() ? null : hostServing(requested)
    if (far) return `refused: ${requested} runs on ${far.name}, not on this host: pass environmentId: "${far.host}" to start the thread there.`
    const offered = view.providers
    return `refused: no provider serves model "${requested}". Valid: ${(Object.keys(offered) as ProviderId[]).map((p) => `${p}: ${offered[p]!.models.map((m) => m.id).join(', ')}`).join('; ')}`
  }
  const asked = args.reasoning ?? info.defaultReasoning ?? 'medium'
  if (info.reasoning.length && !info.reasoning.includes(asked as (typeof info.reasoning)[number])) {
    return `refused: ${model} supports reasoning ${info.reasoning.join('|')}, not "${asked}".`
  }
  const reasoning = asked as SessionMeta['reasoning']
  if (args.context1m && !supportsContext1m(provider, model, info)) {
    return `refused: ${model} does not offer the 1M context window — only Claude models do. Start the thread without context1m, or pick a Claude model.`
  }
  // Scope follows the starter (work/scope.ts): what a Work thread starts is a
  // Work thread of its own workspace, here or on another host, or nothing.
  // SessionRegistry.create holds the rule; these are its refusals in words.
  const work = sessionScopeOf(reg.get(caller.id) ?? caller) === 'work' ? scopeFactsOf(reg) : null
  if (work && !WORK_THREAD_TYPES.includes(args.threadType)) return `refused: a Work thread starts chat and research threads only, not "${args.threadType}".`
  const projectId = args.projectId ?? caller.projectId
  const known = args.projectId ? reg.getProject(args.projectId) : null
  const homeOf = work ? workHomeOfSession(work, reg.get(caller.id) ?? caller) : 'chat'
  if (homeOf === 'orphan') return 'refused: this Work thread has no Work workspace on this host, so it starts no threads.'
  const home = homeOf === 'chat' ? null : homeOf
  if (work && args.projectId && known && known.workspaceId !== home?.id)
    return `refused: project "${known.name}" is outside this Work thread's workspace. A Work thread starts threads only in ${home ? `its own workspace (${home.name})` : 'Work Chats'}; leave projectId out, or name one of its projects.`
  if (work && args.projectId && !known) return `refused: unknown projectId "${args.projectId}".`
  // On another host an id this host does not know is no refusal: the far
  // host lands the thread in its copy of the caller's project by the link.
  if (args.projectId && !known && !args.environmentId?.trim()) {
    return `refused: unknown projectId "${args.projectId}".`
  }
  // On another host: the Mac maps this box's cwd onto its own checkout and
  // runs the thread as its own (remote/crossHostThreads.ts); seeds stay
  // here, since the Mac has no copy of these threads.
  if (args.environmentId?.trim()) {
    if (!crossHost) return 'refused: threads on other hosts are not available here'
    if (args.seedThreadIds?.length) return 'refused: seedThreadIds cannot ride to another host; put what the thread needs into firstMessage.'
    const callerNow = reg.get(caller.id) ?? caller
    // The project whose link facts ride along: the one named when this host
    // has it, else the caller's own (projectLinks.ts on the far host).
    const sent = known ?? (callerNow.projectId ? reg.getProject(callerNow.projectId) : null)
    const cwd = sent?.cwd ?? callerNow.cwd
    try {
      const started = await crossHost.startThread(callerNow, args.environmentId, {
        threadType: args.threadType,
        provider,
        model,
        reasoning,
        ...(args.context1m ? { context1m: true } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.planPath && !work ? { planPath: args.planPath } : {}),
        cwd,
        // A Work start names its workspace and sector, and its message rides inside `work` with
        // `firstMessage` left empty: a host from before Work refuses that as malformed, so no build
        // that would take the thread as a code thread ever starts it (contract-crosshost.ts).
        ...(work
          ? { firstMessage: '', projectId: null, work: { kind: 'start' as const, message: args.firstMessage, ...workHomeOf(home) } }
          : { firstMessage: args.firstMessage, projectId: sent?.id ?? null })
      })
      return started
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      return work ? `refused: that host did not take the thread as a Work thread (${why.replace(/\s+/g, ' ').trim().slice(0, 200)}). It runs a build from before Work, has Work off, or has no Work workspace for this job; nothing was started.` : `refused: ${why}`
    }
  }
  const seeds = (args.seedThreadIds ?? []).map((id) => reg.get(id))
  if (seeds.some((s) => !s)) {
    return `refused: seedThreadIds contains an unknown thread id. app_list_threads shows valid ids.`
  }
  const outside = work ? seeds.find((s) => !withinFence(work, reg.get(caller.id) ?? caller, s!)) : null
  if (outside) return `refused: seed thread "${outside.id}" ${OUTSIDE_FENCE}.`
  // "Start implementation from this plan" is zero-config: the caller's own
  // plan file is the default for the types that execute one.
  const planPath =
    args.planPath ??
    ((args.threadType === 'implementation' || args.threadType === 'orchestration') &&
    caller.planPath
      ? caller.planPath
      : undefined)
  // Fresh read: the caller's CURRENT permission is what the new thread
  // inherits — it can never grant itself more than the user granted.
  const callerNow = reg.get(caller.id) ?? caller
  const membership = batchMembershipOf(callerNow)
  // The thread and its first message are one step (startWith): a refused
  // message leaves no titled thread without its brief.
  let thread: SessionMeta
  try {
    thread = await reg.startWith(
      {
        provider,
        model,
        reasoning,
        permission: callerNow.permission,
        ...(args.context1m ? { context1m: true } : {}),
        projectId,
        threadType: args.threadType,
        planPath,
        title: args.title,
        parentId: null,
        // The caller hears when a plan it started completes (planFlow.ts).
        startedBy: caller.id,
        // The batch follows the starter (orchestration.ts batchMembershipOf): a
        // master's thread carries the master's id, a batch thread's thread (a
        // plan's build) inherits it; `after` names the sibling it waits for.
        ...membership,
        ...('masterId' in membership && args.after ? { after: args.after } : {}),
        ...(projectId ? {} : { cwd: caller.cwd })
      },
      args.firstMessage,
      {
        attachments: seeds.length
          ? seeds.map((s) => ({
              path: `thread:${s!.id}`,
              name: s!.title,
              kind: 'thread' as const,
              sessionId: s!.id
            }))
          : undefined,
        // The starter wrote the first message, not the owner.
        by: { kind: 'thread', sessionId: caller.id }
      }
    )
  } catch (err) {
    // Work's refusal is the tool's answer; anything else is a fault as before.
    if (err instanceof WorkRefused) return err.message
    throw err
  }
  const created = reg.get(thread.id) ?? thread
  // Held by `after` or the host's running cap (scheduler.ts): say why, in the words list_agents uses.
  const detail = created.status === 'queued' ? reg.queuedDetail(thread.id) : null
  const queued = created.status === 'queued' ? (detail ? `queued: ${detail}` : 'queued') : null
  return { threadId: thread.id, title: created.title, ...(queued ? { status: queued } : {}) }
}

// ── thread notes (threadNotes.ts) ────────────────────────────────────

export interface UpdateNotesArgs {
  section: string
  mode?: 'replace' | 'append'
  content: string
}

/** One section replaced or appended in the caller's notes; the answer
 *  names the file (the harness may read it directly) and the section's
 *  size, never the whole text — the model wrote it. */
export function appUpdateNotes(reg: SessionRegistry, caller: SessionMeta, args: UpdateNotesArgs): string {
  const section = canonicalSection(args.section)
  if (!section) return 'refused: section must name a heading.'
  if (args.content.length > NOTES_MAX_CHARS) return `refused: content over ${NOTES_MAX_CHARS} characters — notes are a brief, not a transcript.`
  if (reg.notesStreak(caller.id) === 'stop') return NOTES_STREAK_STOP
  const mode = args.mode ?? 'replace'
  const doc = reg.notes.update(caller.id, { section, mode, content: args.content })
  const body = sectionBody(doc.text, section)
  const lines = body ? body.split('\n').filter((l) => l.trim()).length : 0
  const known = (NOTE_SECTIONS as readonly string[]).includes(section) ? '' : ' (a heading of your own, kept after the fixed ones)'
  return `notes updated: ${section} ${mode === 'append' ? 'appended' : 'replaced'}, now ${lines} line${lines === 1 ? '' : 's'}${known}.${doc.path ? ` File: ${doc.path}` : ''}`
}

/** note_decision: one away row on the caller (sessions.ts awayNotice), counted toward the return toast. */
export function appNoteDecision(reg: Pick<SessionRegistry, 'awayNotice'>, caller: SessionMeta, args: { decision: string }): string {
  const decision = args.decision.replace(/\s+/g, ' ').trim()
  if (!decision) return 'refused: say what you decided.'
  if (decision.length > NOTE_DECISION_MAX_CHARS) return `refused: one line of at most ${NOTE_DECISION_MAX_CHARS} characters.`
  return reg.awayNotice(caller.id, 'decision', decision) ? 'noted' : 'already noted'
}

export const NOTE_DECISION_SHAPE = {
  decision: z.string().min(1).describe(NOTE_DECISION_PARAMS.decision)
}

export const UPDATE_NOTES_SHAPE = {
  section: z.string().min(1).max(80).describe(UPDATE_NOTES_PARAMS.section),
  mode: z.enum(['replace', 'append']).optional().describe(UPDATE_NOTES_PARAMS.mode),
  content: z.string().max(NOTES_MAX_CHARS).describe(UPDATE_NOTES_PARAMS.content)
}

// ── agent HTML pages (ported from T3 Code) ───────────────────────────

export interface HtmlPreviewArgs {
  html: string
  width?: number
  appearance?: HtmlRenderAppearance
}

export interface HtmlRenderArgs {
  html: string
  title: string
  height: number
}

/** Screenshot + metrics of a page; throws with a message the agent can act on. */
export function appHtmlPreview(args: HtmlPreviewArgs): Promise<HtmlPreview> {
  return previewHtml(args)
}

/** Publish a page into the calling thread; throws with a message the agent can act on. */
export async function appHtmlRender(
  sessionId: string,
  args: HtmlRenderArgs
): Promise<{ htmlRender: HtmlRenderReference; message: string }> {
  const htmlRender = await publishHtml({ sessionId, ...args })
  return { htmlRender, message: HTML_RENDER_SHOWN_MESSAGE }
}

/** The MCP content parts of a preview: the metrics as JSON, then the screenshot. */
export function htmlPreviewContent(result: HtmlPreview): Array<
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
> {
  const { png, ...metrics } = result
  return [
    { type: 'text', text: JSON.stringify(metrics) },
    { type: 'image', data: png, mimeType: 'image/png' }
  ]
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}

/** Errors come back as tool results, so the model reads the message and fixes the page. */
async function htmlTool(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (err) {
    return {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true
    }
  }
}

export const HTML_PREVIEW_SHAPE = {
  html: z.string().min(1).max(512_000).describe(HTML_TOOL_PARAMS.html),
  width: z.number().int().min(240).max(1600).optional().describe(HTML_TOOL_PARAMS.width),
  appearance: z.enum(['dark', 'light']).optional().describe(HTML_TOOL_PARAMS.appearance)
}

export const HTML_RENDER_SHAPE = {
  html: z.string().min(1).max(512_000).describe(HTML_TOOL_PARAMS.html),
  title: z.string().min(1).max(HTML_RENDER_MAX_TITLE_LENGTH).describe(HTML_TOOL_PARAMS.title),
  height: z
    .number()
    .int()
    .min(HTML_RENDER_MIN_HEIGHT)
    .max(HTML_RENDER_MAX_HEIGHT)
    .describe(HTML_TOOL_PARAMS.height)
}

export const htmlPreviewTool = (args: HtmlPreviewArgs): Promise<ToolResult> =>
  htmlTool(async () => ({ content: htmlPreviewContent(await appHtmlPreview(args)) }))

export const htmlRenderTool = (sessionId: string, args: HtmlRenderArgs): Promise<ToolResult> =>
  htmlTool(async () => text(JSON.stringify(await appHtmlRender(sessionId, args))))

// ── the MCP toolset (claude sessions, in-process) ────────────────────

const text = (t: string): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text: t }]
})

export const CITE_SHAPE = {
  url: z.string().min(1).max(2000).describe(CITE_TOOL_PARAMS.url),
  claim: z.string().min(1).max(CITE_CLAIM_MAX).describe(CITE_TOOL_PARAMS.claim),
  title: z.string().max(300).optional().describe(CITE_TOOL_PARAMS.title)
}

let projectPlans: ProjectPlans | null = null
export function setProjectPlans(plans: ProjectPlans | null): void {
  projectPlans = plans
}

// The skill tools every thread gets (skills/tools.ts holds their one body; the bridge reaches it through index.ts).
let skillTools: SkillToolDeps | null = null
export function setAppSkillTools(deps: SkillToolDeps | null): void {
  skillTools = deps
}

/**
 * An add-on add or remove as a Work thread may make it, whichever harness asks
 * (Claude's tools here, the bridge's app.addonAdd and app.addonRemove in
 * index.ts): its own workspace's scope only, as one for every workspace would
 * reach code threads; a string is the refusal. A code thread's args pass as
 * they are.
 */
export function workAddonArgs<A extends { scope?: 'workspace' | 'global' }>(caller: SessionMeta, args: A): A | string {
  if (sessionScopeOf(caller) !== 'work') return args
  return args.scope === 'global' ? WORK_ADDON_REFUSAL : { ...args, scope: 'workspace' }
}

export const WORK_ADDON_REFUSAL = 'refused: a Work thread adds and removes add-ons for its own workspace only, never for every workspace.'
export const WORK_SKILL_REFUSAL = 'refused: a Work thread writes and removes skills for its own workspace only, never for every workspace: a skill there is read by code threads too.'

/**
 * A skill is instructions other threads read. One a Work thread wrote for
 * every workspace would be read by code threads, which hold the person's own
 * MCP servers and sending keys: the fence, crossed by a file. So a Work
 * thread writes and removes skills in its own Work workspace's scope only,
 * and a Work Chat, which has none, not at all. skills/tools.ts asks it inside
 * skillWrite and skillRemove (`scopeRefusal`), so it holds for whichever
 * caller reaches them: a Claude tool here, the bridge's app.skill* in index.ts.
 */
export function workSkillRefusal(caller: SessionMeta, scopeWorkspaceId: string | null): string | null {
  if (!registry || sessionScopeOf(caller) !== 'work') return null
  const home = workHomeOfSession(scopeFactsOf(registry), caller)
  return typeof home !== 'string' && scopeWorkspaceId === home.id ? null : WORK_SKILL_REFUSAL
}

export const SKILL_WRITE_SHAPE = {
  name: z.string().describe(SKILL_WRITE_PARAMS.name),
  harnesses: z
    .array(z.enum(['all', ...SKILL_HARNESSES]))
    .min(1)
    .max(4)
    .optional()
    .describe(SKILL_WRITE_PARAMS.harnesses),
  scope: z.enum(['workspace', 'global']).optional().describe(SKILL_WRITE_PARAMS.scope),
  files: z
    .array(z.object({ path: z.string().max(1_024), text: z.string(), executable: z.boolean().optional() }))
    .max(SKILL_MAX_FILES)
    .optional()
    .describe(SKILL_WRITE_PARAMS.files),
  dir: z.string().optional().describe(SKILL_WRITE_PARAMS.dir)
}

export const SKILL_REMOVE_SHAPE = {
  name: z.string().describe(SKILL_REMOVE_PARAMS.name),
  scope: z.enum(['workspace', 'global']).optional().describe(SKILL_REMOVE_PARAMS.scope)
}

const SKILLS_NOT_READY = 'error: the skills store is not ready on this host'
/** The caller as the registry holds it now: its title and workspace may have moved since the harness booted. */
const liveCaller = (session: SessionMeta): SessionMeta => registry?.get(session.id) ?? session

export const PLAN_COMPLETE_TOOL_NAME = 'plan_complete'
export const PLAN_COMPLETE_TOOL_DESCRIPTION =
  'Planning and project-plan threads only: say the plan is COMPLETE — the plan file is fully written and every decision is settled. Call it once, as the last tool call before your closing message. For an ordinary plan the app then starts the implementation thread itself (when auto-start is on) and tells whoever started this plan; a project plan gets `status: complete` and the user picks the next milestone from its options — nothing starts on its own. Refused while the plan file is missing or empty.'
export const PLAN_COMPLETE_SHAPE = {
  summary: z.string().optional().describe('One line on what the plan covers (optional)')
}

export const MERGE_BRANCH_SHAPE = {
  branch: z.string().optional().describe(MERGE_BRANCH_PARAMS.branch),
  push: z.boolean().optional().describe(MERGE_BRANCH_PARAMS.push)
}

export const BATCH_GATE_SHAPE = {
  notes: z.string().optional().describe(BATCH_GATE_PARAMS.notes),
  release: z.boolean().optional().describe(BATCH_GATE_PARAMS.release)
}

export const BATCH_RULES_SHAPE = {
  land: z.enum(['as-they-finish', 'all-at-once']).optional().describe(BATCH_RULES_PARAMS.land),
  steps: z.array(BatchStepSpecSchema).max(32).optional().describe(BATCH_RULES_PARAMS.steps),
  then: z.enum(['notify', 'archive-children']).optional().describe(BATCH_RULES_PARAMS.then),
  summary: z.string().optional().describe(BATCH_RULES_PARAMS.summary)
}

export const ADOPT_THREAD_SHAPE = {
  threadId: z.string().describe(ADOPT_THREAD_PARAMS.threadId)
}

export const ARCHIVE_THREADS_SHAPE = {
  which: z.enum(['done', 'all']).optional().describe(ARCHIVE_THREADS_PARAMS.which),
  threadIds: z.array(z.string()).max(100).optional().describe(ARCHIVE_THREADS_PARAMS.threadIds)
}

/** A master thread (the pin on its row), which alone gets the batch tools. */
export function isMaster(session: SessionMeta): boolean {
  return isMasterSession(session)
}

export const REPORT_FINDINGS_SHAPE = {
  findings: z
    .array(
      z.object({
        file: z.string().describe(REVIEW_FINDING_PARAMS.file),
        line: z.number().int().optional().describe(REVIEW_FINDING_PARAMS.line),
        summary: z.string().describe(REVIEW_FINDING_PARAMS.summary),
        failure_scenario: z.string().describe(REVIEW_FINDING_PARAMS.failure_scenario),
        verdict: z.enum(['CONFIRMED', 'PLAUSIBLE']).optional().describe(REVIEW_FINDING_PARAMS.verdict),
        category: z.string().max(40).optional().describe(REVIEW_FINDING_PARAMS.category),
        short_summary: z.string().max(60).optional().describe(REVIEW_FINDING_PARAMS.short_summary)
      })
    )
    .max(REVIEW_FINDINGS_MAX)
    .describe(REPORT_FINDINGS_PARAMS.findings),
  level: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe(REPORT_FINDINGS_PARAMS.level)
}

/** The plan tools a thread gets: plan_complete for the two types that write a plan. */
function writesPlan(session: SessionMeta): boolean {
  return (session.threadType === 'planning' || session.threadType === 'project-plan') && !session.parentId
}

export function appToolsMcp(session: SessionMeta): McpSdkServerConfigWithInstance {
  // cite_source exists only inside a research tree (the handle reboots on
  // a retype, so the check at boot is current); elsewhere it would only refuse.
  const research = registry?.researchRootOf(session.id) !== null
  // A Work thread gets none of the code tools: no merge, no batch gate or landing rules. Its scope was stamped at create, so the row says it.
  const work = sessionScopeOf(session) === 'work'
  const server = createSdkMcpServer({
    name: 'app',
    version: '0.1.0',
    // Tool search is on for every claude thread (drivers/claude.ts): the app's own tools stay in every
    // prompt, while add-on tools, the add-on management tools and the skill tools are found by search (deferredTool).
    alwaysLoad: true,
    tools: [
      ...(research
        ? [
            tool(CITE_TOOL_NAME, CITE_TOOL_DESCRIPTION, CITE_SHAPE, async (args) =>
              text(registry ? registry.citeSource(session.id, args) : 'app registry not ready')
            )
          ]
        : []),
      ...(writesPlan(session)
        ? [
            tool(PLAN_COMPLETE_TOOL_NAME, PLAN_COMPLETE_TOOL_DESCRIPTION, PLAN_COMPLETE_SHAPE, async (args) => {
              if (!registry) return text('app registry not ready')
              // A project plan completes into its file (projectPlan.ts); an
              // ordinary plan into the plan flow (planFlow.ts).
              if (session.threadType === 'project-plan') {
                return text(projectPlans ? projectPlans.complete(session.id) : 'app registry not ready')
              }
              const result = await registry.completePlan(session.id, args)
              return text(typeof result === 'string' ? result : JSON.stringify(result))
            })
          ]
        : []),
      tool(
        'app_list_threads',
        "List this project's threads (the live version of the project-context index): id, title, type, status, model, plan file, transcript path, last activity.",
        {
          allProjects: z
            .boolean()
            .default(false)
            .describe("true: every project's threads, not just this one's")
        },
        async (args) => {
          if (!registry) return text('app registry not ready')
          return text(JSON.stringify(appListThreads(registry, session, args.allProjects)))
        }
      ),
      tool(
        'app_read_thread',
        'Read another thread as a readable digest (dialogue + one-line tool actions). Works across projects, and for a `<host>:<id>` thread this one started or spawned on another host.',
        { threadId: z.string() },
        async (args) => {
          if (!registry) return text('app registry not ready')
          const digest = await appReadThread(registry, args.threadId, session)
          return text(
            digest ??
              `refused: unknown thread "${args.threadId}". app_list_threads shows valid ids.`
          )
        }
      ),
      tool(
        'app_start_thread',
        'Create a new thread and send its first message — it starts working immediately, visibly. Use ONLY when the user asked for a handoff or agreed to one (e.g. plan approved → implementation thread; chat crystallized → planning thread seeded from it; a research-shaped ask → research thread, which runs on claude). A thread is the person\'s choice: any catalog model may run one, whatever the subagent model policy says.',
        {
          threadType: z.enum(['chat', 'planning', 'project-plan', 'implementation', 'orchestration', 'research']),
          provider: z.enum(providerIds),
          model: z
            .string()
            .optional()
            .describe(
              `Defaults per provider: ${providerIds.map((p) => `${p}=${CATALOG[p].defaultModel}`).join(', ')}`
            ),
          reasoning: z
            .enum(REASONING_LEVELS)
            .optional()
            .describe("Must be on the chosen model's ladder; defaults to the model's default"),
          context1m: z
            .boolean()
            .optional()
            .describe(
              'Claude models only: run the thread with the 1M context window. Rejected for models that do not offer it.'
            ),
          projectId: z.string().optional().describe("Defaults to this thread's project"),
          environmentId: z.string().optional().describe(hostParamDescription()),
          planPath: z
            .string()
            .optional()
            .describe(
              "implementation/orchestration: the plan file to work from. Defaults to THIS thread's plan when it has one."
            ),
          seedThreadIds: z
            .array(z.string())
            .optional()
            .describe('Digests of these threads ride along with the first message'),
          firstMessage: z
            .string()
            .describe('The kickoff message — complete and self-contained; you write it'),
          title: z.string().optional(),
          after: z
            .string()
            .optional()
            .describe("A master thread only: the id of a sibling batch thread this one waits for before it starts")
        },
        async (args) => {
          if (!registry) return text('app registry not ready')
          const result = await appStartThread(registry, session, args)
          if (typeof result === 'string') return text(result)
          return text(
            JSON.stringify({
              ...result,
              note: result.status
                ? 'thread created and queued — it starts on its own when it may; visible to the user now'
                : 'thread created and working — visible to the user now'
            })
          )
        }
      ),
      tool(UPDATE_NOTES_TOOL_NAME, UPDATE_NOTES_DESCRIPTION, UPDATE_NOTES_SHAPE, async (args) =>
        text(registry ? appUpdateNotes(registry, session, args) : 'app registry not ready')
      ),
      // The skill tools on every thread, deferred: found by tool search. A change to a person's skill raises a card on the call's own row.
      deferredTool(tool(SKILL_LIST_TOOL, SKILL_LIST_DESCRIPTION, {}, async () => text(skillTools ? await skillList(skillTools, liveCaller(session)) : SKILLS_NOT_READY))),
      deferredTool(
        tool(SKILL_WRITE_TOOL, SKILL_WRITE_DESCRIPTION, SKILL_WRITE_SHAPE, async (args, x) =>
          text(skillTools ? await skillWrite(skillTools, liveCaller(session), args, { callId: toolUseIdOf(x) }) : SKILLS_NOT_READY)
        )
      ),
      deferredTool(
        tool(SKILL_REMOVE_TOOL, SKILL_REMOVE_DESCRIPTION, SKILL_REMOVE_SHAPE, async (args, x) => {
          if (!skillTools) return text(SKILLS_NOT_READY)
          return text(await skillRemove(skillTools, liveCaller(session), args, { callId: toolUseIdOf(x) }))
        })
      ),
      // note_decision on every thread: the record of a choice made while the person is away.
      tool(NOTE_DECISION_TOOL_NAME, NOTE_DECISION_DESCRIPTION, NOTE_DECISION_SHAPE, async (args) =>
        text(registry ? appNoteDecision(registry, session, args) : 'app registry not ready')
      ),
      // merge_branch on every code thread: the merge itself, with the project's
      // review in front of it when that is on (mergeReview.ts).
      ...(work
        ? []
        : [
            tool(MERGE_BRANCH_TOOL_NAME, MERGE_BRANCH_TOOL_DESCRIPTION, MERGE_BRANCH_SHAPE, async (args) => {
              const reviews = mergeReviews()
              const live = registry?.get(session.id) ?? session
              return text(reviews ? await reviews.mergeBranch(live, args) : 'refused: merge reviews are not available here')
            })
          ]),
      // batch_rules, batch_gate, adopt_thread and archive_threads only on a
      // master thread (batch.ts): what the app does when the batch is done,
      // the gate and release run early, an existing thread brought into the
      // batch, and threads taken out of it. A Work master keeps the two that
      // manage its threads; the gate and the landing rules are a code batch's.
      ...(isMaster(session) && !work
        ? [
            tool(BATCH_RULES_TOOL_NAME, BATCH_RULES_TOOL_DESCRIPTION, BATCH_RULES_SHAPE, async (args) => {
              const b = batches()
              const live = registry?.get(session.id) ?? session
              return text(b ? b.rulesTool(live, args) : 'refused: batches are not available here')
            }),
            tool(BATCH_GATE_TOOL_NAME, BATCH_GATE_TOOL_DESCRIPTION, BATCH_GATE_SHAPE, async (args) => {
              const b = batches()
              const live = registry?.get(session.id) ?? session
              return text(b ? await b.gate(live, args) : 'refused: batches are not available here')
            })
          ]
        : []),
      ...(isMaster(session)
        ? [
            tool(ADOPT_THREAD_TOOL_NAME, ADOPT_THREAD_TOOL_DESCRIPTION, ADOPT_THREAD_SHAPE, async (args) => {
              const b = batches()
              const live = registry?.get(session.id) ?? session
              return text(b ? await b.adoptTool(live, args) : 'refused: batches are not available here')
            }),
            tool(ARCHIVE_THREADS_TOOL_NAME, ARCHIVE_THREADS_TOOL_DESCRIPTION, ARCHIVE_THREADS_SHAPE, async (args) => {
              const b = batches()
              const live = registry?.get(session.id) ?? session
              return text(b ? await b.archiveTool(live, args) : 'refused: batches are not available here')
            })
          ]
        : []),
      // report_findings only for the reviewer thread of a run: the handle
      // boots after the run is registered, so the check at boot is current.
      ...(mergeReviews()?.isReviewer(session.id)
        ? [
            tool(REPORT_FINDINGS_TOOL_NAME, REPORT_FINDINGS_TOOL_DESCRIPTION, REPORT_FINDINGS_SHAPE, async (args) =>
              text(mergeReviews()?.reportFindings(session, args) ?? 'refused: merge reviews are not available here')
            )
          ]
        : []),
      tool(HTML_PREVIEW_TOOL_NAME, HTML_PREVIEW_TOOL_DESCRIPTION, HTML_PREVIEW_SHAPE, (args) =>
        htmlPreviewTool(args)
      ),
      tool(HTML_RENDER_TOOL_NAME, HTML_RENDER_TOOL_DESCRIPTION, HTML_RENDER_SHAPE, (args) =>
        htmlRenderTool(session.id, args)
      ),
      // Computer use on a Mac thread: deferred behind tool search, or loaded for a thread that is going to use it (computer/mcp.ts).
      // Carried to a Mac from here, a Work thread gets it only when its workspace may use that Mac.
      ...(computerHooks.current?.available() || farDesktopOk(session.id) ? computerTools(session) : []),
      // The add-on registry's management tools: deferred, found by tool search like the add-on tools themselves.
      deferredTool(
        tool(ADDON_LIST_TOOL, ADDON_LIST_DESCRIPTION, {}, async () => {
          const live = registry?.get(session.id) ?? session
          return text(addons ? addons.list(live) : 'refused: add-ons are not available here')
        })
      ),
      // A Work thread adds and removes add-ons in its own workspace's scope only: one for every workspace would reach
      // code threads, and a global row it cannot see is not its to remove (addons/scope.ts).
      deferredTool(
        tool(ADDON_ADD_TOOL, ADDON_ADD_DESCRIPTION, ADDON_ADD_SHAPE, async (args) => {
          const live = registry?.get(session.id) ?? session
          if (!addons) return text('refused: add-ons are not available here')
          const held = workAddonArgs(live, args)
          return text(typeof held === 'string' ? held : await addons.add(live, held))
        })
      ),
      deferredTool(
        tool(ADDON_REMOVE_TOOL, ADDON_REMOVE_DESCRIPTION, ADDON_REMOVE_SHAPE, async (args) => {
          const live = registry?.get(session.id) ?? session
          if (!addons) return text('refused: add-ons are not available here')
          const held = workAddonArgs(live, args)
          return text(typeof held === 'string' ? held : await addons.remove(live, held))
        })
      )
    ]
  })
  // The thread's add-on tools join the live server and follow the store (addons/exposure.ts).
  const release = addons?.exposure.attach(session, server.instance as unknown as McpServerLike)
  if (release) addonReleases.set(server, release)
  return server
}

const ADDON_ADD_SHAPE = {
  name: z.string().describe(ADDON_ADD_PARAMS.name),
  description: z.string().max(500).optional().describe(ADDON_ADD_PARAMS.description),
  transport: z.enum(['stdio', 'http']).describe(ADDON_ADD_PARAMS.transport),
  command: z.string().optional().describe(ADDON_ADD_PARAMS.command),
  args: z.array(z.string()).optional().describe(ADDON_ADD_PARAMS.args),
  env: z.array(z.string()).optional().describe(ADDON_ADD_PARAMS.env),
  tokenEnv: z.string().optional().describe(ADDON_ADD_PARAMS.tokenEnv),
  url: z.string().optional().describe(ADDON_ADD_PARAMS.url),
  headers: z.array(z.string()).optional().describe(ADDON_ADD_PARAMS.headers),
  auth: z.enum(['none', 'fields', 'oauth']).optional().describe(ADDON_ADD_PARAMS.auth),
  scope: z.enum(['workspace', 'global']).optional().describe(ADDON_ADD_PARAMS.scope),
  platforms: z.array(z.enum(['darwin', 'linux'])).optional().describe(ADDON_ADD_PARAMS.platforms)
}
const ADDON_REMOVE_SHAPE = {
  name: z.string().describe(ADDON_REMOVE_PARAMS.name),
  scope: z.enum(['workspace', 'global']).optional().describe(ADDON_REMOVE_PARAMS.scope)
}

export const APP_TOOLS = [
  'mcp__app__plan_complete',
  'mcp__app__app_list_threads',
  'mcp__app__app_read_thread',
  'mcp__app__app_start_thread',
  `mcp__app__${UPDATE_NOTES_TOOL_NAME}`,
  `mcp__app__${NOTE_DECISION_TOOL_NAME}`,
  `mcp__app__${HTML_PREVIEW_TOOL_NAME}`,
  `mcp__app__${HTML_RENDER_TOOL_NAME}`,
  `mcp__app__${CITE_TOOL_NAME}`,
  `mcp__app__${PLAN_COMPLETE_TOOL_NAME}`,
  `mcp__app__${MERGE_BRANCH_TOOL_NAME}`,
  `mcp__app__${REPORT_FINDINGS_TOOL_NAME}`,
  `mcp__app__${BATCH_GATE_TOOL_NAME}`,
  `mcp__app__${BATCH_RULES_TOOL_NAME}`,
  `mcp__app__${ADOPT_THREAD_TOOL_NAME}`,
  `mcp__app__${ARCHIVE_THREADS_TOOL_NAME}`,
  `mcp__app__${SKILL_LIST_TOOL}`,
  `mcp__app__${SKILL_WRITE_TOOL}`,
  `mcp__app__${SKILL_REMOVE_TOOL}`,
  // The management tools raise the card that matters themselves (addon_add's is admin-only).
  `mcp__app__${ADDON_LIST_TOOL}`,
  `mcp__app__${ADDON_ADD_TOOL}`,
  `mcp__app__${ADDON_REMOVE_TOOL}`,
  // Computer use asks its own card in safe and edits (computer/run.ts), so the CLI never asks a second time.
  // On every host, so the warm pool's argv does not split by host.
  ...COMPUTER_APP_TOOLS
]
