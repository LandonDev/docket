import { basename } from 'node:path'
import { handled, NOT_HANDLED } from '@shared/work'
import type { MeetingRecordingRange } from '@shared/contract-work-meetings'
import { readRange } from '../../attachmentUploads'
import { FenceError } from '../../remote/fence'
import { registerMoveModule, tableMoveModule } from '../../sessionMove'
import type { WorkModule } from '../modules'
import { meetingConverters } from './pipeline'
import { meetingsOf } from './service'
import { ensureMeetingTables } from './store'
import { MEETINGS_PREAMBLE, meetingTools } from './tools'
import { ensureVoiceTables } from './voices'

/**
 * The meetings pillar's server module (docs/agents/work-meetings.md): a
 * recording or a transcript the owner drops into a Work thread, as a canvas
 * item of kind `meeting`. Its tables, its methods (`work.meetings.*`), the
 * thread's tools, and the converters that transcribe a recording on this
 * host through `ctx.convert`.
 */
export const meetings: WorkModule = {
  id: 'meetings',
  ensure(db) {
    ensureMeetingTables(db)
    ensureVoiceTables(db)
    // A thread that moves takes its meetings' rows. The voices stay: they are this host's, and their tables have no thread column.
    registerMoveModule(db, tableMoveModule('meetings', 'work_meetings'))
  },
  async handle(req, ctx, by) {
    const meetings = meetingsOf(ctx)
    switch (req.method) {
      case 'work.meetings.get':
        return handled({ meeting: meetings.get(ctx, req.params.itemId) })
      case 'work.meetings.start':
        return handled({ meeting: await meetings.start(ctx, req.params.itemId, req.params.source) })
      case 'work.meetings.cancel':
        return handled({ meeting: await meetings.cancel(ctx, req.params.itemId) })
      case 'work.meetings.speaker':
        return handled({ meeting: meetings.nameSpeaker(ctx, req.params.itemId, req.params.speakerId, req.params.name) })
      case 'work.meetings.decide':
        return handled(await meetings.decide(ctx, req.params.itemId, req.params.actionIds, req.params.decision))
      case 'work.meetings.undoNotes':
        return handled({ meeting: meetings.undoNotes(ctx, req.params.itemId) })
      case 'work.meetings.voices':
        return handled({ voices: meetings.listVoices() })
      case 'work.meetings.forgetVoice':
        return handled({ voices: meetings.forgetVoice(req.params.name) })
      case 'work.meetings.recording': {
        const { itemId, offset, length } = req.params
        const path = meetings.recordingPath(ctx, itemId)
        if (!ctx.reaches(by, path)) throw new FenceError(req.method)
        const range = await readRange(path, offset, length).catch(() => {
          throw new Error(`${basename(path)} is not on ${ctx.host} any more.`)
        })
        return handled({ name: basename(path), ...range } satisfies MeetingRecordingRange)
      }
    }
    return NOT_HANDLED
  },
  tools: () => meetingTools,
  convert: meetingConverters(),
  preamble: () => MEETINGS_PREAMBLE,
  start(ctx) {
    const meetings = meetingsOf(ctx)
    // What a process that is gone left mid-transcription says so, with Try again.
    meetings.recover(ctx)
    return () => meetings.stopAll(`It stopped when Work was turned off on ${ctx.host}. The recording is fine.`)
  },
  sessionsRemoved(ids, ctx) {
    meetingsOf(ctx).removeSessions(ids)
  }
}
