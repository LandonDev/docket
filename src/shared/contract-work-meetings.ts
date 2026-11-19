import { z } from 'zod'
import { CanvasSourceSchema } from './work/canvas'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The meetings pillar's wire (docs/agents/work-meetings.md). Its methods are
 * `work.meetings.<verb>` and its push `work.meetings`; src/shared/work/wire.ts
 * has the helpers and the rules.
 *
 * A meeting belongs to one canvas item of kind `meeting` and is named by
 * that item's id. It is made from a recording, transcribed on the host that
 * holds it, or from a transcript file, parsed. Everything that points into
 * it carries segment ids and seconds, so a click seeks the player.
 */

export const MEETING_STATUSES = ['empty', 'transcribing', 'ready', 'failed'] as const
export type MeetingStatus = (typeof MEETING_STATUSES)[number]

/** A speaker is an id; the name is set once and every turn follows. */
export interface MeetingSpeaker {
  /** `S1`, `S2`, … in order of first speaking */
  id: string
  /** "Speaker 1": what shows until there is a name */
  label: string
  /** the owner's name for them, or the one a transcript file gave */
  name: string | null
  /** a name a stored voice suggests; never applied until he takes it */
  suggested?: string
}

/** One turn: a stretch one speaker held. */
export interface MeetingSegment {
  /** `s1`, `s2`, … stable once made */
  id: string
  /** a speaker's id; null when the file named none */
  speaker: string | null
  /** seconds from the start of the recording */
  start: number
  /** null when a transcript file gave only a start */
  end: number | null
  text: string
}

/** One line of the notes: a summary point, a decision or an open question. */
export interface MeetingNote {
  id: string
  text: string
  /** the transcript's own words it rests on, when the writer quoted them and the checker found them */
  quote?: string
  /** the turns it rests on */
  refs: string[]
  /** the moment to play, in seconds; null for a meeting with no times */
  at: number | null
}

export const MEETING_ACTION_STATES = ['proposed', 'filed', 'rejected'] as const
/** A task the meeting yielded. It waits (`proposed`) until the owner accepts, which files it in LifeOS (`filed`). */
export interface MeetingAction extends MeetingNote {
  /** when it is due, `YYYY-MM-DD` or a full ISO time */
  due?: string
  state: (typeof MEETING_ACTION_STATES)[number]
  /** the LifeOS task: the one filed on accept, or one that already existed */
  lifeosTaskId?: string
}

export interface MeetingNotes {
  summary: MeetingNote[]
  decisions: MeetingNote[]
  questions: MeetingNote[]
  actions: MeetingAction[]
  /** when they were last written, and whether that write can be undone */
  writtenAt: number
  canUndo: boolean
}

export interface MeetingProgress {
  /** decoding the file, finding who speaks, then the words */
  phase: 'decoding' | 'speakers' | 'words'
  /** `words`: how far the transcript reaches, in seconds. `speakers`: steps done */
  done: number
  total: number
}

export interface Meeting {
  itemId: string
  sessionId: string
  title: string
  status: MeetingStatus
  /** goes up on every change */
  rev: number
  /** what it was made from; null while empty */
  from: 'recording' | 'transcript' | null
  progress?: MeetingProgress
  /** failed: why, in plain words */
  error?: string
  /** seconds; 0 when unknown */
  durationSec: number
  /** the recording, when there is one to play */
  media?: {
    kind: 'audio' | 'video'
    /** the host that holds it */
    host: string
    /** a small mono copy for the player, read in ranges with `attachment.readRange` */
    audio?: { path: string; bytes: number }
  }
  /** the outline for the waveform, 0 to 1 */
  peaks: number[]
  speakers: MeetingSpeaker[]
  segments: MeetingSegment[]
  notes: MeetingNotes | null
  transcribedAt?: number
}

/** A stored voice: a name and how many meetings it was heard in. The voice itself never leaves its host. */
export interface MeetingVoice {
  name: string
  meetings: number
  updatedAt: number
}

const itemId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

export const MeetingsRequestSchemas = [
  /** → { meeting: Meeting | null }: null when the item has no meeting yet */
  request('work.meetings.get', z.object({ itemId })),
  /**
   * Makes the item's meeting from its source, or from `source` (a file on this
   * host: a recording to transcribe here, or a transcript to parse), and
   * again after a failure. → { meeting }
   */
  request('work.meetings.start', z.object({ itemId, source: CanvasSourceSchema.optional() })),
  /** Stops a transcription. → { meeting } */
  request('work.meetings.cancel', z.object({ itemId })),
  /** Names a speaker (null takes the name back), and keeps their voice under that name on this host. → { meeting } */
  request('work.meetings.speaker', z.object({ itemId, speakerId: z.string().max(16), name: z.string().trim().min(1).max(120).nullable() })),
  /**
   * The owner's word on tasks the meeting yielded: accept files each in LifeOS
   * for the workspace's sector, reject drops it. → { meeting, failed: { id, error }[] }
   */
  request('work.meetings.decide', z.object({ itemId, actionIds: z.array(z.string().max(32)).min(1).max(200), decision: z.enum(['accept', 'reject']) })),
  /** Puts back the notes as they were before the agent's last write. → { meeting } */
  request('work.meetings.undoNotes', z.object({ itemId })),
  /** → { voices: MeetingVoice[] }: the names this host keeps a voice for */
  request('work.meetings.voices', z.object({}).optional()),
  /** Forgets the voice kept under a name on this host. → { voices } */
  request('work.meetings.forgetVoice', z.object({ name: z.string().min(1).max(120) }))
] as const

/** A meeting changed: the pane asks for it again when `rev` is past what it holds. */
export type MeetingsPush = { push: 'work.meetings'; itemId: string; sessionId: string; rev: number; status: MeetingStatus }

export const MEETINGS_CAPS = {
  'work.meetings.get': 'read',
  'work.meetings.start': 'operate',
  'work.meetings.cancel': 'operate',
  'work.meetings.speaker': 'operate',
  // Accepting a task is his press: it files in LifeOS.
  'work.meetings.decide': 'approve',
  'work.meetings.undoNotes': 'operate',
  'work.meetings.voices': 'read',
  'work.meetings.forgetVoice': 'operate'
} satisfies CapsOf<typeof MeetingsRequestSchemas>
/** Every method is carried to the host that holds the thread: a meeting's rows and files are that host's. */
export const MEETINGS_RELAY = {} satisfies RelayOf<typeof MeetingsRequestSchemas>

/** m:ss under an hour, h:mm:ss from an hour up; `long` holds the hour's place through a recording that passes an hour. */
export function meetingTime(seconds: number, long = false): string {
  const t = Math.max(0, Math.floor(seconds))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const two = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return h > 0 || long ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}
