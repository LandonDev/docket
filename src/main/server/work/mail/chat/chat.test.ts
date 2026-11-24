import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { AddonRow } from '@shared/contract-addons'
import type { SessionMeta } from '@shared/events'
import type { WorkScope } from '@shared/work'
import { lifeosAllowed, mailChatWithheld, mailOfferOf, MAIL_CHAT, MAIL_CHAT_POWERS, MAIL_CHAT_REFUSAL, MAIL_CHAT_WITHHELD, workAllowed } from '@shared/work/mailChat'
import { openDb, Store } from '../../../db'
import type { SessionRegistry } from '../../../sessions'
import type { WorkPartDeps } from '../../ctx'
import { loadWorkModules, WORK_MODULES, type Caller, type ToolCtx, type WorkCtx, type WorkModule, type WorkTool } from '../../modules'
import { callRefusalOf, harnessDeniedOf } from '../../narrowing'
import { makeAddonGate, type CatchDeps } from '../../outbox/catch'
import type { RuleAddons } from '../../outbox/rules'
import { mail } from '..'
import { adoptChat, NO_MAIL, NOT_A_PERSON, NOT_A_ROOT, NOT_FRESH, OTHER_SECTOR, OTHER_SUBJECT, WITHHELD } from './adopt'
import { chatRow, ensureChatTables, findChats, mailChatOf } from './find'
import { NO_REWRITE, NOT_YOURS, offer, ONE_CARD, OUT_OF_SECTOR } from './offer'
import { chatCallRefusal, chatHarnessDenied, refusalWords } from './refusal'

/**
 * The chat beside the mail, on the host (docs/agents/work-mail.md "The chat
 * beside the mail"): adopt marks a fresh root Work thread as a mail chat, find
 * reads them back, the narrowing refuses every call off the allow-list on both
 * funnels, and mail_offer checks each id before it answers a card.
 */

const scopes = new Map<string, WorkScope>()
vi.mock('../../scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scope')>()),
  scopePart: () => ({
    scopeOf: (id: string) => scopes.get(id) ?? null,
    mentionReach: () => null,
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
const { startWork } = await import('../../ctx')

const owner: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
const model: Caller = { kind: 'model', caps: ['read', 'operate', 'approve', 'admin'], sessionId: 'chat' }

const scope = (sessionId: string, workspaceId: string | null, sector: WorkScope['sector']): WorkScope => ({ sessionId, workspaceId, sector, host: 'box', away: false, routineRunId: null, shared: () => false })

/** A host: workspaces and threads in its tables, LifeOS answering from `answers`. */
function fakeCtx(answers: Record<string, unknown> = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, kind TEXT, sector TEXT)')
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_id TEXT, started_by TEXT)')
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('ws', 'work', 'life')
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('ws-2', 'work', 'cosmic')
  ensureChatTables(db)
  const threads: Record<string, { parent?: string; starter?: string; workspace: string; sector: WorkScope['sector']; written?: boolean }> = {
    chat: { workspace: 'ws', sector: 'life' },
    chat2: { workspace: 'ws', sector: 'life' },
    chat3: { workspace: 'ws', sector: 'life' },
    other: { workspace: 'ws-2', sector: 'cosmic' },
    busy: { workspace: 'ws', sector: 'life', written: true },
    child: { parent: 'chat', workspace: 'ws', sector: 'life' },
    started: { starter: 'chat', workspace: 'ws', sector: 'life' }
  }
  for (const [id, t] of Object.entries(threads)) db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(id, t.parent ?? null, t.starter ?? null)
  const query = async (fn: string, args: { id: string }) => {
    const a = answers[fn]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? (a as (x: unknown) => unknown)(args) : a
  }
  const rearmed: string[] = []
  const ctx = {
    db,
    host: 'box',
    log: () => {},
    scopeOf: (id: string) => (threads[id] ? scope(id, threads[id].workspace, threads[id].sector) : null),
    canvas: { paneOf: (id: string) => threads[id]?.parent ?? id },
    threads: { fresh: (id: string) => !!threads[id] && !threads[id].written, rearm: async (id: string) => void rearmed.push(id) },
    lifeos: { connected: () => true, owner: () => ({ query, mutation: query }) }
  } as unknown as WorkCtx
  return { ctx, db, threads, rearmed }
}

