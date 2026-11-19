import { z } from 'zod'
import { TriggerSchema, type Trigger } from './work/triggers'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The routines pillar's wire (docs/agents/work-routines.md): work the host
 * starts on its own. A routine runs a prompt as a new Work thread when its
 * trigger fires (a schedule, a LifeOS event, a watched read, a file someone
 * else changed); a watch is a routine with an end, and one an agent sets
 * wakes the thread that set it instead of starting another. Every run is a
 * thread, one click away.
 *
 * Only a person makes a routine that acts: `save` needs `admin` and refuses
 * a thread's own call. An agent may propose one (`routine_propose`), which
 * shows here as `proposed` and runs nothing until he creates it, or set a
 * watch (`watch_create`), which reads with tools he set to Runs and wakes
 * its own thread.
 */

export const ROUTINE_KINDS = ['routine', 'watch'] as const
export type RoutineKind = (typeof ROUTINE_KINDS)[number]

/**
 * What became of one firing. `starting`: the row is written, the thread not
 * yet made. `running`: its thread works. Then one of: `quiet` (nothing held,
 * nothing asked, no failure: settled as read), `held` (it left something in
 * the Outbox), `asked` (it waits on a question), `failed`, `fired` (a watch
 * woke its thread), `skipped` (its routine's last run was still working).
 */
export const ROUTINE_RUN_STATES = ['starting', 'running', 'quiet', 'held', 'asked', 'failed', 'fired', 'skipped'] as const
export type RoutineRunState = (typeof ROUTINE_RUN_STATES)[number]

/** When a routine stops: never, after a day, or after its first firing. A routine with an end is a watch. */
export const RoutineEndsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('never') }),
  z.object({ kind: z.literal('day'), at: z.number().int().positive() }),
  z.object({ kind: z.literal('once') })
])
export type RoutineEnds = z.infer<typeof RoutineEndsSchema>

/** A routine as a screen lists it. */
export interface RoutineRow {
  id: string
  workspaceId: string
  projectId: string | null
  kind: RoutineKind
  name: string
  /** what to do, in his words: the run's first message */
  prompt: string
  model: string | null
  reasoning: string | null
  trigger: Trigger
  /** the trigger in plain words: "Weekdays at 7:00 AM", "Every 15 minutes" */
  words: string
  ends: RoutineEnds
  /** false: paused, or a watch that has ended */
  enabled: boolean
  /** an agent's proposal: it runs nothing until he creates it */
  proposed: boolean
  /** a watch an agent set: its firing wakes this thread */
  resumeSessionId: string | null
  /** the thread that proposed it or set it */
  madeIn: string | null
  /** when the schedule next fires; null for a trigger with no clock */
  nextAt: number | null
  lastAt: number | null
  lastState: RoutineRunState | null
  /** the last run's outcome in words ("Held 2", "Nothing to do", "Failed: …"), or a watch's last read ("Read at 2:02 PM, nothing new") */
  lastWords: string | null
  /** when a watched read or file was last looked at, for "Read at 2:02 PM, nothing new" */
  checkedAt: number | null
  /** why it cannot fire now ("Waiting on LifeOS"), or null */
  waiting: string | null
  /** a run of it is working now */
  running: boolean
  /** a watch that ended (its day passed, or it fired once) */
  ended: boolean
  createdBy: 'owner' | 'model'
  createdAt: number
  /** the host it runs on; a client merges hosts' lists */
  host: string
}

export interface RoutineRun {
  id: string
  routineId: string
  sessionId: string | null
  firedAt: number
  /** what fired it, in words: "Weekdays at 7:00 AM", "2 new mail" */
  cause: string
  /** firings folded into this one: missed while the host was down, or due while the last run still worked */
  folded: number
  state: RoutineRunState
  /** the outcome in words: "Held 3", "Nothing to do", "Failed: …" */
  summary: string
}

const RoutineFieldsSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(8000),
  trigger: TriggerSchema,
  ends: RoutineEndsSchema,
  model: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional()
})

export const RoutinesRequestSchemas = [
  /** → { routines: RoutineRow[] }: this host's routines, proposals and watches; one workspace's, or all */
  request('work.routines.list', z.object({ workspaceId: z.string().optional() })),
  /** → { runs: RoutineRun[] }: newest first */
  request('work.routines.runs', z.object({ id: z.string(), limit: z.number().int().positive().max(200).optional() })),
  /** → RoutineRow: makes one (no id), changes one, or creates an agent's proposal (`id` of the proposal). A person's call only. */
  request('work.routines.save', RoutineFieldsSchema.extend({ id: z.string().optional() })),
  /** → RoutineRow: Pause or Resume */
  request('work.routines.pause', z.object({ id: z.string(), paused: z.boolean() })),
  /** → RoutineRun: Run now, whatever the trigger */
  request('work.routines.runNow', z.object({ id: z.string() })),
  /** → null: Delete, or Not now on a proposal. Its runs' threads stay. */
  request('work.routines.remove', z.object({ id: z.string() }))
] as const

