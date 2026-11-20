import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { MailWaiting } from '@shared/contract-work-mail'
import { errorText, workText, type SectorKey } from '@shared/work'
import { WORK_MODULES, type Caller, type WorkCtx, type WorkTool } from '../modules'

/**
 * Waiting on (docs/agents/work-mail.md "Waiting on"): mail he sent that no
 * one answered. LifeOS keeps the waits (`mailWaits`), lists them when they
 * fall due and fires `mail.waiting`; this host turns a press into a thread
 * that drafts a nudge, keeps the routine that does it by itself, reports a
 * nudge LifeOS dropped because a reply came, and lets a thread read the list.
 * Every nudge is a draft the hold keeps: nothing here sends.
 */

/** LifeOS's row of `mailWaits:list`: the thread, and what it waits on. */
export interface WaitRow {
  _id: string
  subject: string
  sector?: string
  waiting: { since: number; dueAt: number; asked: boolean; to: { name?: string; address: string }[] }
}

/** LifeOS's row of `mailWaits:drops`: a nudge an agent drafted, dropped because someone answered. */
export interface DropRow {
  _id: string
  threadId: string
  subject: string
  repliedBy: string
  origin?: { app?: string; threadId?: string; host?: string }
}

export const NUDGE_ROUTINE = 'Nudge mail with no reply'
const NOT_A_PERSON = 'only a person can start a nudge or change Waiting on'
const NOT_WORK = 'Waiting on is for a Work workspace with a sector'
const OTHER_SECTOR = "That mail is not in this workspace's sector"

const who = (to: WaitRow['waiting']['to']): string => {
  const names = to.map((a) => a.name?.trim() || a.address)
  if (names.length <= 2) return names.join(' and ') || 'no one'
  return `${names[0]} and ${names.length - 1} more`
}

const day = (t: number): string => new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

/** The first message of a thread a press on Draft a nudge starts. */
export function nudgePrompt(mail: { id: string; subject: string; to: string; since: number }): string {
  return [
    `Draft a short follow-up to the mail “${mail.subject || '(no subject)'}” (LifeOS mail thread ${mail.id}). He wrote to ${mail.to} on ${day(mail.since)} and no one has answered.`,
    'Read the thread with read_mail_thread first. If someone has answered since, draft nothing and say so.',
    'Otherwise write a reply in that same thread with draft_mail: two or three sentences in his voice, polite and plain, that ask again for what his last mail asked for. No apology for the follow-up, no new requests. He reads it and sends it himself; you never send.'
  ].join('\n\n')
}

/** What the routine runs: the threads it heard of come under its message as `mail.waiting mailThreads/<id>`. */
export const ROUTINE_PROMPT = [
  'Each mail thread named below (mailThreads/<id>) is one he sent that no one has answered in the time he set.',
  'For each: read it with read_mail_thread. If someone has answered since, or a draft already waits in the thread, leave it. Otherwise write a reply in that thread with draft_mail: two or three sentences in his voice, polite and plain, that ask again for what his last mail asked for.',
  'He reads every draft and sends it himself; you never send.'
].join('\n\n')

function mustBePerson(by: Caller, cap: 'operate' | 'admin'): void {
  if (by.kind === 'model' || !by.caps.includes(cap)) throw new Error(NOT_A_PERSON)
}

/** A Work workspace and its sector, from the frame's own row. */
export function workSector(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): SectorKey {
  const row = ctx.db.prepare('SELECT kind, sector FROM workspaces WHERE id = ?').get(workspaceId) as { kind: string | null; sector: string | null } | undefined
  if (!row || row.kind !== 'work' || !row.sector) throw new Error(NOT_WORK)
  return row.sector as SectorKey
}

/**
 * His press on Draft a nudge: a root Work thread in the workspace, linked to
 * the mail, whose agent drafts the follow-up. The mail must be in the
 * workspace's sector, whatever the window said.
 */
