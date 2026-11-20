import { z } from 'zod'
import { CHIP_NOUN, ContextChipSchema, type ChipKind, type ContextChip } from './work/canvas'
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
  /** what to do, in his words: the run's first message, after its play's instructions when it runs one */
  prompt: string
  /** the play each run starts, which takes nothing (`PlayRow`); null: the prompt alone */
  playId: string | null
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
  /** may be empty only when it runs a play */
  prompt: z.string().trim().max(8000),
  playId: z.string().nullable().optional(),
  trigger: TriggerSchema,
  ends: RoutineEndsSchema,
  model: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional()
})

const RoutineRequestSchemas = [
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
export type RoutinesPush = { push: 'work.routines'; workspaceId: string; id: string } | PlaysPush


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
  'sheet.changed': 'A sheet changes',
  'mail.waiting': 'Sent mail gets no reply in time'
} as const
export type LifeosTriggerKind = keyof typeof LIFEOS_TRIGGER_KINDS

// ── plays ────────────────────────────────────────────────────────────────

/**
 * A play (docs/agents/work-plays.md): work he repeats in one job, saved once
 * and started with one press. It is a name, the instructions a thread
 * follows and what it takes in; starting one makes an ordinary Work thread
 * whose first message is the instructions with the things attached. A play
 * belongs to one workspace and carries no grant: whatever its thread would
 * send is held as any thread's is. A routine may run a play that takes
 * nothing (`RoutineRow.playId`).
 */
export const PLAY_TAKES = ['mail', 'task', 'event', 'file', 'date', 'text'] as const
export type PlayTake = (typeof PLAY_TAKES)[number]

/** The chip kinds that fill each thing a play takes; a date and a line of text are typed. */
export const PLAY_TAKE_CHIPS: Record<'mail' | 'task' | 'event' | 'file', readonly ChipKind[]> = {
  mail: ['mail'],
  task: ['task'],
  event: ['event'],
  file: ['doc', 'item']
}

export const isThingTake = (take: PlayTake): take is keyof typeof PLAY_TAKE_CHIPS => take in PLAY_TAKE_CHIPS

/** What a chip of this kind fills, or null when no play takes it. */
export function takeOfChip(kind: ChipKind): keyof typeof PLAY_TAKE_CHIPS | null {
  for (const take of Object.keys(PLAY_TAKE_CHIPS) as (keyof typeof PLAY_TAKE_CHIPS)[]) if (PLAY_TAKE_CHIPS[take].includes(kind)) return take
  return null
}

export interface PlayRow {
  id: string
  workspaceId: string
  name: string
  instructions: string
  /** what it takes in, each at most once, in `PLAY_TAKES` order */
  takes: PlayTake[]
  /** an agent's proposal: nothing starts it until he adds it */
  proposed: boolean
  /** the thread that proposed it, or the one it was saved from */
  madeIn: string | null
  /** the starter it was added from (`STARTER_PLAYS`), so it is not offered twice */
  starter: string | null
  createdBy: 'owner' | 'model'
  createdAt: number
  updatedAt: number
  host: string
}

const PlayTakesSchema = z
  .array(z.enum(PLAY_TAKES))
  .max(PLAY_TAKES.length)
  .transform((takes) => PLAY_TAKES.filter((t) => takes.includes(t)))

export const PLAY_NAME_MAX = 80
export const PLAY_INSTRUCTIONS_MAX = 8000

/** What one start hands the play: the things it takes as chips, and a date or a line of text when it takes them. */
export const PlayInputsSchema = z.object({
  chips: z.array(ContextChipSchema).max(4).default([]),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  text: z.string().trim().max(4000).optional()
})
export type PlayInputs = z.input<typeof PlayInputsSchema>

/** A play drafted from a thread, for him to edit before he saves it. */
export interface PlayDraft {
  name: string
  instructions: string
  takes: PlayTake[]
}

export const PlaysRequestSchemas = [
  /** → { plays: PlayRow[] }: a workspace's plays, proposals first */
  request('work.routines.plays', z.object({ workspaceId: z.string() })),
  /** → PlayRow: makes one (no id), changes one, or adds an agent's proposal (`id` of the proposal). A person's call only. */
  request(
    'work.routines.playSave',
    z.object({
      id: z.string().optional(),
      workspaceId: z.string(),
      name: z.string().trim().min(1).max(PLAY_NAME_MAX),
      instructions: z.string().trim().min(1).max(PLAY_INSTRUCTIONS_MAX),
      takes: PlayTakesSchema,
      starter: z.string().max(80).optional(),
      madeIn: z.string().optional()
    })
  ),
  /** → null: Delete, or Not now on a proposal. Threads it started stay. */
  request('work.routines.playRemove', z.object({ id: z.string() })),
  /** → { sessionId }: starts the play as a new Work thread with these inputs. A person's call only. */
  request('work.routines.playStart', z.object({ id: z.string(), inputs: PlayInputsSchema })),
  /** → PlayDraft: a model call, on his press only, that drafts a play from a finished Work thread. */
  request('work.routines.playDraft', z.object({ sessionId: z.string() }))
] as const