/** LifeOS's `mail:thread`: mail `m-life` in life, `m-cosmic` in cosmic, nothing else. */
const mailThread = ({ id }: { id: string }) => (id === 'm-life' || id === 'm-life-2' ? { thread: { _id: id, sector: 'life' } } : id === 'm-cosmic' ? { thread: { _id: id, sector: 'cosmic' } } : null)

// The chat is held off on master (MAIL_CHAT.on); these tests prove it as it runs when on.
beforeAll(() => void (MAIL_CHAT.on = true))
afterAll(() => void (MAIL_CHAT.on = false))

describe('the chat while it is off', () => {
  it('marks no thread a mail chat: adopt is refused, as for a withheld job', async () => {
    MAIL_CHAT.on = false
    try {
      const { ctx } = fakeCtx({ 'mail:thread': mailThread })
      await expect(adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'box' })).rejects.toThrow(WITHHELD)
      expect(chatRow(ctx.db, 'chat')).toBeNull()
      expect(mailChatWithheld('life')).toBe(true)
    } finally {
      MAIL_CHAT.on = true
    }
  })
})

describe('work.mail.chat.adopt', () => {
  it('marks a fresh root Work thread of the workspace as a chat about a mail of its sector, and ends the harness its create started', async () => {
    const { ctx, rearmed } = fakeCtx({ 'mail:thread': mailThread })
    await expect(adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'mail', mailThreadId: 'm-life' }, 5)).resolves.toEqual({ ok: true })
    expect(chatRow(ctx.db, 'chat')).toEqual({ sessionId: 'chat', workspaceId: 'ws', kind: 'mail', mailThreadId: 'm-life' })
    expect(rearmed).toEqual(['chat'])
  })

  it("refuses a thread's own call, and a key that may not operate", async () => {
    const { ctx } = fakeCtx({ 'mail:thread': mailThread })
    await expect(adoptChat(ctx, model, { workspaceId: 'ws', sessionId: 'chat', kind: 'box' })).rejects.toThrow(NOT_A_PERSON)
    await expect(adoptChat(ctx, { kind: 'remote', caps: ['read'] }, { workspaceId: 'ws', sessionId: 'chat', kind: 'box' })).rejects.toThrow(NOT_A_PERSON)
    expect(chatRow(ctx.db, 'chat')).toBeNull()
  })

  it("refuses a thread of another workspace, a subagent, a thread this host does not have, and a workspace that is not Work's", async () => {
    const { ctx } = fakeCtx({ 'mail:thread': mailThread })
    await expect(adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'other', kind: 'box' })).rejects.toThrow(NOT_A_ROOT)
    await expect(adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'child', kind: 'box' })).rejects.toThrow(NOT_A_ROOT)
    await expect(adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'elsewhere', kind: 'box' })).rejects.toThrow(NOT_A_ROOT)
    await expect(adoptChat(ctx, owner, { workspaceId: 'nope', sessionId: 'chat', kind: 'box' })).rejects.toThrow('Waiting on is for a Work workspace with a sector')
  })

  it('refuses a thread with a message in it already', async () => {
    const { ctx } = fakeCtx({ 'mail:thread': mailThread })
    await expect(adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'busy', kind: 'box' })).rejects.toThrow(NOT_FRESH)
  })

  it("refuses a mail outside the workspace's sector, one LifeOS does not have, and a chat about a mail that names none", async () => {
    const { ctx } = fakeCtx({ 'mail:thread': mailThread })
    await expect(adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'mail', mailThreadId: 'm-cosmic' })).rejects.toThrow(OTHER_SECTOR)
    await expect(adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'mail', mailThreadId: 'm-gone' })).rejects.toThrow(OTHER_SECTOR)
    await expect(adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'mail' })).rejects.toThrow(NO_MAIL)
    expect(chatRow(ctx.db, 'chat')).toBeNull()
  })

  it('refuses a withheld sector', async () => {
    const { ctx } = fakeCtx({ 'mail:thread': mailThread })
    ;(MAIL_CHAT_WITHHELD as string[]).push('life')
    try {
      await expect(adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'mail', mailThreadId: 'm-life' })).rejects.toThrow(WITHHELD)
    } finally {
      ;(MAIL_CHAT_WITHHELD as string[]).pop()
    }
  })

  it('answers the same when asked again for the same subject, even after the first message, rearming again, and refuses another subject', async () => {
    const { ctx, threads, rearmed } = fakeCtx({ 'mail:thread': mailThread })
    const ask = { workspaceId: 'ws', sessionId: 'chat', kind: 'mail' as const, mailThreadId: 'm-life' }
    await adoptChat(ctx, owner, ask, 1)
    threads.chat!.written = true
    await expect(adoptChat(ctx, owner, ask, 2)).resolves.toEqual({ ok: true })
    // Asked again (a host that stopped between the row and the rearm), it ends a harness again; rearm leaves a thread with a message alone.
    expect(rearmed).toEqual(['chat', 'chat'])
    await expect(adoptChat(ctx, owner, { ...ask, mailThreadId: 'm-life-2' })).rejects.toThrow(OTHER_SUBJECT)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS at FROM work_mail_chats').get()).toEqual({ n: 1, at: 1 })
  })
})

