import { z } from 'zod'
import {
  LIFEOS_TRIGGER_KINDS,
  parseSchedule,
  scheduleRrule,
  type RoutineEnds,
  type RoutineRow,
  type RoutineRun
} from '@shared/contract-work-routines'
import type { ClientRequest } from '@shared/contract'
import { handled, NOT_HANDLED, WORK_HOME, workText, type Trigger, type WorkScope } from '@shared/work'
import { WORK_MODULES, type Caller, type RoutineJob, type WorkCtx, type WorkModule, type WorkTool } from '../modules'
import { outboxHostOf } from '../outbox/ctx'
import { RoutinesEngine, triggerWords, type EngineDeps } from './engine'
import { routinesHost, type RoutinesHost } from './host'
import { knownZone, nextAt } from './schedule'
import { ensureRoutineTables, type Cursor } from './store'
import { routineMentions } from './mentions'
import { handlePlays, playTools } from './playMethods'
import { PlayStore } from './plays'

/**
 * The routines pillar (docs/agents/work-routines.md): the scheduler and its
 * four triggers (engine.ts), the rows (store.ts), the methods a screen
 * calls, and two tools: `watch_create`, which an agent uses to be woken when
 * a read changes, and `routine_propose`, which only offers. And the plays
 * (plays.ts, playMethods.ts): work he starts by hand, which a routine may
 * run.
 */

/** A thread may keep this many watches going at once. */
export const WATCHES_PER_THREAD = 10
/** The longest a thread's watch may run. */
export const WATCH_DAYS_MAX = 30

/** Test seams: the host's handles and the clock. Set before `start`, cleared after. */
export const routinesSeams: { current: { host: RoutinesHost; now?: () => number; interval?: boolean } | null } = { current: null }

let engine: RoutinesEngine | null = null
let engineCtx: WorkCtx | null = null

/** A host job a loaded pillar registered (`WorkModule.jobs`), by id. */
export const registeredJob = (id: string): RoutineJob | null => WORK_MODULES.flatMap((m) => m.jobs ?? []).find((j) => j.id === id) ?? null

/** The engine for this context, made once. */
export function routinesEngine(ctx: WorkCtx): RoutinesEngine {
  if (engine && engineCtx === ctx) return engine
  const host = routinesSeams.current?.host ?? routinesHost()
  if (!host) throw new Error('work: routines has no host handles')
  const deps: EngineDeps = {
    ctx,
    host,
    now: routinesSeams.current?.now ?? Date.now,
    sources: () => WORK_MODULES.filter((m) => m.id !== 'routines').flatMap((m) => m.triggers ?? []),
    lifeosHeld: () => outboxHostOf(ctx)?.outbox.lifeos ?? null,
    job: (id) => {
      const job = registeredJob(id)
      return job ? { name: job.name, run: (at) => job.run(ctx, at) } : null
    }
  }
  engine = new RoutinesEngine(deps)
  engineCtx = ctx
  return engine
}

const refuse = (why: string): never => {
  throw new Error(`refused: ${why}`)
}

/** Only a person makes, changes or starts a routine: never a thread's own call. */
const person = (by: Caller): void => {
  if (by.kind === 'model') refuse('only the owner makes or changes a routine; a thread may propose one with routine_propose')
}