export async function startNudge(ctx: WorkCtx, by: Caller, workspaceId: string, threadId: string): Promise<{ sessionId: string }> {
  mustBePerson(by, 'operate')
  const sector = workSector(ctx, workspaceId)
  const got = await ctx.lifeos.owner().query<{ thread: { _id: string; subject: string; sector?: string }; messages: { fromMe: boolean; sentAt: number; to?: { name?: string; address: string }[]; cc?: { name?: string; address: string }[] }[] } | null>('mail:thread', { id: threadId })
  if (!got) throw new Error('LifeOS has no such mail')
  if (got.thread.sector !== sector) throw new Error(OTHER_SECTOR)
  const mine = [...got.messages].reverse().find((m) => m.fromMe)
  const to = mine ? who([...(mine.to ?? []), ...(mine.cc ?? [])]) : 'them'
  const text = nudgePrompt({ id: threadId, subject: got.thread.subject, to, since: mine?.sentAt ?? Date.now() })
  const sessionId = await ctx.threads.start({ workspaceId, text, about: { kind: 'mail', label: got.thread.subject || '(no subject)', ref: { at: 'lifeos', table: 'mailThreads', id: threadId } } })
  return { sessionId }
}

export function ensureWaitingTables(db: DatabaseSync): void {
  // The routine the switch made for a workspace, so the switch reads it again (and finds it gone).
  db.exec(`CREATE TABLE IF NOT EXISTS work_mail_nudge_routines (
    workspace_id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL
  )`)
}

type RoutineRow = { id: string; workspaceId: string; enabled: boolean }

function routinesModule() {
  const m = WORK_MODULES.find((x) => x.id === 'routines')
  if (!m?.handle) throw new Error('Routines are not running on this host')
  return m
}

async function routines(ctx: WorkCtx, by: Caller, method: string, params: unknown): Promise<unknown> {
  const answer = await routinesModule().handle!({ id: 'mail', method, params } as never, ctx, by)
  if (!answer.handled) throw new Error('Routines did not take the call')
  return answer.result
}

/** The routine this workspace's switch made, while it still exists. */
async function nudgeRoutine(ctx: WorkCtx, by: Caller, workspaceId: string): Promise<RoutineRow | null> {
  const kept = ctx.db.prepare('SELECT routine_id FROM work_mail_nudge_routines WHERE workspace_id = ?').get(workspaceId) as { routine_id: string } | undefined
  if (!kept) return null
  const { routines: rows } = (await routines(ctx, by, 'work.routines.list', { workspaceId })) as { routines: RoutineRow[] }
  return rows.find((r) => r.id === kept.routine_id) ?? null
}

/** The workspace's Waiting on: the working days a question waits (LifeOS's, per sector) and whether nudges draft by themselves. */
export async function waitingOf(ctx: WorkCtx, by: Caller, workspaceId: string): Promise<MailWaiting> {
  const sector = workSector(ctx, workspaceId)
  const routine = await nudgeRoutine(ctx, by, workspaceId)
  let days: number | null = null
  let error: string | undefined
  try {
    days = await ctx.lifeos.owner().query<number>('mailWaits:days', { sector })
  } catch (err) {
    // The switch still shows: it is this host's, and he can turn it off while LifeOS does not answer.
    error = `LifeOS did not answer: ${errorText(err)}`
  }
  return { days, routine: Boolean(routine?.enabled), ...(routine ? { routineId: routine.id } : {}), ...(error ? { error } : {}) }
}

/**
 * His change to Waiting on. `days` goes to LifeOS for the sector. `routine`
 * turns the nudge routine on (made the first time, resumed after) or off
 * (paused, so its runs stay readable). It makes no grant: each draft is held.
 */