describe('work.mail.chat.find', () => {
  it("answers the workspace's chats about one mail, newest first, without a thread the host no longer has", async () => {
    const { ctx, db } = fakeCtx({ 'mail:thread': mailThread })
    await adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'mail', mailThreadId: 'm-life' }, 10)
    await adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat2', kind: 'mail', mailThreadId: 'm-life' }, 30)
    await adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat3', kind: 'mail', mailThreadId: 'm-life-2' }, 20)
    expect(findChats(ctx, 'ws', 'm-life')).toEqual({ sessionIds: ['chat2', 'chat'] })
    expect(findChats(ctx, 'ws', 'm-life-2')).toEqual({ sessionIds: ['chat3'] })
    db.prepare('DELETE FROM sessions WHERE id = ?').run('chat2')
    expect(findChats(ctx, 'ws', 'm-life')).toEqual({ sessionIds: ['chat'] })
  })

  it("drops a deleted thread's row (the module's sessionsRemoved)", async () => {
    const { ctx } = fakeCtx({ 'mail:thread': mailThread })
    ctx.db.exec('CREATE TABLE IF NOT EXISTS work_mail_opened (draft_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL)')
    await adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'box' })
    mail.sessionsRemoved!(['chat'], ctx)
    expect(chatRow(ctx.db, 'chat')).toBeNull()
  })

  it('reads a subagent of a mail chat, and a thread it started, as the chat', async () => {
    const { ctx } = fakeCtx({ 'mail:thread': mailThread })
    await adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'box' })
    expect(mailChatOf(ctx.db, 'child')?.sessionId).toBe('chat')
    expect(mailChatOf(ctx.db, 'started')?.sessionId).toBe('chat')
    expect(chatCallRefusal(ctx, { sessionId: 'started', via: 'addon', server: 'lifeos', tool: 'archive_mail' })).toBe(refusalWords('archive_mail'))
    expect(chatHarnessDenied('started')).toEqual([...MAIL_CHAT_POWERS.harness])
    expect(mailChatOf(ctx.db, 'chat2')).toBeNull()
  })
})

// ── the narrowing ─────────────────────────────────────────────────────

