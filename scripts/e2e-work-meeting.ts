import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Meeting } from '../src/shared/contract-work-meetings'
import { PREFIX, REPO, Run, sleep, textOf } from './e2e-work-lib'

/**
 * Job 4 (milestone 49): a meeting file to accepted tasks.
 *
 * A Work thread of the Life workspace opens a 35-second recording of two
 * people (the AMI corpus fixture) as a meeting; the host transcribes it with
 * speaker turns, on the box, with the network shut for the pipeline. The
 * agent reads the transcript and writes the notes with two tasks resting on
 * its turns. The owner accepts one, which is filed in his real LifeOS through
 * the host's own session, and rejects the other, which is filed nowhere. The
 * filed task is dropped through LifeOS's API with a reason at the end.
 */
const run = new Run('meeting')
try {
  await run.start()
  await run.signIn('meeting')
  const ws = await run.workspace('life', `${PREFIX} meetings`)
  const thread = await run.thread(ws, `${PREFIX} staff sync`, { firstMessage: 'Take the tasks out of this recording.' })
  const file = join(run.work, `${PREFIX} staff sync.ogg`)
  copyFileSync(join(REPO, 'src/main/server/work/meetings/fixtures/two-speakers.ogg'), file)

  const t0 = Date.now()
  const opened = await run.tool(thread, 'meeting_open', { file })
  const meetingId = (opened.structuredContent as { item?: string } | undefined)?.item ?? ''
  run.check('the recording opens and is transcribed on the host', !opened.isError && (opened.structuredContent as { status?: string } | undefined)?.status === 'ready', `${textOf(opened).slice(0, 200)} (${Math.round((Date.now() - t0) / 1000)} s)`)
  const transcript = textOf(await run.tool(thread, 'meeting_read', { meeting: meetingId }))
  const turns = [...transcript.matchAll(/^(s\d+) \[[\d:]+\] ([^:]+): (.+)$/gm)]
  run.check('the transcript has turns from two speakers', turns.length >= 2 && new Set(turns.map((m) => m[2])).size >= 2, transcript.slice(0, 300))

  const wrote = await run.tool(thread, 'meeting_notes', {
    meeting: meetingId,
    summary: [{ text: 'Two people talk through the design in turn.', refs: [turns[0]![1]] }],
    actions: [
      { text: `${PREFIX} Follow up on what was said first`, refs: [turns[0]![1]] },
      { text: `${PREFIX} A task he will turn down`, refs: [turns[1]![1]] }
    ]
  })
  run.check('the notes are written, every line resting on a turn', !wrote.isError, textOf(wrote).slice(0, 200))
  const get = async (): Promise<Meeting> => (await run.call<{ meeting: Meeting }>('work.meetings.get', { itemId: meetingId })).meeting
  const actions = (await get()).notes?.actions ?? []
  run.check('both tasks wait for him', actions.length === 2 && actions.every((a) => a.state === 'proposed'), JSON.stringify(actions.map((a) => [a.text, a.state])))

  await run.show(thread)
  await run.until('meeting canvas', 30_000, () => run.has('Follow up on what was said first'))
  await sleep(1500)
  await run.shot('01-meeting-tasks-waiting', { clipLeft: 460 })

  const keep = actions.find((a) => a.text.includes('Follow up'))!
  const drop = actions.find((a) => a.text.includes('turn down'))!
  const decided = await run.call<{ meeting: Meeting; failed: unknown[] }>('work.meetings.decide', { itemId: meetingId, actionIds: [keep.id], decision: 'accept' })
  run.check('Accept files it', decided.failed.length === 0, JSON.stringify(decided.failed))
  await run.call('work.meetings.decide', { itemId: meetingId, actionIds: [drop.id], decision: 'reject' })
  const after = (await get()).notes!.actions
  const filed = after.find((a) => a.id === keep.id)
  run.check('the accepted task is filed, the other rejected', filed?.state === 'filed' && !!filed.lifeosTaskId && after.find((a) => a.id === drop.id)?.state === 'rejected', JSON.stringify(after))
  if (filed?.lifeosTaskId) {
    const id = filed.lifeosTaskId
    run.later('drop the filed task', () => run.addon(thread, 'drop_tasks', { ids: [id], reason: 'E2E-49 meeting proof: cleanup' }))
    const task = (await run.query<{ task: { title: string; sector: string; description?: string } } | null>('tasks:get', { id }))?.task
    run.check('LifeOS holds it in Life, saying where it was said', task?.sector === 'life' && task.title.includes(PREFIX) && (task.description ?? '').includes('staff sync'), JSON.stringify(task).slice(0, 300))
  }
  const rejected = await run.addon(thread, 'search_tasks', { query: 'A task he will turn down' })
  run.check('the rejected one is nowhere in LifeOS', !textOf(rejected).includes('turn down'), textOf(rejected).slice(0, 200))
  await sleep(1500)
  await run.shot('02-meeting-filed', { clipLeft: 460 })
} catch (err) {
  await run.finish(err)
}
await run.finish()