/** A workspace's plays changed: a screen asks `plays` again. */
export type PlaysPush = { push: 'work.routines.plays'; workspaceId: string }

export const PLAYS_CAPS = {
  'work.routines.plays': 'read',
  'work.routines.playSave': 'admin',
  'work.routines.playRemove': 'admin',
  'work.routines.playStart': 'operate',
  'work.routines.playDraft': 'operate'
} satisfies CapsOf<typeof PlaysRequestSchemas>

const ROUTINE_CAPS = {
  'work.routines.list': 'read',
  'work.routines.runs': 'read',
  'work.routines.save': 'admin',
  'work.routines.pause': 'operate',
  'work.routines.runNow': 'operate',
  'work.routines.remove': 'admin'
} satisfies CapsOf<typeof RoutineRequestSchemas>
/** The pillar's whole wire: its routines and its plays. */
export const RoutinesRequestSchemas = [...RoutineRequestSchemas, ...PlaysRequestSchemas] as const
export const ROUTINES_CAPS = { ...ROUTINE_CAPS, ...PLAYS_CAPS } satisfies CapsOf<typeof RoutinesRequestSchemas>
export const ROUTINES_RELAY = {} satisfies RelayOf<typeof RoutinesRequestSchemas>

const LONG_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** A chip as the thread reads it: the composer's line (renderer work/canvas/chips.ts `chipLine`). */
function chipLine(chip: ContextChip): string {
  const ref = chip.ref as { at: string; table?: string; id?: string; path?: string; pillar?: string }
  const where =
    ref.at === 'lifeos' ? `LifeOS ${ref.table} ${ref.id}` : ref.at === 'file' ? String(ref.path) : ref.at === 'item' ? `canvas item ${ref.id}` : ref.at === 'work' ? `Work ${ref.pillar} ${ref.id}` : JSON.stringify(ref)
  const head = `About this ${CHIP_NOUN[chip.kind] ?? chip.kind}: ${chip.label} (${where})`
  const under = (chip.quote ?? chip.excerpt)?.trim() ?? ''
  return under ? `${head}\n${under.split('\n').map((line) => `> ${line}`).join('\n')}` : head
}

/**
 * Why these inputs do not fill the play, or null when they do: each thing it
 * takes once, by a chip of that kind; its date and its text when it takes
 * them; nothing it does not take.
 */
export function playInputsProblem(takes: readonly PlayTake[], inputs: PlayInputs): string | null {
  const chips = inputs.chips ?? []
  for (const take of takes) {
    if (isThingTake(take) && chips.filter((c) => PLAY_TAKE_CHIPS[take].includes(c.kind)).length !== 1) return `it takes one ${take}`
    if (take === 'date' && !inputs.date) return 'it takes a date'
    if (take === 'text' && !inputs.text?.trim()) return 'it takes a line of text'
  }
  if (inputs.date && !realDate(inputs.date)) return `${inputs.date} is not a day`
  const stray = chips.find((c) => {
    const take = takeOfChip(c.kind)
    return !take || !takes.includes(take)
  })
  if (stray) return `it takes no ${CHIP_NOUN[stray.kind] ?? stray.kind}`
  if (inputs.date && !takes.includes('date')) return 'it takes no date'
  if (inputs.text?.trim() && !takes.includes('text')) return 'it takes no text'
  return null
}

/** Whether a YYYY-MM-DD names a day that exists. */
const realDate = (date: string): boolean => {
  const at = new Date(`${date}T12:00:00Z`)
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === date
}

/** A play's thread's name: the play, and the thing it started from. */
export function playTitle(play: Pick<PlayRow, 'name'>, inputs: PlayInputs): string {
  const about = inputs.chips?.[0]?.label.trim()
  const title = about ? `${play.name}: ${about}` : play.name
  return title.length > 80 ? `${title.slice(0, 79)}…` : title
}

/** The first message of a play's thread: what it is about, then his line of text, then the instructions, and where it came from. */
export function playMessage(play: Pick<PlayRow, 'name' | 'instructions'>, inputs: PlayInputs): string {
  const about = (inputs.chips ?? []).map(chipLine)
  if (inputs.date) about.push(`The date: ${LONG_DATE.format(new Date(`${inputs.date}T12:00:00Z`))} (${inputs.date})`)
  if (inputs.text?.trim()) about.push(`From me:\n${inputs.text.trim().split('\n').map((line) => `> ${line}`).join('\n')}`)
  const head = about.length ? `${about.join('\n')}\n\n` : ''
  return `${head}${play.instructions.trim()}\n\n---\nStarted from the play “${play.name}”.`
}