/** LifeOS tools a mail chat may not call: every change but a draft. Keep in step with LifeOS's tools (apps/worker/src/mcp/tools). */
const REFUSED_LIFEOS = [
  'add_comment', 'add_doc', 'add_event', 'add_person', 'add_project', 'add_project_doc', 'add_task', 'add_tasks', 'archive_mail', 'clear_alert',
  'comment_doc', 'complete_tasks', 'delete_comment', 'delete_event', 'delete_mail', 'delete_note', 'delete_person', 'delete_project',
  'delete_project_doc', 'delete_mail_draft', 'draft_calendar_op', 'drop_tasks', 'edit_comment', 'flag_mail', 'hide_events', 'link_project_item', 'mark_mail_read',
  'merge_people', 'merge_tasks', 'move_tasks', 'pin_tasks', 'prefer_person_image', 'push_alert', 'remove_person_image', 'reopen_tasks',
  'restore_mail', 'restore_tasks', 'send_chat_reply', 'send_mail', 'set_mail_sector', 'set_note', 'set_person_image', 'set_task_order',
  'snooze_tasks', 'suggest_sheet_cells', 'undo_activity', 'unhide_events', 'unlink_project_item', 'update_event', 'update_person',
  'update_profile', 'update_project', 'update_project_doc', 'update_settings', 'update_source', 'update_task', 'write_sheet_range'
]
/** LifeOS tools a mail chat may call: the reads, and the drafts. */
const ALLOWED_LIFEOS = [
  'draft_mail', 'get_agenda', 'get_event', 'get_guide', 'get_message', 'get_note', 'get_person', 'get_profile', 'get_project',
  'get_settings', 'get_task', 'list_activity', 'list_alerts', 'list_calendar_ops', 'list_changes', 'list_comments', 'list_linear_issues', 'list_mail',
  'list_mail_accounts', 'list_mail_drafts', 'list_messages', 'list_notes', 'list_people', 'list_person_images', 'list_projects', 'list_sheets',
  'list_sources', 'list_tasks', 'read_doc', 'read_mail_thread', 'read_sheet_range', 'search_mail', 'search_messages', 'search_tasks', 'update_mail_draft'
]

/** Work tools a mail chat may not call. A tool a pillar adds fails the completeness test until it is put here or in MAIL_CHAT_POWERS.work. */
const REFUSED_WORK = [
  'canvas_open', 'canvas_close', 'play_list', 'play_propose', 'watch_create', 'routine_propose', 'voice_examples', 'messages_read', 'messages_draft_reply',
  'doc_write', 'doc_format', 'doc_suggest', 'doc_comment', 'sheet_read', 'sheet_write', 'sheet_suggest', 'sheet_format', 'sheet_rule', 'sheet_table',
  'sheet_page', 'sheet_note', 'sheet_chart', 'sheet_create', 'office_files', 'office_range_read', 'office_range_write', 'office_range_undo',
  'office_doc_read', 'office_doc_edit', 'office_slides_read', 'office_slides_replace', 'office_mail_list', 'office_mail_read', 'office_mail_draft',
  'office_mail_send', 'office_calendar_list', 'office_calendar_create', 'office_calendar_answer', 'teams_libraries', 'teams_list', 'teams_search',
  'teams_read', 'teams_open', 'teams_reply', 'google_doc_read', 'google_doc_suggest', 'google_sheet_read', 'google_sheet_suggest', 'google_slides_read',
  'google_slides_revise', 'google_share', 'google_unshare', 'guest_link', 'guest_link_revoke', 'pdf_extract', 'pdf_page_image', 'pdf_fields', 'pdf_fill',
  'pdf_export', 'slides_read', 'slides_image', 'slides_edit', 'slides_new', 'media_info', 'media_frames', 'media_note', 'media_chapters', 'media_version',
  'frameio_browse', 'frameio_open', 'frameio_comment', 'frameio_add_version', 'frameio_refresh', 'meeting_open', 'meeting_read', 'meeting_find',
  'meeting_notes', 'form_create', 'form_read', 'form_edit', 'form_publish', 'form_close', 'dashboard_create', 'dashboard_read', 'dashboard_add',
  'dashboard_refresh', 'browser_open', 'browser_needs_you', 'browser_sources', 'project_link_item', 'files_open', 'files_make', 'files_move',
  'files_copy', 'files_trash', 'files_undo', 'prep_read', 'prep_today', 'prep_write', 'prep_follow_up', 'money_read', 'money_add', 'money_receipt',
  'week_review', 'clashes_list', 'template_list', 'template_make', 'template_save', 'work_connections',
  // other threads' words, and places on his Mac, the Windows VM and Google Drive
  'work_search', 'files_places', 'files_list', 'files_search'
]
/** Work tools refused by their prefix: the Windows VM's computer tools, named after the computer-use specs. */
const REFUSED_WORK_PREFIX = ['windows_']