/** A trigger as it will be stored: checked, the add-on named by id, with where its clock and cursor start. */
function checked(trigger: Trigger, workspaceId: string, host: RoutinesHost, now: number): { trigger: Trigger; nextAt: number | null; cursor: Cursor } {
  if (trigger.on === 'schedule') {
    const s = parseSchedule(trigger.rrule)
    if (!s) refuse('a schedule is some days at a time, or every so many minutes')
    if (!knownZone(trigger.tz)) refuse(`no time zone ${trigger.tz}`)
    return { trigger: { ...trigger, rrule: scheduleRrule(s!) }, nextAt: nextAt(s!, trigger.tz, now), cursor: {} }
  }
  if (trigger.on === 'read') {
    const addon = host.addon(workspaceId, trigger.addon)
    if (!addon) refuse(`no add-on ${trigger.addon} in this workspace`)
    if (!host.mayRead(addon!.id, trigger.tool)) refuse(`${addon!.name}'s ${trigger.tool} is not set to Runs: a watch reads only with tools that run without the owner's press`)
    if (trigger.everySec < 300) refuse('a read is watched every 5 minutes at most')
    return { trigger: { ...trigger, addon: addon!.id }, nextAt: now, cursor: {} }
  }
  if (trigger.on === 'lifeos') {
    if (!trigger.kinds.length || trigger.kinds.some((k) => !(k in LIFEOS_TRIGGER_KINDS))) refuse(`a LifeOS trigger is one of: ${Object.keys(LIFEOS_TRIGGER_KINDS).join(', ')}`)
    return { trigger, nextAt: null, cursor: { after: now } }
  }
  if (trigger.source.at === 'lifeos') return { trigger, nextAt: null, cursor: { after: now } }
  return { trigger, nextAt: trigger.source.at === 'file' ? now : null, cursor: {} }
}

const kindOf = (ends: RoutineEnds) => (ends.kind === 'never' ? 'routine' : 'watch') as 'routine' | 'watch'

async function handle(req: ClientRequest, ctx: WorkCtx, by: Caller): Promise<ReturnType<typeof handled> | typeof NOT_HANDLED> {
  if (!req.method.startsWith('work.routines.')) return NOT_HANDLED
  const e = routinesEngine(ctx)
  const store = e.store
  const now = e.clock()
  const p = (req as { params?: Record<string, unknown> }).params ?? {}
  const mine = (id: unknown) => store.get(String(id)) ?? refuse(`no routine ${String(id)}`)
  if (req.method.startsWith('work.routines.play')) return handlePlays(req, ctx, by, routinesSeams.current?.host ?? routinesHost()!, now)
  switch (req.method) {
    case 'work.routines.list': {
      const routines: RoutineRow[] = store.list(p.workspaceId as string | undefined).map((r) => e.row(r))
      return handled({ routines })
    }
    case 'work.routines.runs': {
      mine(p.id)
      const runs: RoutineRun[] = store.runs(String(p.id), (p.limit as number | undefined) ?? 50)
      return handled({ runs })
    }
    case 'work.routines.save': {
      person(by)
      const q = req.params as Extract<ClientRequest, { method: 'work.routines.save' }>['params']
      const host = routinesSeams.current?.host ?? routinesHost()!
      if (q.workspaceId !== WORK_HOME && !host.workspace(q.workspaceId)) refuse(`no workspace ${q.workspaceId}`)
      const t = checked(q.trigger, q.workspaceId, host, now)
      // Left out, an edit keeps the job it has (a form that does not show it saves it untouched); null drops it.
      const job = q.job === undefined ? (q.id ? (mine(q.id).job ?? null) : null) : q.job
      if (job) {
        // A job needs no words; it runs on its own, never with a play.
        if (!registeredJob(job)) refuse(`No such job: ${job}`)
        if (q.playId) refuse('a routine runs a job or a play, not both')
      } else if (q.playId) {
        const play = new PlayStore(ctx.db).get(q.playId)
        if (!play || play.proposed || play.workspaceId !== q.workspaceId) refuse(`no play ${q.playId} in this workspace`)
        if (play!.takes.length) refuse(`“${play!.name}” takes ${play!.takes.join(', ')}: a routine runs only a play that takes nothing`)
      } else if (!q.prompt) refuse('say what it does, or pick a play for it to run')
      const fields = { workspaceId: q.workspaceId, projectId: q.projectId ?? null, kind: kindOf(q.ends), name: q.name, prompt: q.prompt, playId: q.playId ?? null, job, model: q.model ?? null, reasoning: q.reasoning ?? null, trigger: t.trigger, ends: q.ends, nextAt: t.nextAt, cursor: t.cursor }
      const saved = q.id ? (mine(q.id), store.update(q.id, fields)!) : store.create({ ...fields, createdBy: 'owner' }, now)
      ctx.push({ push: 'work.routines', workspaceId: saved.workspaceId, id: saved.id })
      return handled(e.row(saved))
    }
    case 'work.routines.pause': {
      person(by)
      const r = mine(p.id)
      if (r.proposed) refuse('a proposal is not running; create it first')
      const resume = p.paused !== true
      // Resumed, a schedule starts again from now: the times it was paused through are not owed.
      const s = r.trigger.on === 'schedule' ? parseSchedule(r.trigger.rrule) : null
      store.setEnabled(r.id, resume, resume && s && r.trigger.on === 'schedule' ? nextAt(s, r.trigger.tz, now) : undefined)
      // Nor are the LifeOS events it was paused through.
      if (resume && r.cursor.after !== undefined) store.setCursor(r.id, { ...r.cursor, after: Math.max(r.cursor.after, now) })
      ctx.push({ push: 'work.routines', workspaceId: r.workspaceId, id: r.id })
      return handled(e.row(store.get(r.id)!))
    }
    case 'work.routines.runNow': {
      person(by)
      const r = mine(p.id)
      if (r.proposed) refuse('a proposal runs nothing until the owner creates it')
      const run = await e.runNow(r)
      return handled(run ?? store.inFlight(r.id))
    }
    case 'work.routines.remove': {
      person(by)
      const r = mine(p.id)
      store.remove(r.id)
      ctx.push({ push: 'work.routines', workspaceId: r.workspaceId, id: r.id })
      return handled(null)
    }
  }
  return NOT_HANDLED
}

const DAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

const WatchInput = z.object({
  name: z.string().trim().min(1).max(120).describe('What it waits for, in a few words: "Reply from events booking"'),
  addon: z.string().describe('The add-on to read, by name'),
  tool: z.string().describe('A read-only tool of that add-on the owner set to Runs'),
  arguments: z.record(z.string(), z.unknown()).optional().describe('Fixed now; every read uses exactly these'),
  fire: z.enum(['changed', 'non-empty']).optional().describe('changed (default): when the answer differs from the last read; non-empty: when it has anything in it'),
  everyMinutes: z.number().int().min(5).max(1440).optional().describe('How often to read; default 15'),
  until: z.string().optional().describe('A date (YYYY-MM-DD) the watch ends on. Without it the watch ends when it first fires.')
})

const ProposeInput = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(8000).describe('What each run does, in the owner’s words'),
  days: z.array(z.enum(DAY_CODES)).min(1).optional().describe('Run on these days, at `at`'),
  at: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('HH:MM, 24-hour, the owner’s time'),
  everyMinutes: z.number().int().min(5).max(1440).optional().describe('Or run every so many minutes'),
  lifeosEvents: z.array(z.enum(Object.keys(LIFEOS_TRIGGER_KINDS) as [string, ...string[]])).min(1).optional().describe('Or run when one of these happens in this workspace’s sector')
})