/** A starter play: offered for him to add in a workspace of its sector, never added by itself. */
export interface StarterPlay {
  /** stable: `<sector>.<slug>`, kept on the play he adds as `starter` */
  key: string
  name: string
  takes: PlayTake[]
  instructions: string
}

/**
 * The starters, by sector. Each asks only for what the app can do today:
 * tasks and drafts in LifeOS, events drafted for his approval, a sheet line,
 * the code thread he opens from a task himself. Frame.io is not signed in
 * yet, so the Hypixel brief keeps a Frame.io link in a task and opens no
 * round.
 */
export const STARTER_PLAYS: Record<string, readonly StarterPlay[]> = {
  ref: [
    {
      key: 'ref.assignment',
      name: 'Game assignment',
      takes: ['mail'],
      instructions: [
        'This mail assigns me a game. Read it for the date, start time, schools, level, site and fee.',
        '1. Draft a calendar event for the game: the schools as the title, the site as the place, from the start time for two hours.',
        '2. Draft a second event before it for the drive there, from the site’s address. If you cannot tell the drive time, ask me rather than guess.',
        '3. Add a line to my referee pay sheet: the date, the schools, the level and the fee. If you cannot find the sheet, ask me which one.',
        '4. Tell me what you drafted and what the mail left unclear.'
      ].join('\n')
    },
    {
      key: 'ref.month',
      name: 'Month’s pay',
      takes: ['date'],
      instructions: [
        'Look at my referee pay sheet for the month of this date.',
        '1. Total the fees and count the games.',
        '2. List the games on my calendar that month that have no pay line, and the pay lines with no game on my calendar.',
        'Change nothing; tell me what you found.'
      ].join('\n')
    }
  ],
  hypixel: [
    {
      key: 'hypixel.brief',
      name: 'Video brief',
      takes: ['mail'],
      instructions: [
        'This mail is a brief for a video.',
        '1. Pull out what is asked: the video, its length and format, the deadline and who signs off.',
        '2. Add a task for each step from first cut to delivery, due on dates that work back from the deadline. If the brief has a Frame.io link, put it in the first task: Frame.io is not connected here yet.',
        '3. Draft a reply that confirms what I will deliver and by when, and asks about anything the brief leaves open.'
      ].join('\n')
    },
    {
      key: 'hypixel.notes',
      name: 'Review notes to tasks',
      takes: ['text'],
      instructions: [
        'These are review notes on a cut.',
        '1. Turn each note into a task, with its timecode at the start of the title when it has one.',
        '2. Merge notes that ask for the same change.',
        '3. Tell me which notes you could not turn into a clear task.'
      ].join('\n')
    }
  ],
  cosmic: [
    {
      key: 'cosmic.bug',
      name: 'Bug report to a task',
      takes: ['mail'],
      instructions: [
        'This mail reports a problem in one of our games.',
        '1. Write it up as a task: what happens, what should happen, how to make it happen, and the server and player if it names them.',
        '2. If a task for the same problem is already open, add to that one instead.',
        '3. Draft a short reply that thanks the reporter and says we are looking into it.',
        'I start the code work from the task with Open a code thread….'
      ].join('\n')
    }
  ],
  purdue: [
    {
      key: 'purdue.event',
      name: 'Event request',
      takes: ['mail'],
      instructions: [
        'This mail asks for an esports event.',
        '1. Pull out the date, the room, the head count, the games and the contact.',
        '2. Add a checklist of tasks: room booking, equipment, staff, sign-ups and promotion, each due in good time before the event.',
        '3. Draft a reply that confirms what I have and asks for what is missing.',
        'Book nothing.'
      ].join('\n')
    }
  ],
  unify: [
    {
      key: 'unify.request',
      name: 'Client request',
      takes: ['mail'],
      instructions: [
        'This mail is a request from a client.',
        '1. Add one task for it: what they asked, by when, and who they are.',
        '2. Draft a reply that says I have it and when they will hear back; if the mail sets no date, say by the end of this week.',
        'Promise no price and no other date.'
      ].join('\n')
    }
  ],
  life: [
    {
      key: 'life.bill',
      name: 'Bill to pay',
      takes: ['mail'],
      instructions: [
        'This mail is a bill.',
        'Add a task to pay it, due three days before the bill is due, with the amount and how to pay in its notes.',
        'If it is already paid or pays itself, say so and add nothing.'
      ].join('\n')
    }
  ]
}
