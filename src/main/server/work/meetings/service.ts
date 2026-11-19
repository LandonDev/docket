import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Meeting, MeetingVoice } from '@shared/contract-work-meetings'
import { errorText, type CanvasItem, type CanvasSource } from '@shared/work'
import { attachmentDir } from '../../attachmentDir'
import type { WorkCtx } from '../modules'
import { onPipelineEvents } from './events'
import { fileTask, taskExists } from './filing'
import { foldStrays, Merger, segmentsOf, speakerIds, type DocSegment } from './merge'
import { checkNotes, undoneNotes, type NotesInput } from './notes'
import { displayName, parseTranscript } from './parse'
import { tokensOf } from './quotes'
import { MEDIA_EXTS, MEETING_FORMAT, TRANSCRIPT_EXTS, type PipelineEvent, type RawTranscript, type RawVoices } from './raw'
import { audioPathOf, emptyDoc, meetingOf, MeetingStore, type MeetingDoc, type MeetingRow, type StoredNotes } from './store'
import { Voices } from './voices'

/**
 * What a meeting does (docs/agents/work-meetings.md): made from a file,
 * transcribed here or parsed, its speakers named, its notes checked, its
 * tasks filed once the owner accepts. The module's methods and the
 * thread's tools both come through this one object per database.
 */

/** A transcript file larger than this is not one. */
const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024
/** How often a running transcription writes what it has and tells the pane. */
const TELL_EVERY_MS = 2000

/** The canvas items a meeting hangs on: `ctx.canvas`'s two reads. */
export interface MeetingItems {
  get(itemId: string): CanvasItem | null
  /** the thread whose pane a thread's items show in: its root */
  paneOf(sessionId: string): string
}

interface Job {
  abort: AbortController
  done: Promise<void>
  merger: Merger | null
  durationSec: number
  told: number
  /** the player's copy, once the decode has written it */
  audio: { name: string; path: string } | null
  /** why it stopped, when something other than the transcriber stopped it */
  why?: string
}

type FileSource = Extract<CanvasSource, { at: 'file' }>

const extOf = (path: string): string => extname(path).slice(1).toLowerCase()
export const isRecording = (path: string): boolean => (MEDIA_EXTS as readonly string[]).includes(extOf(path))
export const isTranscript = (path: string): boolean => (TRANSCRIPT_EXTS as readonly string[]).includes(extOf(path))

/** A file's name as a meeting's title: no extension, no path. */
export const titleOf = (path: string): string => basename(path, extname(path)).replace(/[_]+/g, ' ').trim() || 'Meeting'