export async function setWaiting(ctx: WorkCtx, by: Caller, workspaceId: string, patch: { days?: number; routine?: boolean }): Promise<MailWaiting> {
  mustBePerson(by, 'admin')
  const sector = workSector(ctx, workspaceId)
  if (patch.days !== undefined) await ctx.lifeos.owner().mutation('mailWaits:setDays', { sector, days: patch.days })
  if (patch.routine !== undefined) {
    const routine = await nudgeRoutine(ctx, by, workspaceId)
    if (routine) {
      if (routine.enabled !== patch.routine) await routines(ctx, by, 'work.routines.pause', { id: routine.id, paused: !patch.routine })
    } else if (patch.routine) {
      const made = (await routines(ctx, by, 'work.routines.save', {
        workspaceId,
        name: NUDGE_ROUTINE,
        prompt: ROUTINE_PROMPT,
        trigger: { on: 'lifeos', kinds: ['mail.waiting'] },
        ends: { kind: 'never' }
      })) as RoutineRow
      ctx.db.prepare('INSERT OR REPLACE INTO work_mail_nudge_routines (workspace_id, routine_id) VALUES (?, ?)').run(workspaceId, made.id)
    }
  }
  return waitingOf(ctx, by, workspaceId)
}

/**
 * Tells him of each nudge LifeOS dropped because a reply came: a Result on
 * the thread that drafted it, then LifeOS forgets the drop. A drop whose
 * thread this host no longer has is only forgotten.
 */
export async function reportDrops(ctx: WorkCtx, drops: readonly DropRow[], told: Set<string>): Promise<void> {
  for (const drop of drops) {
    if (told.has(drop._id)) continue
    told.add(drop._id)
    const sessionId = drop.origin?.threadId
    try {
      if (sessionId && drop.origin?.host === ctx.host && ctx.scopeOf(sessionId)) {
        ctx.results.add({
          sessionId,
          kind: 'mail.nudge.dropped',
          summary: `Dropped the unsent nudge “${drop.subject || '(no subject)'}”: ${drop.repliedBy} replied`,
          ref: { at: 'lifeos', table: 'mailThreads', id: drop.threadId }
        })
      }
      await ctx.lifeos.owner().mutation('mailWaits:ackDrop', { id: drop._id })
    } catch (err) {
      // Asked again on the next answer: the drop stays in LifeOS until it is acknowledged.
      told.delete(drop._id)
      ctx.log(`mail: could not report a dropped nudge: ${errorText(err)}`)
    }
  }
}

/** The thread's sector's due waits, as lines a model reads. */
export function waitingText(rows: readonly WaitRow[], sector: string, now = Date.now()): string {
  const mine = rows.filter((r) => r.sector === sector)
  if (!mine.length) return 'Nothing in this sector is waiting on a reply.'
  const days = (t: number) => Math.max(1, Math.round((now - t) / 86_400_000))
  return [
    `Mail he sent that no one has answered (${mine.length}), newest first:`,
    ...mine.map((r) => `- “${r.subject || '(no subject)'}” to ${who(r.waiting.to)}, sent ${day(r.waiting.since)} (${days(r.waiting.since)} days)${r.waiting.asked ? ', he asked to be reminded' : ''}; mail thread ${r._id}`)
  ].join('\n')
}

const PAGE = 100

export const waitingTool: WorkTool = {
  name: 'mail_waiting',
  description: "List the mail the owner sent in this workspace's sector that no one has answered in the time he set (his Waiting on list): whom it went to, the subject, when, and the mail thread's id. Read only.",
  input: z.object({}),
  readOnly: true,
  run: async (_args, ctx) => {
    const sector = ctx.scope.sector
    if (!sector) return { ...workText('This thread has no sector, so it has no Waiting on list.'), isError: true }
    if (!ctx.lifeos.connected()) return { ...workText('LifeOS is not connected.'), isError: true }
    const page = await ctx.lifeos.owner().query<{ page: WaitRow[] }>('mailWaits:list', { paginationOpts: { numItems: PAGE, cursor: null } })
    return workText(waitingText(page?.page ?? [], sector))
  }
}
