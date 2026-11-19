import { PREFIX, Run } from './e2e-work-lib'

/**
 * The last step of a proof session (milestone 49): looks through the owner's
 * real LifeOS for anything the e2e-work jobs made and left (a task or a
 * draft named `E2E-49`, a key or a device session of theirs not revoked) and
 * takes each away through LifeOS's API, with a reason. Passes when nothing
 * was left; says what it took away when something was. Its own session is
 * revoked by its sign-out.
 */
const run = new Run('sweep')
try {
  await run.start({ work: false })
  await run.call('work.set', { enabled: true })
  await run.signIn('sweep')
  const own = `${PREFIX} sweep`
  const found = (await run.query<{ _id: string; title: string; status: string }[]>('tasks:search', { text: PREFIX })).filter((t) => t.title.startsWith(PREFIX))
  run.note(`${found.length} proof tasks found in LifeOS: ${found.map((t) => t.status).join(', ') || 'none'}`)
  const tasks = found.filter((t) => t.status !== 'dropped')
  for (const t of tasks) await run.mutation('tasks:drop', { id: t._id, reason: 'E2E-49 sweep: a proof task its job did not take away' })
  const drafts = (await run.query<{ _id: string; message?: { subject?: string } }[]>('compose:list', { view: 'drafts' })).filter((d) => d.message?.subject?.startsWith(PREFIX))
  for (const d of drafts) await run.mutation('compose:discard', { id: d._id })
  const bots = (await run.query<{ _id: string; name: string; revokedAt?: number }[]>('bots:list')).filter((b) => b.revokedAt === undefined && b.name.includes(PREFIX))
  for (const b of bots) await run.mutation('bots:revoke', { id: b._id })
  const sessions = (await run.query<{ _id: string; name: string; revokedAt?: number }[]>('auth:sessions')).filter((s) => s.revokedAt === undefined && s.name.startsWith(PREFIX) && s.name !== own)
  for (const s of sessions) await run.mutation('auth:revoke', { id: s._id })
  const left = [...tasks.map((t) => `task ${t.title}`), ...drafts.map((d) => `draft ${d.message?.subject}`), ...bots.map((b) => `key ${b.name}`), ...sessions.map((s) => `session ${s.name}`)]
  run.check('nothing a proof made was left in LifeOS', left.length === 0, `taken away now: ${left.join('; ')}`)
} catch (err) {
  await run.finish(err)
}
await run.finish()