/** The speakers a list of segments names, as the document keeps them. */
function speakersOf(segments: readonly DocSegment[], names: ReadonlyMap<string, string | null> = new Map()): MeetingDoc['speakers'] {
  const ids = [...new Set(segments.flatMap((s) => (s.speaker ? [s.speaker] : [])))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  return ids.map((id) => ({ id, label: `Speaker ${id.slice(1)}`, name: names.get(id) ?? null }))
}

export class Meetings {
  readonly store: MeetingStore
  readonly voices: Voices
  private readonly jobs = new Map<string, Job>()
  /** tasks being filed now, by meeting and words, so two accepts file one even across a rewrite that renumbers them */
  private readonly filing = new Set<string>()
  /** the start running for each meeting */
  private readonly starting = new Map<string, Promise<void>>()

  constructor(
    db: DatabaseSync,
    private readonly items: MeetingItems
  ) {
    this.store = new MeetingStore(db)
    this.voices = new Voices(db)
  }

  private wire(ctx: WorkCtx, row: MeetingRow): Meeting {
    return meetingOf(row, ctx.host, row.status === 'ready' ? this.voices.suggest(row.itemId, row.doc.speakers) : undefined)
  }

  private tell(ctx: WorkCtx, row: MeetingRow | null): void {
    if (row) ctx.push({ push: 'work.meetings', itemId: row.itemId, sessionId: row.sessionId, rev: row.rev, status: row.status })
  }

  private need(itemId: string): MeetingRow {
    const row = this.store.get(itemId)
    if (!row) throw new Error(`no meeting ${itemId}`)
    return row
  }

  /** The item's meeting; null when it has none yet. */
  get(ctx: WorkCtx, itemId: string): Meeting | null {
    const row = this.store.get(itemId)
    return row ? this.wire(ctx, row) : null
  }

  /** The thread whose pane a thread's meetings show in. */
  paneOf(sessionId: string): string {
    return this.items.paneOf(sessionId)
  }

  /** Where the meeting's original recording is on this host; a sentence when it has none here. */
  recordingPath(ctx: WorkCtx, itemId: string): string {
    const row = this.need(itemId)
    if (row.origin !== 'recording' || !row.source) throw new Error('This meeting has no recording.')
    if (row.source.host !== ctx.host) throw new Error(`The recording is on ${row.source.host}.`)
    return row.source.path
  }

  /** Whether an item is a meeting of this thread's pane. */
  owns(sessionId: string, itemId: string): boolean {
    const item = this.items.get(itemId)
    return !!item && item.kind === 'meeting' && item.sessionId === this.items.paneOf(sessionId)
  }

  /**
   * Makes the item's meeting from its file, or from `source`: a transcript
   * is parsed now, a recording starts transcribing and this answers at
   * once. A meeting that is ready, or already transcribing, is left as it
   * is unless a new file is named.
   */
  async start(ctx: WorkCtx, itemId: string, source?: CanvasSource): Promise<Meeting> {
    // One start at a time per meeting: a second waits for the first, so no job is ever left running out of reach.
    const before = this.starting.get(itemId) ?? Promise.resolve()
    const run = before.catch(() => undefined).then(() => this.startNow(ctx, itemId, source))
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.starting.set(itemId, settled)
    void settled.then(() => {
      if (this.starting.get(itemId) === settled) this.starting.delete(itemId)
    })
    return run
  }

  private async startNow(ctx: WorkCtx, itemId: string, source?: CanvasSource): Promise<Meeting> {
    const item = this.items.get(itemId)
    if (!item || item.kind !== 'meeting') throw new Error(`no meeting item ${itemId}`)
    const row = this.store.ensure(item)
    const named = source ?? (item.source.at === 'file' ? item.source : null)
    if (!source && (row.status === 'ready' || this.jobs.has(itemId))) return this.wire(ctx, row)
    const from = named ?? row.source
    if (!from) throw new Error('This meeting has no recording yet.')
    if (from.at !== 'file') throw new Error('A meeting is made from a file on this host.')
    if (this.jobs.has(itemId)) await this.cancel(ctx, itemId)
    const path = from.path
    const name = basename(path)
    let isFile = false
    try {
      isFile = statSync(path).isFile()
    } catch {
      /* not there */
    }
    const file: FileSource = { at: 'file', host: ctx.host, path }
    if (!isFile) return this.failed(ctx, itemId, `${name} is not on ${ctx.host} any more.`, { source: file })
    if (isTranscript(path)) return this.readTranscript(ctx, itemId, file)
    if (isRecording(path)) return this.transcribe(ctx, itemId, file)
    return this.failed(ctx, itemId, `${name} is not a recording or a transcript this reads. It takes audio, video, a Teams or Zoom transcript, or an .srt file.`, { source: file })
  }

  private failed(ctx: WorkCtx, itemId: string, error: string, more: Partial<MeetingRow> = {}): Meeting {
    const row = this.store.patch(itemId, { ...more, status: 'failed', error, progress: null })
    this.tell(ctx, row)
    if (!row) throw new Error(`no meeting ${itemId}`)
    return this.wire(ctx, row)
  }

  private async readTranscript(ctx: WorkCtx, itemId: string, file: FileSource): Promise<Meeting> {
    const name = basename(file.path)
    try {
      if (statSync(file.path).size > TRANSCRIPT_MAX_BYTES) throw new Error(`${name} is too large to be a transcript.`)
      const parsed = await parseTranscript(name, new Uint8Array(readFileSync(file.path)))
      const ids = new Map<string, string>()
      const names = new Map<string, string | null>()
      const segments: DocSegment[] = parsed.turns.map((turn, i) => {
        let speaker: string | null = null
        if (turn.speaker) {
          speaker = ids.get(turn.speaker) ?? `S${ids.size + 1}`
          ids.set(turn.speaker, speaker)
          names.set(speaker, displayName(turn.speaker))
        }
        return { id: `s${i + 1}`, speaker, start: turn.start, end: turn.end, text: turn.text }
      })
      const durationSec = segments.reduce((n, s) => Math.max(n, s.end ?? s.start), 0)
      const row = this.store.patch(itemId, {
        status: 'ready',
        source: file,
        origin: 'transcript',
        mediaKind: null,
        durationSec,
        progress: null,
        error: null,
        engine: parsed.format,
        peaks: [],
        audio: null,
        doc: { speakers: speakersOf(segments, names), segments, notes: filedOnly(this.need(itemId).doc.notes) },
        transcribedAt: Date.now()
      })
      this.voices.setMeeting(itemId, new Map())
      this.tell(ctx, row)
      return this.wire(ctx, row!)
    } catch (err) {
      return this.failed(ctx, itemId, errorText(err), { source: file, origin: 'transcript' })
    }
  }

  /** Where the player's copy goes: the thread's attachment directory. Null when the host has none set up (a test). */
  private audioTarget(row: MeetingRow, path: string): { name: string; path: string } | null {
    try {
      const dir = attachmentDir(row.sessionId)
      mkdirSync(dir, { recursive: true })
      const stem = basename(path, extname(path)).replace(/[^\w.-]+/g, '-').slice(0, 80) || 'recording'
      const name = `${stem}.${row.itemId.slice(0, 8)}.meeting.m4a`
      return { name, path: join(dir, name) }
    } catch {
      return null
    }
  }

  private transcribe(ctx: WorkCtx, itemId: string, file: FileSource): Meeting {
    const before = this.need(itemId)
    const old = audioPathOf(before)
    if (old) rmSync(old, { force: true })
    const audio = this.audioTarget(before, file.path)
    const row = this.store.patch(itemId, {
      status: 'transcribing',
      source: file,
      origin: 'recording',
      mediaKind: null,
      durationSec: 0,
      progress: { phase: 'decoding', done: 0, total: 0 },
      error: null,
      engine: null,
      peaks: [],
      audio: null,
      doc: { ...emptyDoc(), notes: filedOnly(before.doc.notes) },
      transcribedAt: null
    })!
    const abort = new AbortController()
    const token = randomUUID()
    const job: Job = { abort, done: Promise.resolve(), merger: null, durationSec: 0, told: 0, audio }
    const off = onPipelineEvents(token, (e) => this.heard(ctx, itemId, job, e))
    this.jobs.set(itemId, job)
    job.done = (async () => {
      try {
        // `here`: a recording is transcribed on the host that holds it and is never carried to another.
        const result = await ctx.convert({ from: extOf(file.path), to: MEETING_FORMAT, input: file.path, here: true, signal: abort.signal, options: { progress: token, ...(audio ? { audioOut: audio.path } : {}) } })
        const raw = JSON.parse(readFileSync(result.output, 'utf8')) as RawTranscript
        rmSync(result.output, { force: true })
        if (abort.signal.aborted) throw new Error('cancelled')
        this.finish(ctx, itemId, raw, audio)
      } catch (err) {
        const why = job.why ?? (abort.signal.aborted ? 'It was stopped before it finished. The recording is fine.' : sentenceOf(err, ctx.host))
        // A recording that fails keeps its player, when the copy was already made.
        if (this.store.get(itemId)) this.failed(ctx, itemId, why, audio && existsSync(audio.path) ? { audio: audio.name } : {})
      } finally {
        off()
        if (this.jobs.get(itemId) === job) this.jobs.delete(itemId)
      }
    })()
    this.tell(ctx, row)
    return this.wire(ctx, row)
  }

  /** One event of a running transcription: what is known so far goes into the row, and the pane is told every two seconds. */
  private heard(ctx: WorkCtx, itemId: string, job: Job, e: PipelineEvent): void {
    if (job.abort.signal.aborted) return
    const now = Date.now()
    const due = now - job.told >= TELL_EVERY_MS
    let row: MeetingRow | null = null
    switch (e.event) {
      case 'start':
        job.durationSec = e.durationSec
        // The decode is done: the player's copy plays from here on.
        row = this.store.patch(itemId, { durationSec: e.durationSec, mediaKind: e.media, progress: { phase: 'speakers', done: 0, total: 1 }, ...(job.audio && existsSync(job.audio.path) ? { audio: job.audio.name } : {}) })
        break
      case 'peaks':
        this.store.patch(itemId, { peaks: e.peaks })
        return
      case 'speakers':
        if (!due) return
        row = this.store.patch(itemId, { progress: { phase: 'speakers', done: e.done, total: Math.max(1, e.total) } })
        break
      case 'turns':
        job.merger = new Merger(foldStrays(e.turns, e.voices).turns)
        row = this.store.patch(itemId, { progress: { phase: 'words', done: 0, total: job.durationSec } })
        break
      case 'words': {
        job.merger ??= new Merger([])
        job.merger.add(e.words)
        if (!due) return
        const segments = job.merger.segments()
        row = this.store.patch(itemId, { progress: { phase: 'words', done: Math.min(e.uptoSec, job.durationSec || e.uptoSec), total: job.durationSec }, doc: { ...this.need(itemId).doc, speakers: speakersOf(segments), segments } })
        break
      }
    }
    job.told = now
    this.tell(ctx, row)
  }

  /** The transcriber's whole answer becomes the meeting. */
  private finish(ctx: WorkCtx, itemId: string, raw: RawTranscript, audio: { name: string; path: string } | null): void {
    const folded = foldStrays(raw.turns, raw.voices)
    const { segments } = segmentsOf(raw.words, folded.turns)
    const speakers = speakersOf(segments)
    const row = this.store.patch(itemId, {
      status: 'ready',
      progress: null,
      error: null,
      durationSec: raw.durationSec,
      mediaKind: raw.media,
      peaks: raw.peaks,
      engine: raw.engine,
      audio: audio && existsSync(audio.path) ? audio.name : null,
      doc: { speakers, segments, notes: this.store.get(itemId)?.doc.notes ?? null },
      transcribedAt: Date.now()
    })
    this.voices.setMeeting(itemId, voicesById(folded.turns, folded.voices, new Set(speakers.map((s) => s.id))))
    this.tell(ctx, row)
  }

  /** Stops a transcription and waits until it has gone. */
  async cancel(ctx: WorkCtx, itemId: string, why = 'It was stopped before it finished. The recording is fine.'): Promise<Meeting | null> {
    const job = this.jobs.get(itemId)
    if (job) {
      job.why = why
      job.abort.abort()
      await job.done
    }
    return this.get(ctx, itemId)
  }

  /** Every transcription stops (Work turned off, the host closing). Nothing is awaited: the abort kills the children. */
  stopAll(why: string): void {
    for (const job of this.jobs.values()) {
      job.why = why
      job.abort.abort()
    }
  }

  /** Meetings a process that is gone left mid-transcription: each says so, with Try again. */
  recover(ctx: WorkCtx): void {
    for (const row of this.store.transcribing()) {
      if (!this.jobs.has(row.itemId)) this.failed(ctx, row.itemId, `It stopped when ${ctx.host} restarted. The recording is fine.`)
    }
  }

  /** Resolves when the meeting is no longer transcribing, the signal aborts, or the time is up. */
  async settled(itemId: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
    const job = this.jobs.get(itemId)
    if (!job) return
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      signal.addEventListener('abort', done, { once: true })
      void job.done.then(done)
      if (signal.aborted) done()
    })
  }

  /** Names a speaker, or takes the name back; a name keeps their voice on this host. */
  nameSpeaker(ctx: WorkCtx, itemId: string, speakerId: string, name: string | null): Meeting {
    const row = this.need(itemId)
    // Until it is ready the speakers are still being found, and their ids may change.
    if (row.status !== 'ready') throw new Error('A speaker can be named once the meeting is transcribed.')
    const speaker = row.doc.speakers.find((s) => s.id === speakerId)
    if (!speaker) throw new Error(`no speaker ${speakerId} in this meeting`)
    const doc: MeetingDoc = { ...row.doc, speakers: row.doc.speakers.map((s) => (s.id === speakerId ? { ...s, name } : s)) }
    const next = this.store.patch(itemId, { doc })!
    if (name) this.voices.remember(name, itemId, speakerId)
    this.tell(ctx, next)
    return this.wire(ctx, next)
  }

  /** A writer's notes, checked against the transcript and kept; what did not pass is named. */
  async writeNotes(ctx: WorkCtx, itemId: string, input: NotesInput): Promise<{ meeting: Meeting; dropped: string[] }> {
    const first = this.need(itemId)
    if (first.status !== 'ready') throw new Error(first.status === 'transcribing' ? 'The meeting is still being transcribed.' : 'The meeting has no transcript.')
    // A task the writer says LifeOS already holds is shown as filed only if LifeOS says so; otherwise it waits for the owner like any other.
    const unconfirmed: string[] = []
    const actions = await Promise.all(
      (input.actions ?? []).map(async (a) => {
        if (!a.lifeosTaskId || (await taskExists(ctx, a.lifeosTaskId))) return a
        unconfirmed.push(`The task "${a.text.length > 60 ? `${a.text.slice(0, 57)}…` : a.text}": LifeOS could not confirm task ${a.lifeosTaskId}, so it waits for the owner.`)
        const { lifeosTaskId: _, ...rest } = a
        return rest
      })
    )
    const row = this.need(itemId)
    if (row.status !== 'ready') throw new Error('The meeting is being transcribed again.')
    const checked = checkNotes({ ...input, ...(input.actions ? { actions } : {}) }, row.doc.segments, row.doc.notes)
    checked.dropped.push(...unconfirmed)
    const next = this.store.patch(itemId, { doc: { ...row.doc, notes: checked.notes, before: { notes: row.doc.notes } } })!
    this.tell(ctx, next)
    return { meeting: this.wire(ctx, next), dropped: checked.dropped }
  }

  undoNotes(ctx: WorkCtx, itemId: string): Meeting {
    const row = this.need(itemId)
    if (!row.doc.before) throw new Error('There is nothing to undo.')
    const { before, ...doc } = row.doc
    const next = this.store.patch(itemId, { doc: { ...doc, notes: undoneNotes(row.doc.notes, before.notes) } })!
    this.tell(ctx, next)
    return this.wire(ctx, next)
  }

  /**
   * The owner's word on tasks: accept files each in LifeOS and marks it
   * filed, reject drops it. One that cannot be filed stays waiting and is
   * named with why.
   */
  async decide(ctx: WorkCtx, itemId: string, actionIds: readonly string[], decision: 'accept' | 'reject'): Promise<{ meeting: Meeting; failed: { id: string; error: string }[] }> {
    const failed: { id: string; error: string }[] = []
    for (const id of actionIds) {
      const row = this.need(itemId)
      const action = row.doc.notes?.actions.find((a) => a.id === id)
      if (!action || action.state !== 'proposed') continue
      const key = `${itemId}:${tokensOf(action.text).join(' ')}`
      if (this.filing.has(key)) continue
      let patch: { state: 'filed'; lifeosTaskId: string } | { state: 'rejected' }
      if (decision === 'reject') patch = { state: 'rejected' }
      else {
        this.filing.add(key)
        try {
          patch = { state: 'filed', lifeosTaskId: await fileTask(ctx, row.sessionId, action, row) }
        } catch (err) {
          failed.push({ id, error: errorText(err) })
          continue
        } finally {
          this.filing.delete(key)
        }
      }
      // Read again: the filing awaited, and the notes may have been written meanwhile. The task is found by its words then.
      const now = this.need(itemId)
      if (!now.doc.notes) {
        // The notes went (an Undo) while it was filed: the task LifeOS now holds stays on the record.
        if (patch.state === 'filed') this.tell(ctx, this.store.patch(itemId, { doc: { ...now.doc, notes: { summary: [], decisions: [], questions: [], actions: [{ ...action, ...patch, id: 'a1' }], writtenAt: Date.now() } } }))
        continue
      }
      const at = now.doc.notes.actions.findIndex((a) => a.id === id && a.text === action.text)
      const index = at >= 0 ? at : now.doc.notes.actions.findIndex((a) => a.text === action.text)
      const actions = index >= 0 ? now.doc.notes.actions.map((a, i) => (i === index ? { ...a, ...patch } : a)) : [...now.doc.notes.actions, { ...action, ...patch, id: `a${now.doc.notes.actions.length + 1}` }]
      this.tell(ctx, this.store.patch(itemId, { doc: { ...now.doc, notes: { ...now.doc.notes, actions } } }))
    }
    return { meeting: this.wire(ctx, this.need(itemId)), failed }
  }

  listVoices(): MeetingVoice[] {
    return this.voices.list()
  }

  forgetVoice(name: string): MeetingVoice[] {
    this.voices.forget(name)
    return this.voices.list()
  }

  /** Deleted threads: their transcriptions stop, their meetings and those meetings' voices go. */
  removeSessions(ids: readonly string[]): void {
    const rows = this.store.forSessions(ids)
    for (const row of rows) {
      const job = this.jobs.get(row.itemId)
      if (job) {
        job.why = 'The thread was deleted.'
        job.abort.abort()
      }
    }
    this.voices.removeMeetings(rows.map((r) => r.itemId))
    this.store.removeSessions(ids)
  }
}

