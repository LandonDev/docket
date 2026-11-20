import { z } from 'zod'
import {
  PLAY_INSTRUCTIONS_MAX,
  PLAY_NAME_MAX,
  PLAY_TAKES,
  STARTER_PLAYS,
  playInputsProblem,
  playMessage,
  playTitle,
  type PlayDraft,
  type PlayRow,
  type PlayTake
} from '@shared/contract-work-routines'
import type { ClientRequest } from '@shared/contract'
import { handled, NOT_HANDLED, sessionScopeOf, workText, type WorkScope } from '@shared/work'
import type { Caller, WorkCtx, WorkTool } from '../modules'
import type { RoutinesHost } from './host'
import { PlayStore, type Play } from './plays'
import { RoutineStore } from './store'

/**
 * The plays' methods and tools (docs/agents/work-plays.md). Only he makes,
 * changes, removes or starts a play; a thread may list them and propose one,
 * which waits in Plays until he adds it. A play's thread is started by the
 * host, as a routine's is, so its instructions never read as words he typed
 * (`ctx.threads.ownerSaid`), and it carries no grant.
 */

/** A thread may keep this many proposals waiting at once. */
export const PROPOSALS_PER_THREAD = 5
/** How much of a thread a draft reads, newest last. */
const DRAFT_CHARS = 16_000
const DRAFT_MESSAGE_CHARS = 2_000

/** The model call behind Draft from the thread; a test sets its own. */
export const playSeams: { draft: ((prompt: string) => Promise<string | null>) | null } = { draft: null }

const refuse = (why: string): never => {
  throw new Error(`refused: ${why}`)
}

const person = (by: Caller): void => {
  if (by.kind === 'model') refuse('only the owner makes, changes or starts a play; a thread may propose one with play_propose')
}

const rowOf = (p: Play, ctx: WorkCtx): PlayRow => ({ ...p, host: ctx.host })

async function draftText(prompt: string): Promise<string | null> {
  if (playSeams.draft) return playSeams.draft(prompt)
  const { generateText } = await import('../../drivers/title')
  return generateText(prompt)
}

/** The prompt that drafts a play from a thread's messages: the newest kept when the thread is long. */
export function draftPrompt(words: readonly { by: 'owner' | 'app' | 'agent'; text: string }[]): string {
  const lines: string[] = []
  let room = DRAFT_CHARS
  for (const w of [...words].reverse()) {
    const text = w.text.trim()
    if (!text) continue
    const line = `[${w.by}] ${text.length > DRAFT_MESSAGE_CHARS ? `${text.slice(0, DRAFT_MESSAGE_CHARS)}…` : text}`
    if (line.length > room) break
    room -= line.length
    lines.unshift(line)
  }
  return [
    'Draft a "play" from the work thread below: saved instructions the owner starts with one press to do this kind of work again.',
    'Write the instructions an agent follows next time, in the owner’s voice, as short numbered steps. Make them general: name the kind of thing it starts from ("This mail…"), never this one case. At most 200 words.',
    'Tell the agent to leave anything that sends, posts, books or shares as a draft for the owner; never to send it.',
    `Pick what the play takes in: none or more of ${PLAY_TAKES.join(', ')}.`,
    'Answer with JSON only: {"name": "a few words", "instructions": "…", "takes": ["mail"]}',
    '',
    'The thread:',
    ...lines
  ].join('\n')
}

/** The model's answer as a draft, or null when it is not one. */
export function parseDraft(answer: string | null): PlayDraft | null {
  const json = answer?.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return null
  try {
    const raw = JSON.parse(json) as { name?: unknown; instructions?: unknown; takes?: unknown }
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, PLAY_NAME_MAX) : ''
    const instructions = typeof raw.instructions === 'string' ? raw.instructions.trim().slice(0, PLAY_INSTRUCTIONS_MAX) : ''
    if (!name || !instructions) return null
    const takes = Array.isArray(raw.takes) ? PLAY_TAKES.filter((t) => (raw.takes as unknown[]).includes(t)) : []
    return { name, instructions, takes }
  } catch {
    return null
  }
}