/** A routine changed (made, edited, fired, settled, removed): a screen asks `list` again. */
export type RoutinesPush = { push: 'work.routines'; workspaceId: string; id: string }

export const ROUTINES_CAPS = {
  'work.routines.list': 'read',
  'work.routines.runs': 'read',
  'work.routines.save': 'admin',
  'work.routines.pause': 'operate',
  'work.routines.runNow': 'operate',
  'work.routines.remove': 'admin'
} satisfies CapsOf<typeof RoutinesRequestSchemas>
export const ROUTINES_RELAY = {} satisfies RelayOf<typeof RoutinesRequestSchemas>

// ── the schedule ─────────────────────────────────────────────────────────

/**
 * The part of RFC 5545's RRULE a schedule uses, both ways: a weekly rule
 * on some days at one time (`FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=7;BYMINUTE=0`),
 * or a repeat every so many minutes or hours (`FREQ=MINUTELY;INTERVAL=15`).
 * Any other rule is refused where it is saved.
 */
export type Schedule = { every: 'week'; days: number[]; hour: number; minute: number } | { every: 'minutes'; interval: number }

/** Weekday codes, Sunday first, as `Date.getDay()` numbers them. */
export const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

export function parseSchedule(rrule: string): Schedule | null {
  const parts = new Map(
    rrule
      .replace(/^RRULE:/i, '')
      .split(';')
      .filter(Boolean)
      .map((p) => p.split('=') as [string, string])
      .map(([k, v]) => [k?.toUpperCase(), (v ?? '').toUpperCase()])
  )
  const freq = parts.get('FREQ')
  const int = (key: string, min: number, max: number, fallback?: number): number | null => {
    const raw = parts.get(key)
    if (raw === undefined) return fallback ?? null
    const n = Number(raw)
    return Number.isInteger(n) && n >= min && n <= max ? n : null
  }
  if (freq === 'MINUTELY' || freq === 'HOURLY') {
    const interval = int('INTERVAL', 1, freq === 'MINUTELY' ? 1440 : 168, 1)
    if (interval === null) return null
    const minutes = freq === 'HOURLY' ? interval * 60 : interval
    return minutes >= 5 ? { every: 'minutes', interval: minutes } : null
  }
  if (freq !== 'WEEKLY' && freq !== 'DAILY') return null
  const hour = int('BYHOUR', 0, 23)
  const minute = int('BYMINUTE', 0, 59, 0)
  if (hour === null || minute === null) return null
  const byday = parts.get('BYDAY')
  const days = freq === 'DAILY' || !byday ? [0, 1, 2, 3, 4, 5, 6] : byday.split(',').map((d) => RRULE_DAYS.indexOf(d as (typeof RRULE_DAYS)[number]))
  if (!days.length || days.some((d) => d < 0)) return null
  return { every: 'week', days: [...new Set(days)].sort(), hour, minute }
}

export function scheduleRrule(s: Schedule): string {
  if (s.every === 'minutes') return s.interval % 60 === 0 ? `FREQ=HOURLY;INTERVAL=${s.interval / 60}` : `FREQ=MINUTELY;INTERVAL=${s.interval}`
  return `FREQ=WEEKLY;BYDAY=${[...s.days].sort().map((d) => RRULE_DAYS[d]).join(',')};BYHOUR=${s.hour};BYMINUTE=${s.minute}`
}

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "7:00 AM" */
export function clockWords(hour: number, minute: number): string {
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}

/** The days of a weekly schedule in words: "Weekdays", "Every day", "Mondays", "Tue and Thu". */
export function daysWords(days: readonly number[]): string {
  const set = [...new Set(days)].sort()
  if (set.length === 7) return 'Every day'
  if (set.join() === '1,2,3,4,5') return 'Weekdays'
  if (set.join() === '0,6') return 'Weekends'
  if (set.length === 1) return DAY_NAMES[set[0]!]!
  const names = set.map((d) => DAY_SHORT[d]!)
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** "Weekdays at 7:00 AM", "Every 15 minutes", "Every 2 hours". */
export function scheduleWords(s: Schedule): string {
  if (s.every === 'minutes') {
    if (s.interval % 60 === 0) return s.interval === 60 ? 'Every hour' : `Every ${s.interval / 60} hours`
    return `Every ${s.interval} minutes`
  }
  return `${daysWords(s.days)} at ${clockWords(s.hour, s.minute)}`
}

/** The LifeOS events a routine can start on, and how a person names each. */
export const LIFEOS_TRIGGER_KINDS = {
  'mail.received': 'Mail arrives',
  'task.created': 'A task is filed',
  'task.done': 'A task is done',
  'draft.sent': 'A draft is sent',
  'event.soon': 'An event is about to start',
  'doc.changed': 'A document changes',
  'sheet.changed': 'A sheet changes'
} as const
export type LifeosTriggerKind = keyof typeof LIFEOS_TRIGGER_KINDS