describe('the allow-list', () => {
  it('names every LifeOS tool as allowed or refused, never both', () => {
    for (const tool of ALLOWED_LIFEOS) expect(lifeosAllowed(tool), tool).toBe(true)
    for (const tool of REFUSED_LIFEOS) expect(lifeosAllowed(tool), tool).toBe(false)
    // a write LifeOS adds later is refused until it is listed
    expect(lifeosAllowed('archive_everything')).toBe(false)
  })

  it('names every Work tool the pillars register as allowed or refused, never both', async () => {
    await loadWorkModules()
    const registered = new Set<string>(['work_connections'])
    for (const module of WORK_MODULES) for (const tool of module.tools?.(scope('s', 'ws', 'life')) ?? []) registered.add(tool.name)
    expect(registered.size).toBeGreaterThan(50)
    for (const name of MAIL_CHAT_POWERS.work) expect(registered.has(name), `${name} is in MAIL_CHAT_POWERS.work but no pillar registers it`).toBe(true)
    for (const name of registered) {
      const refused = REFUSED_WORK.includes(name) || REFUSED_WORK_PREFIX.some((p) => name.startsWith(p))
      expect(workAllowed(name) !== refused, `${name}: list it as allowed (MAIL_CHAT_POWERS.work) or refused (REFUSED_WORK)`).toBe(true)
    }
  })
})

const LIFEOS_URL = 'https://lifeos.test/mcp'
const lifeosRow = { id: 'row-lifeos', name: 'LifeOS', enabled: true, workspaceId: null, spec: { transport: 'http', url: LIFEOS_URL, auth: 'fields', headers: ['Authorization'] } } as unknown as AddonRow
const slackRow = { id: 'row-slack', name: 'Slack', enabled: true, workspaceId: 'ws', spec: { transport: 'stdio', command: 'slack-mcp', args: [] } } as unknown as AddonRow

function gateFor(ctx: WorkCtx, modules: WorkModule[]) {
  const addons = {
    workMarks: (id: string) => (id === lifeosRow.id ? { role: 'lifeos', forWork: true } : null),
    tools: () => ({ tools: [] }),
    toolHints: () => ({})
  } as unknown as RuleAddons
  const sessions = new Map<string, SessionMeta>([
    ['chat', { id: 'chat', scope: 'work', parentId: null } as SessionMeta],
    ['plain', { id: 'plain', scope: 'work', parentId: null } as SessionMeta]
  ])
  const deps = {
    addons,
    sessions: { get: (id: string) => sessions.get(id) },
    mcpUrl: () => LIFEOS_URL,
    isWorkScope: () => true,
    originOf: (sessionId: string) => ({ app: 'tempcode', threadId: sessionId, host: 'box' }),
    modules: () => modules,
    ctx,
    log: () => {},
    // a Work thread's other add-on call has no rule here: it would be held, which needs the Outbox
    outbox: { hold: () => ({ released: null, row: { id: 'h1' } }) },
    store: { rule: () => null, rules: () => [] }
  } as unknown as CatchDeps
  return makeAddonGate(deps)
}

