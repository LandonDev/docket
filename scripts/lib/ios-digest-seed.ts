/**
 * The digest set's seeds (scripts/ios-sim-proof.sh `digest`), run by the set
 * itself between shots, so the empty list is shot before anything is told:
 *
 *   bun scripts/lib/ios-digest-seed.ts on      Work on, nothing else
 *   bun scripts/lib/ios-digest-seed.ts seed    the work set's seeds, a Cosmic job, and tells that wait
 *   bun scripts/lib/ios-digest-seed.ts day     the digest's time one minute ahead; the host's own look makes the day
 *   bun scripts/lib/ios-digest-seed.ts since   tells after the day, and the time back to 8:00
 *
 * The server's address and admin key come in the environment (TC_DIGEST_BASE_URL, TC_DIGEST_CONTROL_URL,
 * TC_DIGEST_ADMIN_KEY, TC_DIGEST_ENVIRONMENT_ID) from scripts/ios-sim-proof-local.ts; never printed. What later steps and the shots
 * need (ids, the day) is kept as JSON in TC_DIGEST_STATE and printed as `key=value` lines for the shell.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { seedWork, socket, WORK_MAIL_ID, type WorkSeedReady } from './ios-work-seeds'

type State = { environmentId: string; purdue: string; unify: string; cosmic: string; thread: string; cosmicThread: string; unifyThread: string; held: string; day?: string }

const ready: WorkSeedReady = { baseUrl: env('TC_DIGEST_BASE_URL'), controlUrl: env('TC_DIGEST_CONTROL_URL'), adminKey: env('TC_DIGEST_ADMIN_KEY') }
const statePath = env('TC_DIGEST_STATE')
const repo = resolve(import.meta.dir, '../..')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`ios-digest-seed: ${name} is not set`)
  return value
}
const state = (): State => JSON.parse(readFileSync(statePath, 'utf8')) as State
const keep = (s: State): void => writeFileSync(statePath, JSON.stringify(s, null, 2))
const say = (s: Record<string, unknown>): void => console.log(Object.entries(s).map(([k, v]) => `${k}=${String(v)}`).join('\n'))

async function tells(rows: Record<string, unknown>[]): Promise<void> {
  const res = await fetch(`${ready.controlUrl}/work-tells`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tells: rows }) })
  if (!res.ok) throw new Error(`/work-tells answered ${res.status}: ${await res.text()}`)
}

const step = process.argv[2]
const s = await socket(ready)
try {
  if (step === 'on') {
    await s.call('work.set', { enabled: true })
    say({ on: true })
  } else if (step === 'seed') {
    const ids = await seedWork(ready, repo)
    const cosmic = await s.call<{ id: string }>('workspace.create', { kind: 'work', name: 'Cosmic', sector: 'cosmic' })
    const cosmicThread = await s.call<{ id: string }>('session.create', { scope: 'work', workspaceId: cosmic.id, threadType: 'chat', provider: 'claude', model: 'claude-opus-5-5', title: 'Weekly sponsor recap' })
    // "Venue for the spring LAN" made the held mail; "Overdue invoices" is Unify's.
    const thread = ids.venue
    const unifyThread = ids.invoices
    const environmentId = env('TC_DIGEST_ENVIRONMENT_ID')
    const now = Date.now()
    const min = 60_000
    const today = (h: number, m: number): number => {
      const d = new Date(now)
      d.setHours(h, m, 0, 0)
      return d.getTime()
    }
    // What waited for the day's digest: a held mail, a routine's result, an answer he waits on, a meeting with a
    // clock, and a sign-in about no one job. No key under a source's prefix (`prep:`, `lapse:`, `winvm:`): that
    // source's next read would withdraw a row it did not name.
    await tells([
      { kind: 'outbox.held', group: 'held', workspaceId: ids.purdue, sector: 'purdue', title: 'Held: Send to events booking', key: `held:host:${WORK_MAIL_ID}`, open: { held: { at: 'host', id: WORK_MAIL_ID }, ...(thread ? { thread } : {}) }, at: now - 50 * min },
      { kind: 'routines.done', group: 'results', workspaceId: cosmic.id, sector: 'cosmic', title: 'Weekly sponsor recap finished', detail: 'Three sponsors updated in the tracker', key: `thread:${cosmicThread.id}`, open: { thread: cosmicThread.id }, at: now - 40 * min },
      { kind: 'mail.waiting', group: 'people', workspaceId: ids.purdue, sector: 'purdue', title: 'Dana Reyes has not answered', detail: 'Re: budget for the spring LAN, sent Thursday', key: 'mail:dana-budget', open: { view: 'mail', workspaceId: ids.purdue }, at: now - 30 * min },
      { kind: 'prep.ready', group: 'meetings', workspaceId: ids.purdue, sector: 'purdue', title: 'Prep is ready: Budget review with Dana Reyes', detail: 'Three open questions from last week', key: 'seed:budget-review', by: today(14, 0), at: now - 20 * min },
      { kind: 'connections.ending', group: 'ending', workspaceId: null, sector: null, title: 'The Microsoft sign-in ends in 3 days', detail: 'Sign in again from Connections', key: 'ending:microsoft', open: { settings: 'connections' }, at: now - 10 * min }
    ])
    keep({ environmentId, purdue: ids.purdue, unify: ids.unify, cosmic: cosmic.id, thread, cosmicThread: cosmicThread.id, unifyThread, held: WORK_MAIL_ID })
    say({ purdue: ids.purdue, cosmic: cosmic.id, thread, held: WORK_MAIL_ID })
  } else if (step === 'day') {
    // One minute ahead in the host's own zone; its 30 s look makes the day once that minute has passed.
    const settings = await s.call<{ zone: string }>('work.digest.get', {})
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: settings.zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + 60_000))
    const at = `${parts.find((p) => p.type === 'hour')!.value}:${parts.find((p) => p.type === 'minute')!.value}`
    await s.call('work.digest.set', { at })
    console.error(`ios-digest-seed: the digest's time set to ${at} (${settings.zone})`)
    let day: string | undefined
    for (let i = 0; i < 60 && !day; i++) {
      await sleep(5_000)
      const list = await s.call<{ days: { day: string; count: number }[] }>('work.digest.list', {})
      day = list.days[0]?.day
    }
    if (!day) throw new Error('no day was made in five minutes')
    const kept = state()
    keep({ ...kept, day })
    say({ day, at })
  } else if (step === 'since') {
    const kept = state()
    const now = Date.now()
    await tells([
      { kind: 'outbox.held', group: 'held', workspaceId: kept.purdue, sector: 'purdue', title: 'Held: Post in Esports staff', key: 'held:host:m46-post', open: { held: { at: 'host', id: 'm46-post' }, ...(kept.thread ? { thread: kept.thread } : {}) }, at: now - 60_000 },
      { kind: 'routines.failed', group: 'results', workspaceId: kept.unify, sector: 'unify', title: 'Invoice check failed', detail: 'The billing sheet was not shared with the routine', ...(kept.unifyThread ? { key: `thread:${kept.unifyThread}`, open: { thread: kept.unifyThread } } : {}), at: now - 30_000 }
    ])
    // Settings shows the time he would keep, and one group moved off its default.
    await s.call('work.digest.set', { at: '08:00', levels: { results: 'digest' } })
    say({ since: 2 })
  } else {
    throw new Error(`ios-digest-seed: unknown step ${String(step)} (on, seed, day, since)`)
  }
} finally {
  s.close()
}