export async function handlePlays(req: ClientRequest, ctx: WorkCtx, by: Caller, host: RoutinesHost, now: number): Promise<ReturnType<typeof handled> | typeof NOT_HANDLED> {
  const store = new PlayStore(ctx.db)
  const mine = (id: string): Play => store.get(id) ?? refuse(`no play ${id}`)
  const changed = (workspaceId: string) => ctx.push({ push: 'work.routines.plays', workspaceId })
  switch (req.method) {
    case 'work.routines.plays':
      return handled({ plays: store.list(req.params.workspaceId).map((p) => rowOf(p, ctx)) })
    case 'work.routines.playSave': {
      person(by)
      const q = req.params
      const workspace = host.workspace(q.workspaceId) ?? refuse(`no workspace ${q.workspaceId}`)
      const same = store.named(q.workspaceId, q.name)
      if (q.id) {
        const p = mine(q.id)
        if (p.workspaceId !== q.workspaceId) refuse('a play stays in its workspace')
        if (same && same.id !== p.id) refuse(`a play is already named “${same.name}”`)
        const runner = q.takes.length ? new RoutineStore(ctx.db).runningPlay(p.id)[0] : undefined
        if (runner) refuse(`the routine “${runner.name}” runs it, and a routine runs only a play that takes nothing`)
        const saved = store.update(p.id, { name: q.name, instructions: q.instructions, takes: q.takes }, now)!
        changed(saved.workspaceId)
        return handled(rowOf(saved, ctx))
      }
      if (same) refuse(`a play is already named “${same.name}”`)
      if (q.starter) {
        if (!(STARTER_PLAYS[workspace.sector ?? ''] ?? []).some((s) => s.key === q.starter)) refuse(`no starter ${q.starter} for this workspace`)
        if (store.list(q.workspaceId).some((p) => p.starter === q.starter)) refuse('that starter is added already')
      }
      const saved = store.create({ workspaceId: q.workspaceId, name: q.name, instructions: q.instructions, takes: q.takes, starter: q.starter ?? null, madeIn: q.madeIn ?? null, createdBy: 'owner' }, now)
      changed(saved.workspaceId)
      return handled(rowOf(saved, ctx))
    }
    case 'work.routines.playRemove': {
      person(by)
      const p = mine(req.params.id)
      const runner = new RoutineStore(ctx.db).runningPlay(p.id)[0]
      if (runner) refuse(`the routine “${runner.name}” runs it; change or delete that routine first`)
      store.remove(p.id)
      changed(p.workspaceId)
      return handled(null)
    }
    case 'work.routines.playStart': {
      person(by)
      const p = mine(req.params.id)
      if (p.proposed) refuse('a proposal starts nothing until the owner adds it')
      const inputs = { ...req.params.inputs, chips: req.params.inputs.chips ?? [] }
      const problem = playInputsProblem(p.takes, inputs)
      if (problem) refuse(`“${p.name}”: ${problem}`)
      // The thing it is about leads, so the thread is linked to it as a thread started from that thing is.
      const about = inputs.chips.find((c) => c.ref.at === 'lifeos')
      // Named here, so no model is asked for a title: the first message may be a Purdue mail.
      const sessionId = await ctx.threads.start({ workspaceId: p.workspaceId, text: playMessage(p, inputs), title: playTitle(p, inputs), ...(about ? { about } : {}) })
      return handled({ sessionId })
    }
    case 'work.routines.playDraft': {
      person(by)
      const thread = host.session(req.params.sessionId) ?? refuse(`no thread ${req.params.sessionId}`)
      if (sessionScopeOf(thread) !== 'work' || !thread.workspaceId) refuse('a play is drafted from a Work thread of a workspace')
      const workspace = host.workspace(thread.workspaceId!) ?? refuse(`no workspace ${thread.workspaceId}`)
      // Drafting sends the thread to a model of its own; Purdue's data goes to no tool the university has not cleared.
      if (workspace.sector === 'purdue') refuse('a Purdue thread is not sent to a model to draft from; write the play yourself')
      const words = host.words(thread.id)
      if (!words.some((w) => w.by === 'agent')) refuse('this thread has no answer to draft from yet')
      const draft = parseDraft(await draftText(draftPrompt(words)))
      if (!draft) throw new Error('The draft did not come back; write the play yourself or try again')
      return handled(draft)
    }
  }
  return NOT_HANDLED
}

const ProposeInput = z.object({
  name: z.string().trim().min(1).max(PLAY_NAME_MAX).describe('What the work is, in a few words: "Game assignment"'),
  instructions: z.string().trim().min(1).max(PLAY_INSTRUCTIONS_MAX).describe('The steps a thread follows each time, in the owner’s voice, general rather than about one case'),
  takes: z.array(z.enum(PLAY_TAKES)).max(PLAY_TAKES.length).optional().describe('What each start hands it: none or more of mail, task, event, file, date, text')
})

const takesWords = (takes: readonly PlayTake[]): string => (takes.length ? `takes ${takes.join(', ')}` : 'takes nothing')

/** The tools: none in a Work Chat, which has no plays. */
export function playTools(scope: WorkScope): WorkTool[] {
  if (!scope.workspaceId) return []
  return [
    {
      name: 'play_list',
      description: 'List this workspace’s plays: work the owner repeats, saved once, which he starts with one press. Each with what it takes in and its instructions. Proposals waiting for him are marked.',
      input: z.object({}),
      readOnly: true,
      async run(_raw, tc) {
        const plays = new PlayStore(tc.db).list(tc.scope.workspaceId!)
        if (!plays.length) return workText('This workspace has no plays yet.')
        return workText(plays.map((p) => `${p.proposed ? '(proposed) ' : ''}${p.name} (${takesWords(p.takes)})\n${p.instructions}`).join('\n\n'))
      }
    },
    {
      name: 'play_propose',
      description:
        'Offer the owner a play: work he repeats in this job, saved so he can start it with one press. It starts nothing and saves nothing: it waits in Plays for him to add, change or dismiss. Propose one when he does the same kind of work again and again.',
      input: ProposeInput,
      readOnly: false,
      async run(raw, tc) {
        const a = raw as z.infer<typeof ProposeInput>
        const workspaceId = tc.scope.workspaceId!
        const store = new PlayStore(tc.db)
        const same = store.named(workspaceId, a.name)
        if (same) return { ...workText(`A play is already named “${same.name}”${same.proposed ? ' and waits for the owner' : ''}.`), isError: true }
        const waiting = store.list(workspaceId).filter((p) => p.proposed && p.madeIn === tc.sessionId).length
        if (waiting >= PROPOSALS_PER_THREAD) return { ...workText(`This thread already has ${waiting} plays waiting for the owner.`), isError: true }
        const takes = PLAY_TAKES.filter((t) => (a.takes ?? []).includes(t))
        store.create({ workspaceId, name: a.name, instructions: a.instructions, takes, proposed: true, madeIn: tc.sessionId, createdBy: 'model' }, Date.now())
        tc.push({ push: 'work.routines.plays', workspaceId })
        return workText(`Proposed the play “${a.name}” (${takesWords(takes)}). It waits in Plays for the owner to add; nothing runs until he starts it.`)
      }
    }
  ]
}