describe('the narrowing on the add-on catch', () => {
  it('refuses each LifeOS change in a mail chat and its subagents, before the LifeOS row runs; an ordinary Work thread runs it', async () => {
    const { ctx } = fakeCtx({ 'mail:thread': mailThread })
    await adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'box' })
    const gate = gateFor(ctx, [mail])
    for (const tool of REFUSED_LIFEOS) {
      const refused = await gate.decide({ row: lifeosRow, tool, args: {}, sessionId: 'chat', work: true })
      expect(refused, tool).toEqual({ run: false, result: { content: [{ type: 'text', text: refusalWords(tool) }], isError: true } })
      expect(gate.peek({ row: lifeosRow, tool, sessionId: 'child', work: true })).toBe('refuse')
      expect(await gate.decide({ row: lifeosRow, tool, args: {}, sessionId: 'plain', work: true }), tool).toMatchObject({ run: true })
    }
    for (const tool of ALLOWED_LIFEOS) expect(await gate.decide({ row: lifeosRow, tool, args: {}, sessionId: 'chat', work: true }), tool).toMatchObject({ run: true })
  })

  it("stamps a mail chat's draft with its origin, as every thread's", async () => {
    const { ctx } = fakeCtx({ 'mail:thread': mailThread })
    await adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'box' })
    const answer = await gateFor(ctx, [mail]).decide({ row: lifeosRow, tool: 'draft_mail', args: { to: ['x@life.test'], origin: { threadId: 'forged' } }, sessionId: 'chat', work: true })
    expect(answer).toEqual({ run: true, args: { to: ['x@life.test'], origin: { app: 'tempcode', threadId: 'chat', host: 'box' } } })
  })

  it("refuses any other add-on's tool in a mail chat, and holds it in an ordinary thread as before", async () => {
    const { ctx } = fakeCtx({ 'mail:thread': mailThread })
    await adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'box' })
    const gate = gateFor(ctx, [mail])
    expect(await gate.decide({ row: slackRow, tool: 'post', args: {}, sessionId: 'chat', work: true })).toMatchObject({ run: false, result: { content: [{ text: refusalWords('post') }] } })
    expect(gate.peek({ row: slackRow, tool: 'post', sessionId: 'plain', work: true })).toBe('hold')
  })

  it('refuses the call when a module cannot check it, and never asks for the host’s own call', async () => {
    const { ctx } = fakeCtx()
    const broken = { id: 'mail', ensure: () => {}, callRefusal: () => { throw new Error('db gone') } } as unknown as WorkModule
    const gate = gateFor(ctx, [broken])
    expect(gate.peek({ row: lifeosRow, tool: 'list_mail', sessionId: 'plain', work: true })).toBe('refuse')
    expect(gate.peek({ row: lifeosRow, tool: 'list_mail', sessionId: null, work: true })).toBe('run')
  })
})

describe('the narrowing on the Work tool mount', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let work: ReturnType<typeof startWork>
  const metas = new Map<string, SessionMeta>()
  const registry = { get: (id: string) => metas.get(id) ?? null } as unknown as SessionRegistry
  const ran: string[] = []
  const stub = (name: string): WorkTool => ({ name, description: name, input: z.object({}), readOnly: false, run: async () => (ran.push(name), { content: [{ type: 'text', text: 'ran' }] }) })
  // The real mail module's refusal, over a pillar that registers a tool of every name.
  const module = {
    id: 'mail',
    ensure: (d: DatabaseSync) => ensureChatTables(d),
    callRefusal: mail.callRefusal,
    tools: () => [...REFUSED_WORK.filter((n) => n !== 'work_connections'), ...MAIL_CHAT_POWERS.work].map(stub)
  } as unknown as WorkModule
  const never = new AbortController().signal

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-mail-chat-'))
    db = openDb(join(dir, 'test.db'))
    work = startWork({ db, store: new Store(db), registry, environmentId: 'box', dataDir: dir, log: () => {} } as unknown as WorkPartDeps, [module])
    await work.handle({ id: '1', method: 'work.set', params: { enabled: true } } as ClientRequest, LOCAL_PRINCIPAL)
    for (const id of ['chat', 'plain']) {
      metas.set(id, { id, scope: 'work', provider: 'claude' } as SessionMeta)
      scopes.set(id, scope(id, 'ws', 'life'))
    }
    db.prepare('INSERT INTO work_mail_chats (session_id, workspace_id, kind, mail_thread_id, created_at) VALUES (?, ?, ?, ?, ?)').run('chat', 'ws', 'box', null, 1)
    ran.length = 0
  })
  afterEach(() => {
    work.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses each Work tool off the list in a mail chat, and runs it in an ordinary Work thread', async () => {
    const chat = metas.get('chat')!
    const plain = metas.get('plain')!
    for (const name of REFUSED_WORK) {
      const refused = await work.tools.call(chat, name, {}, never)
      expect(refused, name).toEqual({ content: [{ type: 'text', text: refusalWords(name) }], isError: true })
      if (name !== 'work_connections') expect((await work.tools.call(plain, name, {}, never)).isError, name).toBeUndefined()
    }
    for (const name of MAIL_CHAT_POWERS.work) expect((await work.tools.call(chat, name, {}, never)).isError, name).toBeUndefined()
    expect(ran.filter((n) => REFUSED_WORK.includes(n))).toEqual(REFUSED_WORK.filter((n) => n !== 'work_connections'))
  })

  it('says why in words that send the model to mail_offer', () => {
    expect(refusalWords('files_trash')).toBe(`files_trash is not available in a mail chat. ${MAIL_CHAT_REFUSAL}`)
  })
})

