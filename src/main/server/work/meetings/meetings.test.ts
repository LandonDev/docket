import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL, METHOD_CAPABILITY } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { Meeting } from '@shared/contract-work-meetings'
import type { SessionMeta } from '@shared/events'
import type { CanvasSource, SectorKey, WorkScope } from '@shared/work'
import { setAttachmentDirContext } from '../../attachmentDir'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import type { ConvertJob, ConvertResult } from '../formats/jobs'
import { emitPipelineEvent } from './events'
import type { PipelineEvent, RawTranscript } from './raw'

// Milestone 6 builds the scope, milestone 7 LifeOS, milestone 15's runner the jobs: here each is the test's.
let sector: SectorKey | null = 'purdue'
vi.mock('../scope', () => ({
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector, host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
const filed: { fn: string; args: Record<string, unknown> }[] = []
let lifeosUp = true
let mutationGate: Promise<void> | null = null
/** the tasks LifeOS holds, by id */
const known = new Set<string>()
vi.mock('../lifeos/ctx', () => ({
  lifeosPart: () => ({
    lifeos: {
      connected: () => lifeosUp,
      owner: () => ({
        query: async (_fn: string, args: { id: string }) => (known.has(args.id) ? { _id: args.id } : null),
        action: async () => null,
        mutation: async (fn: string, args: Record<string, unknown>) => {
          if (mutationGate) await mutationGate
          filed.push({ fn, args })
          return `task${filed.length}`
        }
      }),
      jwt: async () => 'jwt',
      subscribe: () => () => {}
    },
    links: { link: async () => {}, forThread: async () => [], completeFor: async () => {} }
  })
}))

/** What the fake transcriber does with the next job. */
interface Plan {
  raw: RawTranscript
  /** stop after the first words until this settles (or the job aborts) */
  hold?: Promise<void>
  /** throw this once the playback copy is written */
  fail?: string
}
let plan: Plan
const jobs: ConvertJob[] = []
const step = (): void => void vi.setSystemTime(Date.now() + 2500)
async function fakeConvert(job: ConvertJob): Promise<ConvertResult> {
  jobs.push(job)
  const token = job.options?.progress
  const say = (e: PipelineEvent): void => {
    step()
    emitPipelineEvent(token, e)
  }
  const { raw } = plan
  // As the pipeline does: the player's copy is whole once the decode is, before the first event.
  if (typeof job.options?.audioOut === 'string') writeFileSync(job.options.audioOut, 'm4a bytes')
  say({ event: 'start', durationSec: raw.durationSec, media: raw.media })
  say({ event: 'peaks', peaks: raw.peaks })
  say({ event: 'speakers', done: 1, total: 2 })
  say({ event: 'turns', turns: raw.turns, voices: raw.voices })
  const half = Math.ceil(raw.words.length / 2)
  say({ event: 'words', uptoSec: raw.words[half - 1].e, words: raw.words.slice(0, half) })
  if (plan.hold) {
    await Promise.race([plan.hold, new Promise((r) => job.signal?.addEventListener('abort', r, { once: true }))])
  }
  if (job.signal?.aborted) throw new Error('cancelled')
  if (plan.fail) throw new Error(plan.fail)
  say({ event: 'words', uptoSec: raw.durationSec, words: raw.words.slice(half) })
  const output = join(dir, `out-${jobs.length}.tcmeeting`)
  writeFileSync(output, JSON.stringify(raw))
  return { output, ranOn: 'env_test', warnings: [] }
}
vi.mock('../formats/jobs', async (load) => ({ ...(await load<object>()), convertPart: () => ({ convert: (job: ConvertJob) => fakeConvert(job) }) }))

const { startWork } = await import('../ctx')
const { canvas } = await import('../canvas/index')
const { meetings } = await import('./index')
const { meetingsOf } = await import('./service')
const { VOICE_MATCH } = await import('./voices')

/** Two speakers, twelve seconds each in turn, one word a second; voices along two axes. */
function rawOf(voiceA: number[] = [1, 0, 0], voiceB: number[] = [0, 1, 0]): RawTranscript {
  const said = [
    'On nationals I need the final number by Friday or it misses this quarter',
    'I will send it Friday flights and hotel are in',
    'Then keep contingency at eight percent and we are fine with that plan'
  ]
  const words = said.flatMap((line, t) => line.split(' ').map((w, i) => ({ w, s: t * 14 + i, e: t * 14 + i + 0.8 })))
  return {
    durationSec: 42,
    media: 'audio',
    peaks: Array.from({ length: 400 }, (_, i) => (i % 10) / 10),
    turns: [
      { speaker: 0, start: 0, end: 13.5 },
      { speaker: 1, start: 14, end: 27.5 },
      { speaker: 0, start: 28, end: 42 }
    ],
    voices: { '0': voiceA, '1': voiceB },
    words,
    engine: 'fake',
    timings: { decodeSec: 0, speakersSec: 0, wordsSec: 0, threads: 2 }
  }
}

let dir: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
const pushes: WorkPush[] = []
const sessions = new Map<string, SessionMeta>()
const thread = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => {
  const meta = { id, provider: 'claude', workspaceId: 'w1', scope: 'work', ...over } as SessionMeta
  sessions.set(id, meta)
  return meta
}
const removed: ((ids: string[]) => void)[] = []
const registry = {
  get: (id: string) => sessions.get(id) ?? null,
  onRemoved: (fn: (ids: string[]) => void) => (removed.push(fn), () => {}),
  onWorkspaceDeleted: () => () => {}
} as unknown as SessionRegistry
const boot = (): void => {
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {} }, [canvas, meetings])
  work.pushes.onPush((p) => pushes.push(p))
}
const call = async <T,>(method: string, params?: unknown): Promise<T> => {
  const out = await work.handle(ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest), LOCAL_PRINCIPAL)
  return (out.handled ? out.result : undefined) as T
}
const file = (path: string): CanvasSource => ({ at: 'file', host: 'env_test', path })
const service = () => meetingsOf(db)
const drop = (name: string, body: string | Uint8Array = 'audio'): string => {
  const path = join(dir, 'files', name)
  writeFileSync(path, body)
  return path
}
const openMeeting = (path: string, title = 'Staff sync', session = 't1') => work.ctx.canvas.open(session, 'meeting', file(path), title)
const get = (itemId: string) => call<{ meeting: Meeting | null }>('work.meetings.get', { itemId }).then((r) => r.meeting!)
const idle = async (itemId: string) => service().settled(itemId, new AbortController().signal, 5_000)
async function readyMeeting(raw = rawOf(), title = 'Staff sync', session = 't1'): Promise<Meeting> {
  plan = { raw }
  const item = openMeeting(drop(`${title}.m4a`), title, session)
  await call('work.meetings.start', { itemId: item.id })
  await idle(item.id)
  return get(item.id)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  dir = mkdtempSync(join(tmpdir(), 'tc-meetings-'))
  mkdirSync(join(dir, 'files'))
  db = openDb(join(dir, 'test.db'))
  setAttachmentDirContext({ session: (id) => sessions.get(id) ?? null, projectCwd: () => null, workspacePath: () => null, dataDir: dir })
  pushes.length = 0
  sessions.clear()
  removed.length = 0
  filed.length = 0
  jobs.length = 0
  sector = 'purdue'
  lifeosUp = true
  mutationGate = null
  known.clear()
  known.add('k77')
  plan = { raw: rawOf() }
  thread('t1')
  boot()
  await call('work.set', { enabled: true })
  pushes.length = 0
})
afterEach(() => {
  work.close()
  db.close()
  setAttachmentDirContext(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('a meeting from a recording', () => {
  it('goes from transcribing, with the turns heard so far, to ready; the recording is never carried to another host', async () => {
    let release!: () => void
    plan = { raw: rawOf(), hold: new Promise<void>((r) => (release = r)) }
    const item = openMeeting(drop('Staff sync.m4a'))
    const started = await call<{ meeting: Meeting }>('work.meetings.start', { itemId: item.id })
    expect(started.meeting).toMatchObject({ itemId: item.id, sessionId: 't1', status: 'transcribing', from: 'recording' })
    expect(jobs[0]).toMatchObject({ from: 'm4a', to: 'tcmeeting', here: true, input: join(dir, 'files', 'Staff sync.m4a') })

    const mid = await get(item.id)
    expect(mid.status).toBe('transcribing')
    expect(mid.progress).toMatchObject({ phase: 'words', total: 42 })
    expect(mid.peaks).toHaveLength(400)
    // The player plays while the words are still coming.
    expect(mid.media?.audio?.path).toMatch(/\.meeting\.m4a$/)
    expect(mid.segments.length).toBeGreaterThan(0)
    expect(mid.segments[0]).toMatchObject({ id: 's1', speaker: 'S1', start: 0 })
    // A second start while it runs changes nothing.
    expect((await call<{ meeting: Meeting }>('work.meetings.start', { itemId: item.id })).meeting.status).toBe('transcribing')
    expect(jobs).toHaveLength(1)

    release()
    await idle(item.id)
    const m = await get(item.id)
    expect(m).toMatchObject({ status: 'ready', durationSec: 42, from: 'recording', speakers: [{ id: 'S1', label: 'Speaker 1', name: null }, { id: 'S2', label: 'Speaker 2', name: null }] })
    expect(m.segments.map((s) => s.speaker)).toEqual(['S1', 'S2', 'S1'])
    expect(m.segments[1].text).toMatch(/^I will send it Friday/)
    expect(m.media?.audio?.path).toBe(join(dir, 'attachments', 't1', `Staff-sync.${item.id.slice(0, 8)}.meeting.m4a`))
    expect(existsSync(m.media!.audio!.path)).toBe(true)
    // The push says what changed and carries no transcript.
    const last = pushes.filter((p) => p.push === 'work.meetings').at(-1)
    expect(last).toEqual({ push: 'work.meetings', itemId: item.id, sessionId: 't1', rev: m.rev, status: 'ready' })
  })

  it('a failure says why and keeps the player when the copy was made; Try again starts it again', async () => {
    plan = { raw: rawOf(), fail: 'The host ran out of memory while transcribing.' }
    const item = openMeeting(drop('Staff sync.m4a'))
    await call('work.meetings.start', { itemId: item.id })
    await idle(item.id)
    const m = await get(item.id)
    expect(m).toMatchObject({ status: 'failed', error: 'The host ran out of memory while transcribing.' })
    expect(m.media?.audio).toBeDefined()
    plan = { raw: rawOf() }
    await call('work.meetings.start', { itemId: item.id })
    await idle(item.id)
    expect((await get(item.id)).status).toBe('ready')
  })

  it('cancel stops it and says the recording is fine', async () => {
    plan = { raw: rawOf(), hold: new Promise(() => {}) }
    const item = openMeeting(drop('Staff sync.m4a'))
    await call('work.meetings.start', { itemId: item.id })
    const out = await call<{ meeting: Meeting }>('work.meetings.cancel', { itemId: item.id })
    expect(out.meeting).toMatchObject({ status: 'failed', error: 'It was stopped before it finished. The recording is fine.' })
  })

  it('a meeting a gone process left mid-transcription says so at the next start of Work', async () => {
    plan = { raw: rawOf(), hold: new Promise(() => {}) }
    const item = openMeeting(drop('Staff sync.m4a'))
    await call('work.meetings.start', { itemId: item.id })
    // The process goes: its jobs with it, the row still says transcribing.
    work.close()
    await idle(item.id)
    db.prepare(`UPDATE work_meetings SET status = 'transcribing' WHERE item_id = ?`).run(item.id)
    boot()
    await call('work.set', { enabled: true })
    expect(await get(item.id)).toMatchObject({ status: 'failed', error: 'It stopped when env_test restarted. The recording is fine.' })
  })

  it('a file that is gone, or is neither a recording nor a transcript, fails with a sentence', async () => {
    const gone = openMeeting(join(dir, 'files', 'nope.m4a'))
    expect((await call<{ meeting: Meeting }>('work.meetings.start', { itemId: gone.id })).meeting).toMatchObject({ status: 'failed', error: 'nope.m4a is not on env_test any more.' })
    const odd = openMeeting(drop('notes.pdf'))
    expect((await call<{ meeting: Meeting }>('work.meetings.start', { itemId: odd.id })).meeting.error).toMatch(/^notes.pdf is not a recording or a transcript/)
  })

  it('a thread deleted mid-transcription stops it and takes its meetings', async () => {
    plan = { raw: rawOf(), hold: new Promise(() => {}) }
    const item = openMeeting(drop('Staff sync.m4a'))
    await call('work.meetings.start', { itemId: item.id })
    for (const fn of removed) fn(['t1'])
    await idle(item.id)
    expect(await get(item.id).catch(() => null)).toBeNull()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM work_meetings_speaker_voices`).get()).toEqual({ n: 0 })
  })
})

describe('a meeting from a transcript file', () => {
  it('is ready at once, its speakers named by the file', async () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Dana Lee>On nationals, I need the number by Friday.</v>\n\n00:00:05.000 --> 00:00:08.000\n<v Landon Hale>I will send it Friday.</v>\n'
    const item = openMeeting(drop('Staff sync.vtt', vtt))
    const { meeting } = await call<{ meeting: Meeting }>('work.meetings.start', { itemId: item.id })
    expect(meeting).toMatchObject({ status: 'ready', from: 'transcript', speakers: [{ id: 'S1', name: 'Dana Lee' }, { id: 'S2', name: 'Landon Hale' }] })
    expect(meeting.segments.map((s) => s.text)).toEqual(['On nationals, I need the number by Friday.', 'I will send it Friday.'])
    expect(meeting.media).toBeUndefined()
    expect(jobs).toHaveLength(0)
  })
})

describe('speakers and voices', () => {
  it('a name given in one meeting is offered, never applied, to the nearest voice in the next; forgetting the voice ends the offer', async () => {
    const first = await readyMeeting(rawOf([1, 0, 0], [0, 1, 0]))
    await call('work.meetings.speaker', { itemId: first.itemId, speakerId: 'S1', name: 'Dana Lee' })
    expect((await get(first.itemId)).speakers[0]).toEqual({ id: 'S1', label: 'Speaker 1', name: 'Dana Lee' })
    // The next meeting: speaker 2's voice is near Dana's, speaker 1's is not.
    const second = await readyMeeting(rawOf([0, 0, 1], [0.9, 0.1, 0]), 'Budget review')
    expect(second.speakers).toEqual([
      { id: 'S1', label: 'Speaker 1', name: null },
      { id: 'S2', label: 'Speaker 2', name: null, suggested: 'Dana Lee' }
    ])
    expect(await call('work.meetings.voices')).toEqual({ voices: [{ name: 'Dana Lee', meetings: 1, updatedAt: expect.any(Number) }] })
    // No method answers an embedding.
    expect(JSON.stringify(second)).not.toMatch(/embedding|voice|\[0\.9,0\.1,0\]/)
    await call('work.meetings.forgetVoice', { name: 'Dana Lee' })
    expect((await get(second.itemId)).speakers[1]).toEqual({ id: 'S2', label: 'Speaker 2', name: null })
    // The name on the first meeting is his word, and stays.
    expect((await get(first.itemId)).speakers[0].name).toBe('Dana Lee')
    expect(VOICE_MATCH).toBe(0.6)
  })

  it('a name can be taken back; an unknown speaker is refused', async () => {
    const m = await readyMeeting()
    await call('work.meetings.speaker', { itemId: m.itemId, speakerId: 'S2', name: 'Sam Ortiz' })
    await call('work.meetings.speaker', { itemId: m.itemId, speakerId: 'S2', name: null })
    expect((await get(m.itemId)).speakers[1].name).toBeNull()
    await expect(call('work.meetings.speaker', { itemId: m.itemId, speakerId: 'S9', name: 'X' })).rejects.toThrow('no speaker S9 in this meeting')
  })
})

describe('notes and tasks', () => {
  const notes = (m: Meeting) => ({
    meeting: m.itemId,
    summary: [{ text: 'Dana needs the nationals number by Friday.', refs: ['s1'] }],
    decisions: [{ text: 'Contingency stays at eight percent.', quote: 'keep contingency at eight percent' }],
    questions: [{ text: 'Is the fee per player?', refs: ['s99'] }],
    actions: [
      { text: 'Send Dana the nationals budget', quote: 'I will send it Friday', due: '2026-11-20' },
      { text: 'Order badge printer ribbon', refs: ['s3'], lifeosTaskId: 'k77' }
    ]
  })

  it('the tool keeps what rests on the record, names what does not, and every kept quote is found in the transcript', async () => {
    const m = await readyMeeting()
    const out = await work.tools.call(sessions.get('t1')!, 'meeting_notes', notes(m), new AbortController().signal)
    expect(out.isError).toBeUndefined()
    expect(out.structuredContent).toMatchObject({ kept: { summary: 1, decisions: 1, questions: 0, actions: 2 } })
    expect((out.structuredContent as { dropped: string[] }).dropped.join('\n')).toMatch(/there is no segment s99/)
    const n = (await get(m.itemId)).notes!
    const text = (await get(m.itemId)).segments.map((s) => s.text).join(' ').toLowerCase()
    for (const line of [...n.summary, ...n.decisions, ...n.questions, ...n.actions]) if (line.quote) expect(text).toContain(line.quote.toLowerCase())
    expect(n.decisions[0]).toMatchObject({ refs: ['s3'], at: 28 + 1 })
    expect(n.actions.map((a) => [a.text, a.state, a.lifeosTaskId])).toEqual([
      ['Send Dana the nationals budget', 'proposed', undefined],
      ['Order badge printer ribbon', 'filed', 'k77']
    ])
    expect(n.canUndo).toBe(true)
    // Undo puts the notes back as they were, none, but a task LifeOS holds is never lost.
    await call('work.meetings.undoNotes', { itemId: m.itemId })
    const undone = (await get(m.itemId)).notes!
    expect([undone.summary, undone.decisions, undone.questions]).toEqual([[], [], []])
    expect(undone.actions.map((a) => a.lifeosTaskId)).toEqual(['k77'])
    expect(undone.canUndo).toBe(false)
  })

  it('accept files a task once, in LifeOS, in the workspace\'s sector; reject files nothing', async () => {
    const m = await readyMeeting()
    await work.tools.call(sessions.get('t1')!, 'meeting_notes', notes(m), new AbortController().signal)
    const [send] = (await get(m.itemId)).notes!.actions
    // Two accepts at once file one task.
    let open!: () => void
    mutationGate = new Promise((r) => (open = r))
    const a = call('work.meetings.decide', { itemId: m.itemId, actionIds: [send.id], decision: 'accept' })
    const b = call('work.meetings.decide', { itemId: m.itemId, actionIds: [send.id], decision: 'accept' })
    open()
    await Promise.all([a, b])
    expect(filed).toHaveLength(1)
    expect(filed[0].fn).toBe('tasks:create')
    expect(filed[0].args).toMatchObject({ sector: 'purdue', title: 'Send Dana the nationals budget', description: expect.stringMatching(/^From “Staff sync” at 0:14\.\n“I will send it Friday”$/) })
    expect(filed[0].args.dueAt).toBe(new Date(2026, 10, 20, 9).getTime())
    const after = (await get(m.itemId)).notes!.actions[0]
    expect(after).toMatchObject({ state: 'filed', lifeosTaskId: 'task1' })
    // A rewrite of the notes keeps his word.
    await work.tools.call(sessions.get('t1')!, 'meeting_notes', notes(m), new AbortController().signal)
    expect((await get(m.itemId)).notes!.actions[0]).toMatchObject({ state: 'filed', lifeosTaskId: 'task1' })
    expect(filed).toHaveLength(1)
  })

  it('reject drops a task and files nothing; a thread with no sector, or LifeOS down, leaves it waiting with why', async () => {
    const m = await readyMeeting()
    await work.tools.call(sessions.get('t1')!, 'meeting_notes', notes(m), new AbortController().signal)
    const [send] = (await get(m.itemId)).notes!.actions
    sector = null
    const noSector = await call<{ failed: { id: string; error: string }[] }>('work.meetings.decide', { itemId: m.itemId, actionIds: [send.id], decision: 'accept' })
    expect(noSector.failed[0].error).toMatch(/not linked to a LifeOS sector/)
    sector = 'purdue'
    lifeosUp = false
    const down = await call<{ failed: { id: string; error: string }[] }>('work.meetings.decide', { itemId: m.itemId, actionIds: [send.id], decision: 'accept' })
    expect(down.failed[0].error).toBe('LifeOS is not connected on this host.')
    expect((await get(m.itemId)).notes!.actions[0].state).toBe('proposed')
    await call('work.meetings.decide', { itemId: m.itemId, actionIds: [send.id], decision: 'reject' })
    expect((await get(m.itemId)).notes!.actions[0].state).toBe('rejected')
    expect(filed).toHaveLength(0)
  })

  it('notes are refused while the meeting is transcribing', async () => {
    plan = { raw: rawOf(), hold: new Promise(() => {}) }
    const item = openMeeting(drop('Staff sync.m4a'))
    await call('work.meetings.start', { itemId: item.id })
    const out = await work.tools.call(sessions.get('t1')!, 'meeting_notes', { meeting: item.id, summary: [{ text: 'x', refs: ['s1'] }] }, new AbortController().signal)
    expect(out).toMatchObject({ isError: true, content: [{ text: 'The meeting is still being transcribed.' }] })
    await call('work.meetings.cancel', { itemId: item.id })
  })

  it('holds each method to its capability: deciding a task is the owner\'s press', () => {
    const caps = ['get', 'start', 'cancel', 'speaker', 'decide', 'undoNotes', 'voices', 'forgetVoice'].map((v) => METHOD_CAPABILITY[`work.meetings.${v}` as keyof typeof METHOD_CAPABILITY])
    expect(caps).toEqual(['read', 'operate', 'operate', 'operate', 'approve', 'operate', 'read', 'operate'])
  })
})

describe('the tools', () => {
  it('meeting_open opens a file beside the root thread and waits for it; meeting_read and meeting_find answer citable lines', async () => {
    const child = thread('t1-child', { parentId: 't1' })
    const path = drop('Staff sync.m4a')
    const opened = await work.tools.call(child, 'meeting_open', { file: path }, new AbortController().signal)
    expect(opened.isError).toBeUndefined()
    const itemId = (opened.structuredContent as { item: string }).item
    expect(work.ctx.canvas.forSession('t1').map((i) => [i.id, i.kind, i.title])).toEqual([[itemId, 'meeting', 'Staff sync']])
    expect(opened.content[0]).toMatchObject({ text: expect.stringMatching(/^Opened Staff sync as meeting .+\nTranscribed on this host: 0:42, 3 turns, speakers: Speaker 1, Speaker 2\.$/) })
    const read = await work.tools.call(child, 'meeting_read', { meeting: itemId }, new AbortController().signal)
    expect(read.content[0]).toMatchObject({ text: expect.stringContaining('s2 [0:14] Speaker 2: I will send it Friday') })
    const found = await work.tools.call(child, 'meeting_find', { meeting: itemId, query: 'contingency' }, new AbortController().signal)
    expect(found.content[0]).toMatchObject({ text: expect.stringMatching(/^1 turn holds "contingency":\ns3 \[0:28\] Speaker 1: Then keep contingency/) })
    // Another tree's thread has no such meeting.
    expect(await work.tools.call(thread('t2'), 'meeting_read', { meeting: itemId }, new AbortController().signal)).toMatchObject({ isError: true })
    expect(await work.tools.call(child, 'meeting_open', { file: join(dir, 'files', 'nope.wav') }, new AbortController().signal)).toMatchObject({ isError: true })
  })

  it('every Work thread hears that a recording never leaves the host and that meeting tasks wait for the owner', () => {
    expect(meetings.preamble?.({} as never)).toMatch(/never goes to any other tool, service or host.*never filed by you/s)
  })
})

describe('after the review', () => {
  const signal = () => new AbortController().signal

  it("a task the writer says LifeOS holds is shown as filed only when LifeOS has it; otherwise it waits for the owner", async () => {
    const m = await readyMeeting()
    const out = await work.tools.call(sessions.get('t1')!, 'meeting_notes', { meeting: m.itemId, actions: [{ text: 'Order badge printer ribbon', refs: ['s3'], lifeosTaskId: 'k77' }, { text: 'Made-up task', refs: ['s1'], lifeosTaskId: 'nope' }] }, signal())
    expect((out.structuredContent as { dropped: string[] }).dropped.join('\n')).toMatch(/LifeOS could not confirm task nope, so it waits for the owner/)
    expect((await get(m.itemId)).notes!.actions.map((a) => [a.text, a.state, a.lifeosTaskId])).toEqual([
      ['Order badge printer ribbon', 'filed', 'k77'],
      ['Made-up task', 'proposed', undefined]
    ])
    // With LifeOS down nothing is confirmed.
    lifeosUp = false
    await work.tools.call(sessions.get('t1')!, 'meeting_notes', { meeting: m.itemId, actions: [{ text: 'Another', refs: ['s2'], lifeosTaskId: 'k77' }] }, signal())
    expect((await get(m.itemId)).notes!.actions.find((a) => a.text === 'Another')!.state).toBe('proposed')
  })

  it('a speaker is named only once the meeting is transcribed', async () => {
    plan = { raw: rawOf(), hold: new Promise(() => {}) }
    const item = openMeeting(drop('Staff sync.m4a'))
    await call('work.meetings.start', { itemId: item.id })
    await expect(call('work.meetings.speaker', { itemId: item.id, speakerId: 'S1', name: 'Dana' })).rejects.toThrow('A speaker can be named once the meeting is transcribed.')
    await call('work.meetings.cancel', { itemId: item.id })
  })

  it('starts that come at once run one after another, and cancel reaches the last: no job is left running', async () => {
    plan = { raw: rawOf(), hold: new Promise(() => {}) }
    const item = openMeeting(drop('Staff sync.m4a'))
    const other = drop('Other.m4a')
    await Promise.all([
      call('work.meetings.start', { itemId: item.id, source: file(other) }),
      call('work.meetings.start', { itemId: item.id, source: file(other) }),
      call('work.meetings.start', { itemId: item.id, source: file(other) })
    ])
    expect(jobs.filter((j) => !j.signal!.aborted)).toHaveLength(1)
    await call('work.meetings.cancel', { itemId: item.id })
    expect(jobs.every((j) => j.signal!.aborted)).toBe(true)
  })

  it('an accept after a rewrite that renumbered the task files it once', async () => {
    const m = await readyMeeting()
    const notes = { meeting: m.itemId, actions: [{ text: 'Send Dana the nationals budget', quote: 'I will send it Friday' }] }
    await work.tools.call(sessions.get('t1')!, 'meeting_notes', notes, signal())
    let open!: () => void
    mutationGate = new Promise((r) => (open = r))
    const first = call('work.meetings.decide', { itemId: m.itemId, actionIds: ['a1'], decision: 'accept' })
    // The writer puts a task before it: the same words are a2 now.
    await work.tools.call(sessions.get('t1')!, 'meeting_notes', { meeting: m.itemId, actions: [{ text: 'Book the ballroom', refs: ['s1'] }, ...notes.actions] }, signal())
    const second = call('work.meetings.decide', { itemId: m.itemId, actionIds: ['a2'], decision: 'accept' })
    open()
    await Promise.all([first, second])
    expect(filed).toHaveLength(1)
    expect((await get(m.itemId)).notes!.actions.find((a) => a.text === 'Send Dana the nationals budget')).toMatchObject({ state: 'filed', lifeosTaskId: 'task1' })
  })

  it('a task filed while an Undo took the notes away stays on the record, and a new transcription keeps every filed task', async () => {
    const m = await readyMeeting()
    await work.tools.call(sessions.get('t1')!, 'meeting_notes', { meeting: m.itemId, actions: [{ text: 'Send Dana the nationals budget', quote: 'I will send it Friday' }] }, signal())
    let open!: () => void
    mutationGate = new Promise((r) => (open = r))
    const accept = call('work.meetings.decide', { itemId: m.itemId, actionIds: ['a1'], decision: 'accept' })
    await call('work.meetings.undoNotes', { itemId: m.itemId })
    open()
    await accept
    expect((await get(m.itemId)).notes!.actions).toEqual([expect.objectContaining({ text: 'Send Dana the nationals budget', state: 'filed', lifeosTaskId: 'task1' })])
    // Transcribed again from another file: the filed task is still there.
    plan = { raw: rawOf() }
    await call('work.meetings.start', { itemId: m.itemId, source: file(drop('Again.m4a')) })
    await idle(m.itemId)
    const again = await get(m.itemId)
    expect(again.status).toBe('ready')
    expect(again.notes!.actions).toEqual([expect.objectContaining({ state: 'filed', lifeosTaskId: 'task1', refs: [], at: null })])
  })
})
