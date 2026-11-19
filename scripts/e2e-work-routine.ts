import type { OutboxItem } from '../src/shared/contract-work-outbox'
import type { RoutineRow, RoutineRun } from '../src/shared/contract-work-routines'
import { ownMailbox, PREFIX, Run, sleep, textOf } from './e2e-work-lib'

/**
 * Job 5 (milestone 49): a routine that fires overnight under Away and
 * leaves held items.
 *
 * The owner turns Away on and makes a routine with a schedule (a weekly rule
 * for today, two minutes ahead, in his time zone: the night's firing brought
 * forward), ending after one run. The host's engine fires it on its own
 * clock and starts a Work thread stamped with the run. That thread drafts
 * the digest to his own address through its own LifeOS key (no model turn:
 * see docs/agents/work-proofs.md). The draft waits in the Outbox as the
 * run's, Away does not release it, and the run says it holds something.
 * The owner comes back, turns Away off, sees it still waiting, and discards
 * it. Nothing is sent.
 */
const run = new Run('routine')
const TZ = 'America/Chicago'
try {
  await run.start()
  await run.signIn('routine')
  const box = await ownMailbox(run)
  const ws = await run.workspace(box.defaultSector, `${PREFIX} routines`)
  await run.call('away.set', { enabled: true })
  run.later('Away off', () => run.call('away.set', { enabled: false }))

  // Two minutes ahead, as a weekly rule for today in his zone.
  const at = new Date(Date.now() + 120_000)
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...o }).format(at)
  const day = part({ weekday: 'short' }).slice(0, 2).toUpperCase()
  const rrule = `FREQ=WEEKLY;BYDAY=${day};BYHOUR=${Number(part({ hour: 'numeric', hour12: false })) % 24};BYMINUTE=${Number(part({ minute: 'numeric' }))}`
  const routine = await run.call<RoutineRow>('work.routines.save', {
    workspaceId: ws,
    name: `${PREFIX} overnight digest`,
    prompt: `Draft a short digest of overnight mail to me, subject "${PREFIX} overnight digest". Do not send it.`,
    trigger: { on: 'schedule', rrule, tz: TZ },
    ends: { kind: 'once' }
  })
  run.later('remove the routine', () => run.call('work.routines.remove', { id: routine.id }))
  run.check('the routine is set for its time', !!routine.nextAt && Math.abs(routine.nextAt - at.getTime()) < 61_000, `${rrule} → ${routine.nextAt && new Date(routine.nextAt).toISOString()} (${routine.words})`)

  // The engine fires it on its own.
  let fired: RoutineRun | undefined
  run.check('it fires on its schedule, with nobody at the computer', await run.until('fired', 240_000, async () => !!(fired = (await run.call<{ runs: RoutineRun[] }>('work.routines.runs', { id: routine.id })).runs.find((r) => !!r.sessionId))), JSON.stringify(fired))
  const sessionId = fired!.sessionId!
  run.later('delete the run\'s thread', () => run.call('session.delete', { sessionId }))
  run.check('the run started late by less than a minute', Math.abs(fired!.firedAt - at.getTime()) < 60_000, `${Math.round((fired!.firedAt - at.getTime()) / 1000)} s`)
  const meta = (await run.call<{ id: string; scope?: string; routineRunId?: string }[]>('session.list')).find((s) => s.id === sessionId)
  run.check("its thread is a Work thread stamped with the run", meta?.scope === 'work' && meta.routineRunId === fired!.id, JSON.stringify(meta && { scope: meta.scope, routineRunId: meta.routineRunId }))

  // The run's thread drafts through its own key.
  const d = await run.addon(sessionId, 'draft_mail', { account_id: box._id, to: [{ address: box.address }], subject: `${PREFIX} overnight digest`, body: 'A test digest from TempCode\'s end-to-end proof. Please ignore it.', reason: 'E2E-49 routine proof: discarded at the end' })
  run.check("the run's thread drafted the digest", !d.isError, textOf(d).slice(0, 200))
  const draftId = (JSON.parse(textOf(d)) as { id: string }).id
  run.later('discard the draft', () => run.mutation('compose:discard', { id: draftId }).catch(() => null))
  let held: OutboxItem | undefined
  run.check('the draft waits in the Outbox as the run\'s', await run.until('held', 60_000, async () => !!(held = (await run.call<{ items: OutboxItem[] }>('work.outbox.list', {})).items.find((i) => (i.ref as { id?: string }).id === draftId && i.routineRunId === fired!.id))))
  await sleep(20_000)
  const still = await run.call<OutboxItem>('work.outbox.get', { ref: held!.ref })
  const away = await run.call<{ enabled?: boolean; state?: { enabled: boolean } }>('away.get', {})
  run.check('Away released nothing: twenty seconds on, it still waits', still.state === 'held' && still.decidedBy === null && (away.enabled ?? away.state?.enabled) === true, JSON.stringify({ state: still.state, away }))
  // The turn ends, as a real one does once it has drafted (this thread has no model behind it).
  await run.call('session.interrupt', { sessionId })
  run.check('the run says it holds something', await run.until('run held', 60_000, async () => (await run.call<{ runs: RoutineRun[] }>('work.routines.runs', { id: routine.id })).runs[0]?.state === 'held'), JSON.stringify((await run.call<{ runs: RoutineRun[] }>('work.routines.runs', { id: routine.id })).runs[0]))
  run.check('a once routine ends after its run', (await run.call<{ routines: RoutineRow[] }>('work.routines.list', { workspaceId: ws })).routines.find((r) => r.id === routine.id)?.ended === true)

  // Morning: he is back.
  await run.call('away.set', { enabled: false })
  await run.page(`(() => { const el = [...document.querySelectorAll('button, a, [role=button]')].find((e) => /^Outbox\\d*$/.test(e.textContent.trim())); el?.click() })()`)
  run.check('the Outbox shows the night\'s digest waiting', await run.until('row', 20_000, () => run.has(`${PREFIX} overnight digest`)))
  await sleep(1200)
  await run.shot('01-overnight-held')
  const gone = await run.call<OutboxItem>('work.outbox.discard', { ref: held!.ref })
  run.check('he discards it; nothing was sent', gone.state === 'discarded' && gone.decidedBy === 'owner', gone.state)
} catch (err) {
  await run.finish(err)
}
await run.finish()