const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function tools(scope: WorkScope): WorkTool[] {
  return [
    ...playTools(scope),
    {
      name: 'watch_create',
      description:
        'Wake this thread when something changes, without a model: the host reads an add-on tool on its own every few minutes and wakes you with the answer when it changes. Only tools the owner set to Runs; the arguments are fixed now. Use it to wait on a reply, a status or a file instead of checking by hand.',
      input: WatchInput,
      readOnly: false,
      async run(raw, tc) {
        const a = raw as z.infer<typeof WatchInput>
        const e = routinesEngine(tc)
        const host = routinesSeams.current?.host ?? routinesHost()!
        const workspaceId = tc.scope.workspaceId ?? WORK_HOME
        const now = (routinesSeams.current?.now ?? Date.now)()
        const live = e.store.watchesOf([tc.sessionId]).filter((w) => w.enabled && !w.ended)
        if (live.length >= WATCHES_PER_THREAD) return { ...workText(`This thread already keeps ${live.length} watches; let one end first.`), isError: true }
        const until = a.until ? Date.parse(`${a.until}T23:59:59`) : NaN
        if (a.until && (!Number.isFinite(until) || until <= now)) return { ...workText(`until: ${a.until} is not a day still to come`), isError: true }
        if (a.until && until > now + WATCH_DAYS_MAX * 86_400_000) return { ...workText(`until: a watch lasts at most ${WATCH_DAYS_MAX} days`), isError: true }
        const addon = host.addon(workspaceId, a.addon)
        if (addon && !host.readOnly(addon.id, a.tool)) return { ...workText(`${addon.name}'s ${a.tool} is not a read: a watch reads only with a tool its server calls read-only`), isError: true }
        try {
          const t = checked({ on: 'read', addon: a.addon, tool: a.tool, args: a.arguments ?? {}, fire: a.fire ?? 'changed', everySec: (a.everyMinutes ?? 15) * 60 }, workspaceId, host, now)
          const ends: RoutineEnds = a.until ? { kind: 'day', at: until } : { kind: 'once' }
          const r = e.store.create(
            { workspaceId, kind: 'watch', name: a.name, prompt: a.name, trigger: t.trigger, ends, resumeSessionId: tc.sessionId, nextAt: t.nextAt, cursor: t.cursor, madeIn: tc.sessionId, createdBy: 'model' },
            now
          )
          tc.push({ push: 'work.routines', workspaceId, id: r.id })
          const end = a.until ? `until ${a.until}` : 'until it first changes'
          return workText(`Watching “${a.name}”: ${triggerWords(t.trigger).toLowerCase()}, ${end}. This thread will be woken with the new answer; nothing else runs.`)
        } catch (err) {
          return { ...workText(err instanceof Error ? err.message : String(err)), isError: true }
        }
      }
    },
    {
      name: 'routine_propose',
      description:
        'Offer the owner a routine: work that runs on its own on a schedule or when something happens in LifeOS. It runs nothing: it shows in his Routines for him to create, change or drop. Give exactly one of days with at, everyMinutes, or lifeosEvents.',
      input: ProposeInput,
      readOnly: false,
      async run(raw, tc) {
        const a = raw as z.infer<typeof ProposeInput>
        const given = [a.days || a.at ? 1 : 0, a.everyMinutes ? 1 : 0, a.lifeosEvents ? 1 : 0].reduce((x, y) => x + y, 0)
        if (given !== 1) return { ...workText('Give exactly one of: days with at, everyMinutes, or lifeosEvents.'), isError: true }
        let trigger: Trigger
        if (a.lifeosEvents) trigger = { on: 'lifeos', kinds: a.lifeosEvents }
        else if (a.everyMinutes) trigger = { on: 'schedule', rrule: scheduleRrule({ every: 'minutes', interval: a.everyMinutes }), tz: localZone() }
        else {
          if (!a.days || !a.at) return { ...workText('A schedule needs both days and at.'), isError: true }
          const [h, m] = a.at.split(':').map(Number) as [number, number]
          if (h > 23 || m > 59) return { ...workText(`at: ${a.at} is not a time`), isError: true }
          trigger = { on: 'schedule', rrule: scheduleRrule({ every: 'week', days: a.days.map((d) => DAY_CODES.indexOf(d)), hour: h, minute: m }), tz: localZone() }
        }
        const e = routinesEngine(tc)
        const workspaceId = tc.scope.workspaceId ?? WORK_HOME
        const r = e.store.create(
          { workspaceId, kind: 'routine', name: a.name, prompt: a.prompt, trigger, ends: { kind: 'never' }, nextAt: null, proposed: true, madeIn: tc.sessionId, createdBy: 'model' },
          (routinesSeams.current?.now ?? Date.now)()
        )
        tc.push({ push: 'work.routines', workspaceId, id: r.id })
        return workText(`Proposed “${a.name}” (${triggerWords(trigger)}). It waits in Routines for the owner to create; nothing runs until he does.`)
      }
    }
  ]
}

export const routines: WorkModule = {
  id: 'routines',
  mentions: routineMentions,
  ensure: ensureRoutineTables,
  handle,
  tools,
  start(ctx) {
    return routinesEngine(ctx).start(routinesSeams.current?.interval === false ? { interval: false } : {})
  },
  sessionsRemoved(ids, ctx) {
    const e = routinesEngine(ctx)
    for (const w of e.store.watchesOf(ids)) e.store.remove(w.id)
  },
  workspaceRemoved(workspaceId, ctx) {
    routinesEngine(ctx).store.removeWorkspace(workspaceId)
    new PlayStore(ctx.db).removeWorkspace(workspaceId)
  }
}