describe('the harness of a mail chat', () => {
  it('has no shell, file writes or web; any other thread loses nothing', async () => {
    const { ctx } = fakeCtx({ 'mail:thread': mailThread })
    await adoptChat(ctx, owner, { workspaceId: 'ws', sessionId: 'chat', kind: 'box' })
    expect(chatHarnessDenied('chat')).toEqual(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Workflow', 'DesignSync'])
    expect(chatHarnessDenied('child')).toEqual(chatHarnessDenied('chat'))
    expect(chatHarnessDenied('chat2')).toEqual([])
    expect(harnessDeniedOf('chat', [mail])).toEqual([...MAIL_CHAT_POWERS.harness])
    expect(harnessDeniedOf('chat2', [mail])).toEqual([])
  })

  it('asks every module, and the first refusal wins', () => {
    const { ctx } = fakeCtx()
    const say = (id: string, words: string | null) => ({ id, ensure: () => {}, callRefusal: () => words }) as unknown as WorkModule
    expect(callRefusalOf([say('a', null), say('b', 'no'), say('c', 'never')], ctx, { sessionId: 's', via: 'work', server: 'work', tool: 't' })).toBe('no')
    expect(callRefusalOf([say('a', null)], ctx, { sessionId: 's', via: 'work', server: 'work', tool: 't' })).toBeNull()
    expect(chatCallRefusal(ctx, { sessionId: 'plain', via: 'work', server: 'work', tool: 'files_trash' })).toBeNull()
  })
})

// ── mail_offer ────────────────────────────────────────────────────────

describe('mail_offer', () => {
  const drafts: Record<string, unknown> = {
    mine: { row: { _id: 'mine', _creationTime: 1, status: 'draft', message: { kind: 'mail' }, origin: { app: 'tempcode', threadId: 'chat', host: 'box' } } },
    theirs: { row: { _id: 'theirs', _creationTime: 1, status: 'draft', message: { kind: 'mail' }, origin: { app: 'tempcode', threadId: 'chat2', host: 'box' } } },
    far: { row: { _id: 'far', _creationTime: 1, status: 'draft', message: { kind: 'mail' }, origin: { app: 'tempcode', threadId: 'chat', host: 'mac' } } },
    his: { row: { _id: 'his', _creationTime: 1, status: 'draft', message: { kind: 'mail' }, proposed: { by: 'agent:box:chat' } } },
    his2: { row: { _id: 'his2', _creationTime: 1, status: 'draft', message: { kind: 'mail' }, proposed: { by: 'agent:box:chat2' } } }
  }
  const toolCtx = (sessionId: string): ToolCtx => {
    const { ctx } = fakeCtx({ 'mail:thread': mailThread, 'compose:get': ({ id }: { id: string }) => drafts[id] ?? null })
    return { ...ctx, scope: scope(sessionId, 'ws', 'life'), sessionId, signal: new AbortController().signal } as ToolCtx
  }

  it("answers a draft this thread wrote as structuredContent, and one line for the model; from a subagent too", async () => {
    const result = await offer({ draft: { draftId: 'mine' } }, toolCtx('chat'))
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ mailOffer: { draft: { draftId: 'mine' } } })
    // the text part carries the card too, as JSON: Claude Code keeps only a result's text in the transcript
    expect(result.content).toHaveLength(1)
    const text = JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '')
    expect(text).toEqual({ mailOffer: { draft: { draftId: 'mine' } }, message: expect.stringContaining('Nothing was sent') })
    expect(mailOfferOf(text)).toEqual({ draft: { draftId: 'mine' } })
    expect((await offer({ draft: { draftId: 'mine' } }, toolCtx('child'))).structuredContent).toEqual({ mailOffer: { draft: { draftId: 'mine' } } })
  })

  it("refuses another thread's draft, another host's, and one LifeOS does not have", async () => {
    for (const draftId of ['theirs', 'far', 'gone']) {
      const result = await offer({ draft: { draftId } }, toolCtx('chat'))
      expect(result, draftId).toMatchObject({ isError: true, content: [{ text: NOT_YOURS }] })
      expect(result.structuredContent).toBeUndefined()
    }
  })

  it('offers a rewrite only of a draft that holds this thread’s own proposal', async () => {
    expect((await offer({ rewrite: { draftId: 'his' } }, toolCtx('chat'))).structuredContent).toEqual({ mailOffer: { rewrite: { draftId: 'his' } } })
    expect(await offer({ rewrite: { draftId: 'his2' } }, toolCtx('chat'))).toMatchObject({ isError: true, content: [{ text: NO_REWRITE }] })
  })

  it("refuses rows, a task or an event that name mail outside the thread's sector", async () => {
    const rows = { rows: { act: 'archive', title: 'Archive 2 notices', threadIds: ['m-life', 'm-cosmic'] } }
    expect(await offer(rows, toolCtx('chat'))).toMatchObject({ isError: true, content: [{ text: OUT_OF_SECTOR('m-cosmic') }] })
    expect(await offer({ task: { title: 'Pay it', threadId: 'm-gone' } }, toolCtx('chat'))).toMatchObject({ isError: true, content: [{ text: OUT_OF_SECTOR('m-gone') }] })
    expect(await offer({ event: { title: 'Call', start: '2026-11-24T10:00', threadId: 'm-cosmic' } }, toolCtx('chat'))).toMatchObject({ isError: true })
    const ok = await offer({ rows: { act: 'archive', title: 'Archive 2 notices', threadIds: ['m-life', 'm-life-2'] } }, toolCtx('chat'))
    expect(ok.structuredContent).toEqual({ mailOffer: { rows: { act: 'archive', title: 'Archive 2 notices', threadIds: ['m-life', 'm-life-2'] } } })
    expect((await offer({ task: { title: 'Pay it' } }, toolCtx('chat'))).structuredContent).toEqual({ mailOffer: { task: { title: 'Pay it' } } })
  })

  it('refuses two cards at once, and none', async () => {
    expect(await offer({ draft: { draftId: 'mine' }, task: { title: 'x' } }, toolCtx('chat'))).toMatchObject({ isError: true, content: [{ text: ONE_CARD }] })
    expect(await offer({}, toolCtx('chat'))).toMatchObject({ isError: true, content: [{ text: ONE_CARD }] })
  })

  it('is listed to a Work thread with a sector alone', () => {
    expect(mail.tools!(scope('s', 'ws', 'life')).map((t) => t.name)).toContain('mail_offer')
    expect(mail.tools!(scope('s', null, null)).map((t) => t.name)).not.toContain('mail_offer')
  })
})