/** Each speaker's voice by the meeting's ids, for the speakers that have turns in the transcript. */
function voicesById(turns: Parameters<typeof speakerIds>[0], voices: RawVoices, kept: ReadonlySet<string>): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const [n, id] of speakerIds(turns)) {
    const voice = voices[String(n)]
    if (voice && kept.has(id)) out.set(id, voice)
  }
  return out
}

/** What a new transcript keeps of the old notes: the tasks LifeOS holds, never lost. */
function filedOnly(notes: StoredNotes | null): StoredNotes | null {
  const actions = (notes?.actions ?? []).filter((a) => a.state === 'filed').map((a, i) => ({ ...a, id: `a${i + 1}`, refs: [], at: null }))
  return actions.length ? { summary: [], decisions: [], questions: [], actions, writtenAt: notes!.writtenAt } : null
}

/** A failure as a sentence a person reads under "Could not transcribe". */
function sentenceOf(err: unknown, host: string): string {
  const text = errorText(err)
  if ((err as { code?: string })?.code === 'no-converter') return `The transcriber is not installed on ${host}.`
  if (text === 'cancelled') return 'It was stopped before it finished. The recording is fine.'
  if (text === 'Work is off on this host' || text === 'Work turned off') return `It stopped when Work was turned off on ${host}. The recording is fine.`
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/** One `Meetings` per database, made on first use: the module's methods and the tools share its running jobs. */
const services = new WeakMap<DatabaseSync, Meetings>()
export function meetingsOf(ctx: Pick<WorkCtx, 'db' | 'canvas'>): Meetings {
  let service = services.get(ctx.db)
  if (!service) services.set(ctx.db, (service = new Meetings(ctx.db, ctx.canvas)))
  return service
}
