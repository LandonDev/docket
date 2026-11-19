import { PREFIX, Run } from './e2e-work-lib'

/**
 * The last step of a proof session (milestone 49): looks through the owner's
 * real LifeOS for anything the e2e-work jobs left. A task or a draft named
 * `E2E-49` is taken away by the run's own end (`leftovers`); here, any
 * device session named `E2E-49 …` that is still live, other than this run's
 * own, is revoked, and so is any live key named for an `E2E-49` workspace.
 * It lists, without touching them, the live TempCode keys made in the last
 * day, since a Work Chats key carries no workspace name: a person tells his
 * own from a proof's by time. Passes when nothing was left.
 */
const run = new Run('sweep')
try {
  await run.start()
  await run.signIn('sweep')
  const found = (await run.query<{ _id: string; title: string; status: string }[]>('tasks:search', { text: PREFIX })).filter((t) => t.title.startsWith(PREFIX))
  run.note(`${found.length} proof tasks in LifeOS: ${[...new Set(found.map((t) => t.status))].join(', ') || 'none'}`)
  const sessions = (await run.query<{ _id: string; name: string; revokedAt?: number }[]>('auth:sessions')).filter((s) => s.revokedAt === undefined && s.name.startsWith(PREFIX) && s.name !== run.sessionName)
  for (const s of sessions) await run.mutation('auth:revoke', { id: s._id })
  const bots = await run.query<{ _id: string; name: string; revokedAt?: number; _creationTime?: number }[]>('bots:list')
  const named = bots.filter((b) => b.revokedAt === undefined && b.name.includes(PREFIX))
  for (const b of named) await run.mutation('bots:revoke', { id: b._id })
  const own = new Set(run.keyNames())
  const day = bots.filter((b) => b.revokedAt === undefined && b.name.startsWith('TempCode ') && !own.has(b.name) && (b._creationTime ?? 0) > Date.now() - 86_400_000)
  for (const b of day) run.note(`live TempCode key made ${new Date(b._creationTime ?? 0).toISOString()}: ${b.name} (${b._id})`)
  const left = [...sessions.map((s) => `session ${s.name}`), ...named.map((b) => `key ${b.name}`)]
  run.check('no proof session or proof key was left live in LifeOS', left.length === 0, `revoked now: ${left.join('; ')}`)
} catch (err) {
  await run.finish(err)
}
await run.finish()
