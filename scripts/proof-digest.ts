/**
 * The digest, in process (docs/agents/work-digest.md "Proofs"):
 *
 *   bun scripts/proof-bun.ts scripts/proof-digest.ts
 *
 * A made-up Monday across two jobs on a real database, with the pieces the
 * host wires together: the digest's own module and ledger, the Outbox's
 * tells, the lapses source, the gate, the deliverer and the real thread
 * notifier, whose sinks are read here as a phone would hear them. Held
 * items, a routine's run that ends, an invite with a clock and a sign-in on
 * its last day go in; out come exactly two interrupts and, at 8:00 the next
 * morning, one digest. Dummy names only. Exits 0 when every check holds.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { DigestPush } from '@shared/contract-work-digest'
import type { EventRow, SessionMeta } from '@shared/events'
import { Notifier, type Notice, type NotifierRegistry } from '../src/main/server/remote/notifier'
import { Digest } from '../src/main/server/work/digest/ctx'
import { makeDeliverer } from '../src/main/server/work/digest/deliver'
import { makeGate } from '../src/main/server/work/digest/gate'
import { digest as digestModule } from '../src/main/server/work/digest'
import { DIGEST_TELLS } from '../src/main/server/work/digest/rule'
import { Sources } from '../src/main/server/work/digest/sources'
import { lapses } from '../src/main/server/work/digest/sources/lapses'
import type { ActKindDef, WorkCtx, WorkModule } from '../src/main/server/work/modules'
import { calendarOpKind } from '../src/main/server/work/outbox/lifeosHeld'
import { heldKey, OUTBOX_TELLS, tellHeld, type TellsDeps } from '../src/main/server/work/outbox/tells'

let checks = 0
const failures: string[] = []
function check(what: string, ok: boolean, got?: unknown): void {
  checks++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || got === undefined ? '' : `\n       got: ${JSON.stringify(got)}`}`)
  if (!ok) failures.push(what)
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

// ── a made-up Monday in New York ───────────────────────────────────────────
const ZONE = 'America/New_York'
const at = (day: number, hhmm: string): number => Date.parse(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00-05:00`)
const clock = { now: at(23, '10:00') }

const base = mkdtempSync(join(tmpdir(), 'tc-proof-digest-'))
const db = new DatabaseSync(join(base, 'proof.db'))
db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT, kind TEXT, sector TEXT, created_at INTEGER)')
for (const [id, name, sector, n] of [['ws-cosmic', 'Cosmic', 'cosmic', 1], ['ws-purdue', 'Purdue', 'purdue', 2]] as const) db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(id, name, join(base, name), 'work', sector, n)
digestModule.ensure(db)

// ── threads, as the registry lists them ────────────────────────────────────
const metas = new Map<string, SessionMeta>()
const metaFns = new Set<(m: SessionMeta) => void>()
const rowFns = new Set<(r: EventRow) => void>()
const seqs = new Map<string, number>()
const registry: NotifierRegistry = {
  onMeta: (fn) => (metaFns.add(fn), () => metaFns.delete(fn)),
  onEvent: (fn) => (rowFns.add(fn), () => rowFns.delete(fn)),
  list: () => [...metas.values()],
  get: (id) => metas.get(id) ?? null,
  rootSessionOf: (id) => metas.get(id)?.parentId ?? id,
  lastActivityAt: () => 0
}
const thread = (id: string, over: Partial<SessionMeta>): void => void metas.set(id, { id, parentId: null, projectId: null, workspaceId: null, title: id, status: 'running', archived: false, scope: 'work', ...over } as SessionMeta)
const settle = (id: string, status: SessionMeta['status']): void => {
  const seq = (seqs.get(id) ?? 0) + 1
  seqs.set(id, seq)
  for (const fn of rowFns) fn({ sessionId: id, seq, ts: clock.now, event: { type: 'assistant-text', id: `m${seq}`, text: 'done' } } as never)
  const meta = { ...metas.get(id)!, status }
  metas.set(id, meta)
  for (const fn of metaFns) fn(meta)
}
thread('t-morning', { title: 'Morning summary', workspaceId: 'ws-cosmic', routineRunId: 'run-1' })
thread('t-invite', { title: 'Plan the Spring LAN walkthrough', workspaceId: 'ws-purdue' })
thread('t-budget', { title: 'Reply to Dana about the budget', workspaceId: 'ws-purdue' })
thread('t-chat', { title: 'A thread he started himself', workspaceId: 'ws-cosmic' })

// ── the phone, as the notifier's sink ──────────────────────────────────────
const heard: Notice[] = []
const notifier = new Notifier({ registry, stuckMinutes: () => 10, hostName: () => 'The box', now: () => clock.now, debounceMs: 20, log: () => {} })
notifier.onNotice((n) => void heard.push(n))

// ── the digest, wired as work/digest/ctx.ts wires it ───────────────────────
const pushes: DigestPush[] = []
const logs: string[] = []
const lapsing = { until: at(23, '18:30') }
const modules = [
  { id: 'outbox', ensure() {}, tells: OUTBOX_TELLS },
  { id: 'digest', ensure() {}, tells: DIGEST_TELLS },
  { id: 'frameio', ensure() {}, health: { check: async () => [], lapses: () => [{ id: 'frameio.signin', pillar: 'frameio', title: 'Sign-in to Frame.io', until: lapsing.until }] } }
] as unknown as WorkModule[]
const digest = new Digest({ db, host: 'env_proof', enabled: () => true, log: (l) => void logs.push(l), push: (p) => void pushes.push(p), modules: () => modules, now: () => clock.now })
digest.here(ZONE)
digest.deliverer = makeDeliverer({ notifier: () => notifier, sendsDigest: () => true, peers: () => [], log: (l) => void logs.push(l) })
const ctx = {
  db,
  host: 'env_proof',
  enabled: () => true,
  log: (l: string) => void logs.push(l),
  tell: Object.assign((t: Parameters<Digest['tell']>[0]) => void digest.tell(t), { done: (key: string) => digest.done(key), only: (prefix: string, keys: readonly string[]) => digest.only(prefix, keys), quiet: (id: string) => digest.quiet(id) })
} as unknown as WorkCtx
const sources = new Sources({ ctx, modules: () => modules, sources: [lapses], day: () => '2026-11-24', zone: () => ZONE, since: () => 0 })
digest.beats.push((now) => sources.beat(now))
notifier.setGate(
  makeGate({
    enabled: () => true,
    isQuiet: (id) => digest.store.isQuiet(id),
    workspaceOf: (id) => metas.get(id)?.workspaceId ?? null,
    // run-1 fired on its schedule; no run here was started with Run now
    pressed: async () => false,
    tell: (t) => void digest.tell(t),
    log: (l) => void logs.push(l)
  })
)
notifier.start()

const tells: TellsDeps = { ctx, kindOf: (kind) => (kind === 'calendar.op' ? (calendarOpKind as unknown as ActKindDef) : undefined), workspaces: () => [{ id: 'ws-cosmic', kind: 'work', sector: 'cosmic' }, { id: 'ws-purdue', kind: 'work', sector: 'purdue' }], now: () => clock.now }
const item = (over: Partial<OutboxItem>): OutboxItem => ({ kind: 'mail.send', verb: 'Send', account: null, state: 'held', payload: {}, createdAt: clock.now, decidedBy: null, decidedAt: null, n: 1, why: 'pillar', grantId: null, error: null, result: null, routineRunId: null, updatedAt: clock.now, ...over }) as OutboxItem

// ── Monday, 10:00 AM: the first look, then the day's news ──────────────────
digest.tick()
const mail = item({ ref: { at: 'lifeos', table: 'outbox', id: 'ob1' }, workspaceId: 'ws-purdue', sector: 'purdue', sessionId: 't-budget', summary: 'Send to Dana Reyes: Re: budget' })
const post = item({ ref: { at: 'host', id: 'h1' }, kind: 'addon.call', workspaceId: 'ws-cosmic', sector: 'cosmic', sessionId: null, summary: 'Post to #patch-notes: the season pass copy' })
const invite = item({ ref: { at: 'lifeos', table: 'calendarOps', id: 'op1' }, kind: 'calendar.op', workspaceId: 'ws-purdue', sector: 'purdue', sessionId: 't-invite', summary: 'Invite Dana Reyes to Spring LAN walkthrough', payload: { id: 'op1', kind: 'create', payload: { title: 'Spring LAN walkthrough', startsAt: at(24, '09:30') } } })
tellHeld(tells, mail)
tellHeld(tells, post)
check('a held item with no clock waits: nothing is sent for the two of them', heard.length === 0, heard)
tellHeld(tells, invite)
check('a held invite for an event at 9:30 tomorrow cannot wait for the 8:00 digest: it interrupts on its own thread, through held', heard.length === 1 && heard[0]!.event === 'needs_you' && heard[0]!.threadId === 't-invite' && heard[0]!.body === 'Held: Invite Dana Reyes to Spring LAN walkthrough' && same(heard[0]!.held, invite.ref), heard)

// a routine's run ends, and a thread he started himself ends
settle('t-morning', 'idle')
settle('t-chat', 'idle')
await sleep(120)
check("a routine's run that ends is kept back from the phone; his own thread's Done still goes", heard.filter((n) => n.event === 'finished').map((n) => n.threadId).join() === 't-chat', heard.map((n) => `${n.event}:${n.threadId ?? 'work'}`))
check('the run is in the ledger as a result on its thread', same(digest.store.byKey('thread:t-morning') && { kind: digest.store.byKey('thread:t-morning')!.kind, group: digest.store.byKey('thread:t-morning')!.group, title: digest.store.byKey('thread:t-morning')!.title, how: digest.store.byKey('thread:t-morning')!.how, open: digest.store.byKey('thread:t-morning')!.open }, { kind: 'routines.done', group: 'results', title: 'Morning summary', how: 'waiting', open: { thread: 't-morning' } }), digest.store.byKey('thread:t-morning'))

// a sign-in on its last day: the source reads it at the next look
clock.now += 30_000
digest.tick()
await sleep(20)
const lapse = heard.find((n) => n.work)
check('a sign-in that ends today interrupts as a notice with no thread, named Work, opening Connections', !!lapse && lapse.event === 'needs_you' && lapse.threadId === undefined && lapse.title === 'Work' && lapse.body === 'Sign-in to Frame.io ends Nov 23 at 6:30 PM' && same(lapse.work, { key: 'now', tell: `lapse:frameio:frameio.signin:${lapsing.until}:1`, by: lapsing.until, open: { settings: 'connections' } }), lapse)
check('two interrupts all day, and no digest yet', heard.filter((n) => n.event === 'needs_you').length === 2 && !heard.some((n) => n.work && 'digest' in n.work), heard.map((n) => `${n.event}:${n.threadId ?? 'work'}`))

// looked at again all afternoon and night: nothing is told twice
for (clock.now = at(23, '12:00'); clock.now < at(24, '07:59'); clock.now += 30 * 60_000) digest.tick()
await sleep(20)
check('nothing is told twice through the afternoon and the night', heard.filter((n) => n.event === 'needs_you').length === 2, heard.length)

// ── Tuesday, 8:00 AM: the digest ───────────────────────────────────────────
clock.now = at(24, '08:00')
digest.tick()
await digest.making
await sleep(20)
const digests = heard.filter((n) => n.work && 'digest' in n.work)
check('at 8:00 one digest goes out, quiet, for what waited across both jobs', digests.length === 1 && digests[0]!.event === 'finished' && digests[0]!.title === 'Work' && digests[0]!.body === 'Digest: 3 things in Cosmic and Purdue' && same(digests[0]!.work, { key: 'digest:2026-11-24', digest: '2026-11-24' }), digests)
const list = digest.list()
check('the day is kept once, counted by what waited', same(list.days.map((d) => [d.day, d.count, d.seenAt]), [['2026-11-24', 3, null]]), list.days)
check('every tell of the day is in the list, whether it interrupted or waited', same(list.rows.map((r) => `${r.how}:${r.group}:${r.sector ?? '-'}`).sort(), ['digest:held:cosmic', 'digest:held:purdue', 'digest:results:cosmic', 'now:ending:-', 'now:held:purdue'].sort()), list.rows.map((r) => `${r.how}:${r.group}:${r.sector ?? '-'}:${r.title}`))
clock.now += 30_000
digest.tick()
clock.now = at(24, '08:20')
digest.tick()
await sleep(20)
check('the day is never made twice', heard.filter((n) => n.work && 'digest' in n.work).length === 1 && digest.list().days.length === 1)

// ── he sends the mail: its row goes, and every window hears ────────────────
pushes.length = 0
ctx.tell.done(heldKey(mail.ref))
check('a held item he sent leaves the ledger, and the windows are told which row went', digest.store.byKey(heldKey(mail.ref)) === null && pushes.length === 1 && typeof pushes[0]!.gone === 'string', pushes)
digest.seen('2026-11-24')
check('opening the digest marks its day seen', digest.list().days[0]!.seenAt === clock.now, digest.list().days)
check('no fault was logged', logs.length === 0, logs)

notifier.stop()
db.close()
rmSync(base, { recursive: true, force: true })
console.log(failures.length ? `\n${failures.length} of ${checks} checks failed` : `\nall ${checks} checks hold`)
process.exit(failures.length ? 1 : 0)
