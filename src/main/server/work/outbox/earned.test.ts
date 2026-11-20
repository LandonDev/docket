import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GrantOffer, OutboxGrant, OutboxItem, ToolRulesCard } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import type { ActKind } from '@shared/work'
import { earn, earnedOf, EarnedStore, ensureEarnedTables, EARN_AT, EARN_DAYS, sameWords, wordsOf, type RunDeps } from './earned'
import { outbox as outboxModule, NOT_A_PERSON } from './index'
import { NO_SUCH_OFFER } from './outbox'
import { adminKey, approveKey, cast, makeRig, readKey, type Rig } from './rig'
import type { HeldRow } from './store'

/**
 * Grants he has earned (docs/agents/work-outbox.md "Offered grants"), as an
 * attacker of the hold meets them: an offer appears only after his own
 * unedited presses on one narrow matcher, is no wider than what he pressed,
 * and only a person with admin can take it.
 */

const DAY = 86_400_000

// ── the reading, alone ───────────────────────────────────────────────────

const mail = (to: string[], over: { cc?: string[]; accountId?: string; text?: string; subject?: string } = {}) => ({
  id: 'ob_1',
  status: 'draft',
  message: {
    kind: 'mail',
    accountId: over.accountId ?? 'acct_purdue',
    to: to.map((address) => ({ address })),
    cc: (over.cc ?? []).map((address) => ({ address })),
    bcc: [],
    subject: over.subject ?? 'Re: budget',
    html: '<p>Attached.</p>',
    text: over.text ?? 'Attached.'
  }
})
const call = (args: Record<string, unknown>, digests = true) => ({ addonId: 'ad_1', addon: 'Slack', tool: 'post', words: 'Post message', arguments: args, ...(digests ? { specDigest: 's1', toolDigest: 't1' } : {}) })

describe('what one act earns', () => {
  it('mail: one person on one account, never a domain, never several people', () => {
    expect(earnedOf('mail.send', mail(['Dana@Purdue.edu']))).toEqual({ key: 'mail|acct_purdue|dana@purdue.edu', matcher: { accountId: 'acct_purdue', recipients: ['dana@purdue.edu'] }, label: 'Mail to dana@purdue.edu' })
    // named by the address, never by a display name the draft carries, and from the address it goes from
    const named = mail(['dana@purdue.edu'])
    Object.assign(named.message, { to: [{ name: 'Dana Lee', address: 'dana@purdue.edu' }], from: { address: 'Landon@purdue.edu' } })
    expect(earnedOf('mail.send', named)?.label).toBe('Mail to dana@purdue.edu from landon@purdue.edu')
    expect(earnedOf('mail.send', mail(['dana@purdue.edu'], { cc: ['sam@purdue.edu'] }))).toBeNull()
    expect(earnedOf('mail.send', mail(['dana@purdue.edu', 'sam@purdue.edu']))).toBeNull()
    expect(earnedOf('mail.send', mail([]))).toBeNull()
    // the same person twice is still one person
    expect(earnedOf('mail.send', mail(['dana@purdue.edu'], { cc: ['DANA@purdue.edu'] }))?.matcher).toEqual({ accountId: 'acct_purdue', recipients: ['dana@purdue.edu'] })
    expect(JSON.stringify(earnedOf('mail.send', mail(['dana@purdue.edu'])))).not.toContain('domains')
  })

  it('a calendar act: one answer kind on one account and calendar, or an invite of one person; a change, a cancel or a series earns none', () => {
    const op = (kind: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id: 'op_1', kind, account: 'landon@purdue.edu', calendarId: 'cal_1', payload, ...extra })
    expect(earnedOf('calendar.op', op('accept'))).toMatchObject({ matcher: { kind: 'accept', account: 'landon@purdue.edu', calendarId: 'cal_1' }, label: 'Accept invitations on landon@purdue.edu' })
    expect(earnedOf('calendar.op', op('create', { attendees: [{ address: 'dana@purdue.edu', name: 'Dana' }] }))).toMatchObject({ matcher: { kind: 'create', attendees: ['dana@purdue.edu'] }, label: 'Invites to dana@purdue.edu on landon@purdue.edu' })
    expect(earnedOf('calendar.op', op('create', { attendees: [{ address: 'dana@purdue.edu' }, { address: 'sam@purdue.edu' }] }))).toBeNull()
    expect(earnedOf('calendar.op', op('create'))).toBeNull()
    for (const kind of ['update', 'cancel', 'propose']) expect(earnedOf('calendar.op', op(kind)), kind).toBeNull()
    expect(earnedOf('calendar.op', op('accept', { series: true }))).toBeNull()
    expect(earnedOf('calendar.op', op('accept', { attendees: [{ address: 'x@y.z' }] }))).toBeNull()
    expect(earnedOf('calendar.op', op('accept', {}, { account: undefined }))).toBeNull()
  })

  it('an add-on call: the tool with every argument fixed, and only when the call carries the digests a grant binds', () => {
    const e = earnedOf('addon.call', call({ channel: '#team', text: 'Standup at 10' }))!
    expect(e.matcher).toEqual({ addonId: 'ad_1', tool: 'post', arguments: { channel: '#team', text: 'Standup at 10' } })
    expect(e.matcher).not.toHaveProperty('free')
    expect(earnedOf('addon.call', call({ text: 'Standup at 10', channel: '#team' }))!.key).toBe(e.key)
    expect(earnedOf('addon.call', call({ channel: '#team', text: 'Standup at 11' }))!.key).not.toBe(e.key)
    expect(earnedOf('addon.call', call({ channel: '#team' }, false))).toBeNull()
  })

  it('a kind that takes no grant earns nothing: a computer act, a Teams post, anything else', () => {
    for (const kind of ['computer.act', 'teams.post', 'forms.publish', 'share.guestLink'] as ActKind[]) expect(earnedOf(kind, { chat: 'x', text: 'y', tool: 'click', args: {} }), kind).toBeNull()
  })

  it("an act's words are what he could change; spacing alone is no edit", () => {
    const same = (a: unknown, b: unknown, kind: ActKind = 'mail.send') => sameWords(kind, wordsOf(kind, a), wordsOf(kind, b))
    expect(same(mail(['dana@purdue.edu'], { text: 'Attached.\n\nLandon' }), mail(['dana@purdue.edu'], { text: 'Attached.\r\n\r\nLandon ' }))).toBe(true)
    expect(same(mail(['dana@purdue.edu']), mail(['dana@purdue.edu'], { text: 'Attached, thanks.' }))).toBe(false)
    expect(same(mail(['dana@purdue.edu']), mail(['dana@purdue.edu'], { subject: 'Budget' }))).toBe(false)
    // what goes besides the plain text: a link changed in the html, a file put on, another From
    const linked = mail(['dana@purdue.edu'])
    linked.message.html = '<p>Attached: <a href="https://evil.test">the sheet</a></p>'
    expect(same(mail(['dana@purdue.edu']), linked)).toBe(false)
    expect(same(mail(['dana@purdue.edu']), { ...mail(['dana@purdue.edu']), message: { ...mail(['dana@purdue.edu']).message, attachments: [{ name: 'x.pdf' }] } })).toBe(false)
    expect(same(mail(['dana@purdue.edu']), { ...mail(['dana@purdue.edu']), message: { ...mail(['dana@purdue.edu']).message, from: { address: 'alias@purdue.edu' } } })).toBe(false)
    // an add-on's arguments are compared exactly: a tool may tell two spaces from one
    expect(same(call({ id: 'a  b' }), call({ id: 'a b' }), 'addon.call')).toBe(false)
    expect(sameWords('mail.send', null, null)).toBe(false)
    expect(wordsOf('teams.post', { chat: 'Esports staff', text: 'On my way' })).toEqual({ chat: 'Esports staff', text: 'On my way' })
    expect(wordsOf('computer.act', {})).toBeNull()
  })
})

// ── the count, alone ─────────────────────────────────────────────────────

describe('the run', () => {
  let db: DatabaseSync
  let earned: EarnedStore
  let rows: HeldRow[]
  let n = 0
  const now = 100 * DAY
  const routines: Record<string, string> = { 'run-a1': 'routine-a', 'run-a2': 'routine-a', 'run-b1': 'routine-b' }
  let granted = false
  const deps = (): RunDeps => ({
    earned,
    decidedSince: (kind, ws, since) => rows.filter((r) => r.kind === kind && r.workspaceId === ws && (r.decidedAt ?? 0) >= since).sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0) || b.n - a.n),
    routineOf: (id) => routines[id] ?? null,
    granted: () => granted,
    notGrantable: (p) => (p as { read?: { grantable?: boolean } }).read?.grantable === false,
    now: () => now
  })
  /** One act he decided, its first sight kept as the thread wrote it unless `edited`. */
  const act = (o: { to?: string[]; state?: HeldRow['state']; by?: string; edited?: boolean | unknown; at?: number; ws?: string | null; run?: string; why?: string; kind?: ActKind; payload?: unknown } = {}): HeldRow => {
    const id = `ha_${++n}`
    const kind = o.kind ?? 'mail.send'
    const payload = o.payload ?? mail(o.to ?? ['dana@purdue.edu'])
    const row = {
      n,
      id,
      runKey: `host:${id}`,
      kind,
      payload,
      sessionId: 't-work',
      workspaceId: o.ws === undefined ? 'ws-purdue' : o.ws,
      state: o.state ?? 'sent',
      decidedBy: o.by ?? 'owner',
      decidedAt: o.at ?? now - (100 - n) * 1000,
      why: o.why ?? 'lifeos',
      routineRunId: o.run ?? null
    } as unknown as HeldRow
    // edited: what the thread first wrote, when it was not what went (true: other words to the same people)
    earned.noteFirst(row.runKey, kind, o.edited === true ? mail(o.to ?? ['dana@purdue.edu'], { text: 'What the agent wrote.' }) : (o.edited ?? payload))
    rows.push(row)
    return row
  }
  const press = (o: Parameters<typeof act>[0] = {}) => earn(deps(), act(o))

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    ensureEarnedTables(db)
    earned = new EarnedStore(db, () => now)
    rows = []
    n = 0
    granted = false
  })

  it(`offers after ${EARN_AT} unedited presses in a row, once, from the press that completed the run`, () => {
    for (let i = 1; i < EARN_AT; i++) expect(press(), `press ${i}`).toBeNull()
    const offer = press()!
    expect(offer).toMatchObject({ workspaceId: 'ws-purdue', kind: 'mail.send', label: 'Mail to dana@purdue.edu', routineId: null, count: EARN_AT, from: { at: 'host', id: rows.at(-1)!.id }, state: 'open' })
    expect(offer.matcher).toEqual({ accountId: 'acct_purdue', recipients: ['dana@purdue.edu'] })
    // once: a sixth press, or a hundredth, makes no second offer for that matcher
    expect(press()).toBeNull()
    earned.claim(offer.id, 'dismissed')
    for (let i = 0; i < EARN_AT * 2; i++) expect(press()).toBeNull()
  })

  it('an edited send breaks the run, and so does a discard: the count starts again after it', () => {
    for (let i = 0; i < EARN_AT - 1; i++) press()
    expect(press({ edited: true })).toBeNull()
    for (let i = 0; i < EARN_AT - 1; i++) expect(press()).toBeNull()
    press({ state: 'discarded' })
    for (let i = 0; i < EARN_AT - 1; i++) expect(press()).toBeNull()
    expect(press()).not.toBeNull()
  })

  it('an act never seen as the thread wrote it does not count', () => {
    for (let i = 0; i < EARN_AT - 1; i++) press()
    const row = act()
    db.prepare('DELETE FROM work_held_first WHERE run_key = ?').run(row.runKey)
    expect(earn(deps(), row)).toBeNull()
  })

  it("a grant's send is no press of his: it neither counts nor breaks the run, and what happened while he was away is a grant's", () => {
    for (let i = 0; i < EARN_AT - 1; i++) press()
    expect(press({ by: 'grant:gr_1' })).toBeNull()
    act({ by: 'grant:gr_1' })
    act({ by: 'grant:gr_1' })
    expect(press()).not.toBeNull()
  })

  it(`counts only presses within ${EARN_DAYS} days`, () => {
    for (let i = 0; i < EARN_AT - 1; i++) act({ at: now - (EARN_DAYS + 1) * DAY })
    expect(press()).toBeNull()
  })

  it('another person, another account or another workspace is another run', () => {
    for (let i = 0; i < EARN_AT - 1; i++) press()
    act({ to: ['sam@purdue.edu'] })
    act({ payload: mail(['dana@purdue.edu'], { accountId: 'acct_life' }) })
    expect(press()).not.toBeNull()
    rows = []
    for (let i = 0; i < EARN_AT - 1; i++) act({ ws: 'ws-ref', to: ['lee@purdue.edu'] })
    expect(press({ to: ['lee@purdue.edu'] })).toBeNull()
    // a Work Chat's act (no workspace) earns nothing
    for (let i = 0; i < EARN_AT; i++) expect(press({ ws: null, to: ['kim@purdue.edu'] })).toBeNull()
  })

  it('a send he moved from one person to another breaks the first person\'s run too', () => {
    for (let i = 0; i < EARN_AT - 1; i++) press()
    // the thread wrote to Dana; he sent it to Sam
    act({ to: ['sam@purdue.edu'], edited: mail(['dana@purdue.edu']) })
    expect(press()).toBeNull()
  })

  it('a send still going, or one that failed, is no clean press and breaks the run until it is decided again', () => {
    for (let i = 0; i < EARN_AT - 1; i++) press()
    act({ state: 'sending' })
    expect(press()).toBeNull()
    for (let i = 0; i < EARN_AT - 2; i++) press()
    act({ state: 'failed' })
    expect(press()).toBeNull()
  })

  it('several sent by one press are one gesture: none of them counts, and they break the run', () => {
    for (let i = 0; i < EARN_AT - 1; i++) press()
    const batch = act()
    earned.markBatch(batch.runKey)
    expect(press()).toBeNull()
    for (let i = 0; i < EARN_AT - 2; i++) expect(press()).toBeNull()
    expect(press()).not.toBeNull()
  })

  it("keeps the run's sends with the offer", () => {
    for (let i = 0; i < EARN_AT - 1; i++) press()
    const offer = press()!
    expect(offer.run).toEqual(rows.slice(-EARN_AT).map((r) => r.runKey).reverse())
  })

  it('none for a call held only because its add-on was never reviewed, for an act read as no grant\'s, or while a grant already fits', () => {
    const addon = call({ channel: '#team' })
    for (let i = 0; i < EARN_AT; i++) expect(press({ kind: 'addon.call', payload: addon, why: 'unreviewed' })).toBeNull()
    for (let i = 0; i < EARN_AT; i++) expect(press({ to: ['ops@purdue.edu'], payload: { ...mail(['ops@purdue.edu']), read: { grantable: false } } })).toBeNull()
    granted = true
    for (let i = 0; i < EARN_AT; i++) expect(press({ to: ['lee@purdue.edu'] })).toBeNull()
  })

  it('a computer act earns nothing, however often he presses it as it was read', () => {
    const screen = { tool: 'computer_click', args: { element: 4 }, app: { name: 'Teams', bundleId: null }, window: null, why: 'screen', label: 'Send', title: 'Click Send in Teams', read: null, picture: null, mark: 'm', targets: [] }
    for (let i = 0; i < EARN_AT * 2; i++) expect(press({ kind: 'computer.act', payload: screen })).toBeNull()
  })

  it("a routine's runs earn a grant for that routine alone, never mixed with other threads' presses; a run nobody can place earns none", () => {
    for (let i = 0; i < EARN_AT - 1; i++) press()
    // the routine's press does not complete the ordinary run, and the ordinary presses do not count toward the routine's
    expect(press({ run: 'run-a1' })).toBeNull()
    for (let i = 0; i < EARN_AT - 2; i++) expect(press({ run: i % 2 ? 'run-a1' : 'run-a2' })).toBeNull()
    // routine-b is another routine
    expect(press({ run: 'run-b1' })).toBeNull()
    const offer = press({ run: 'run-a2' })!
    expect(offer).toMatchObject({ routineId: 'routine-a' })
    for (let i = 0; i < EARN_AT; i++) expect(press({ to: ['sam@purdue.edu'], run: 'run-nobody-knows' })).toBeNull()
  })
})

// ── the offer, on the real hold ──────────────────────────────────────────

let rig: Rig
const settled = () => new Promise((r) => setTimeout(r, 15))
const list = async () => (await rig.rpc<{ items: OutboxItem[] }>('work.outbox.list')).items
const offers = async (by?: never) => (await rig.rpc<{ offers: GrantOffer[] }>('work.outbox.offers', {}, by)).offers

/** A draft a Work thread made in LifeOS, then his press on it, after his edit when given. */
async function pressMail(over: Parameters<Rig['lifeos']['draft']>[0] = {}, edit?: string): Promise<OutboxItem> {
  const id = rig.lifeos.draft({ to: ['dana@purdue.edu'], ...over })
  rig.lifeos.fire()
  await settled()
  let item = (await list()).find((i) => i.ref.at === 'lifeos' && i.ref.id === id)!
  if (edit) {
    const payload = item.payload as { message: Record<string, unknown> }
    item = await rig.rpc<OutboxItem>('work.outbox.edit', { ref: item.ref, payload: { message: { ...payload.message, text: edit } } })
    await settled()
    item = (await list()).find((i) => i.ref.at === 'lifeos' && i.ref.id === id)!
  }
  return rig.rpc<OutboxItem>('work.outbox.send', { ref: item.ref, rev: item.updatedAt })
}

describe('an earned grant on the hold', () => {
  beforeEach(async () => {
    rig = await makeRig()
    cast(rig)
    await settled()
  })
  afterEach(async () => {
    await rig.close()
  })

  it('is offered once his fifth unedited press goes, beside that item; his press makes the same grant he could have made by hand, and the next mail goes by it', async () => {
    for (let i = 1; i < EARN_AT; i++) {
      await pressMail()
      expect(await offers(), `after ${i}`).toEqual([])
    }
    const fifth = await pressMail()
    expect(fifth.state).toBe('sent')
    const [offer] = await offers()
    expect(offer).toMatchObject({ workspaceId: 'ws-purdue', kind: 'mail.send', label: 'Mail to dana@purdue.edu from landon@purdue.edu', routineId: null, from: fifth.ref, count: EARN_AT })
    // the screen never gets the matcher: the host keeps it
    expect(offer).not.toHaveProperty('matcher')
    // the thread is not told it earned anything
    expect(rig.whispers.map((w) => w.text).join('\n')).not.toMatch(/grant|offer/i)
    const grant = await rig.rpc<OutboxGrant>('work.outbox.takeOffer', { id: offer!.id })
    expect(grant).toMatchObject({ workspaceId: 'ws-purdue', kind: 'mail.send', matcher: { accountId: 'acct_purdue', recipients: ['dana@purdue.edu'] }, label: 'Mail to dana@purdue.edu from landon@purdue.edu', madeFrom: fifth.ref, routineId: null })
    expect(await offers()).toEqual([])
    await expect(rig.rpc('work.outbox.takeOffer', { id: offer!.id })).rejects.toThrow(NO_SUCH_OFFER)
    expect(rig.host.store.grants()).toHaveLength(1)
    // the next mail to Dana goes by it; one to Dana and Sam still waits for his press
    const before = rig.lifeos.calls.filter((c) => c.fn === 'compose:send').length
    rig.lifeos.draft({ to: ['dana@purdue.edu'] })
    rig.lifeos.draft({ to: ['dana@purdue.edu', 'sam@purdue.edu'] })
    rig.lifeos.fire()
    await settled()
    await settled()
    expect(rig.lifeos.calls.filter((c) => c.fn === 'compose:send').length - before).toBe(1)
    expect((await list()).filter((i) => i.state === 'held')).toHaveLength(1)
  })

  it('a send he edited first breaks the run', async () => {
    for (let i = 0; i < EARN_AT - 1; i++) await pressMail()
    await pressMail({}, 'Attached, with the numbers you asked for.')
    expect(await offers()).toEqual([])
    for (let i = 0; i < EARN_AT - 1; i++) await pressMail()
    expect(await offers()).toEqual([])
    await pressMail()
    expect(await offers()).toHaveLength(1)
  })

  it('a draft already changed when the host first saw it never counts: whose words it holds is not known', async () => {
    for (let i = 0; i < EARN_AT - 1; i++) await pressMail()
    const id = rig.lifeos.draft({ to: ['dana@purdue.edu'], at: Date.now() - 10 * 60_000 })
    rig.lifeos.rows.get(id)!.editedAt = Date.now()
    rig.lifeos.fire()
    await settled()
    const item = (await list()).find((i) => i.ref.at === 'lifeos' && i.ref.id === id)!
    await rig.rpc('work.outbox.send', { ref: item.ref, rev: item.updatedAt })
    expect(await offers()).toEqual([])
  })

  it('Away makes no press, so it earns nothing: drafts made while he is away wait, and no offer appears', async () => {
    rig.away.enabled = true
    await settled()
    for (let i = 0; i < EARN_AT + 1; i++) rig.lifeos.draft({ to: ['dana@purdue.edu'] })
    rig.lifeos.fire()
    await settled()
    expect((await list()).filter((i) => i.state === 'held')).toHaveLength(EARN_AT + 1)
    expect(rig.lifeos.calls.filter((c) => c.fn === 'compose:send')).toEqual([])
    expect(await offers()).toEqual([])
  })

  it('dismissed, it is never offered again', async () => {
    for (let i = 0; i < EARN_AT; i++) await pressMail()
    const [offer] = await offers()
    expect(await rig.rpc<GrantOffer>('work.outbox.dismissOffer', { id: offer!.id })).toMatchObject({ id: offer!.id })
    for (let i = 0; i < EARN_AT + 1; i++) await pressMail()
    expect(await offers()).toEqual([])
    await expect(rig.rpc('work.outbox.takeOffer', { id: offer!.id })).rejects.toThrow(NO_SUCH_OFFER)
    expect(rig.host.store.grants({ all: true })).toEqual([])
  })

  it('is no wider than what he pressed: mail to two people earns nothing, and no domain is ever offered', async () => {
    for (let i = 0; i < EARN_AT + 1; i++) await pressMail({ to: ['dana@purdue.edu', 'sam@purdue.edu'] })
    for (let i = 0; i < EARN_AT + 1; i++) await pressMail({ to: [`person${i}@purdue.edu`] })
    expect(await offers()).toEqual([])
  })

  it('only a person sees, takes or dismisses one: a thread is refused, an approve key cannot take one, a read key cannot see one', async () => {
    for (let i = 0; i < EARN_AT; i++) await pressMail()
    const [offer] = await offers()
    const model = { kind: 'model' as const, sessionId: 't-work', caps: ['read', 'operate', 'approve', 'admin'] }
    const req = (method: string, params: unknown) => ({ method, params }) as never
    for (const [method, params] of [
      ['work.outbox.offers', {}],
      ['work.outbox.takeOffer', { id: offer!.id }],
      ['work.outbox.dismissOffer', { id: offer!.id }]
    ] as const)
      await expect(outboxModule.handle!(req(method, params), rig.work.ctx, model as never), method).rejects.toThrow(NOT_A_PERSON)
    const remote = (caps: string[]) => ({ kind: 'remote' as const, caps })
    await expect(outboxModule.handle!(req('work.outbox.offers', {}), rig.work.ctx, remote(['read', 'operate']) as never)).rejects.toThrow(NOT_A_PERSON)
    await expect(outboxModule.handle!(req('work.outbox.takeOffer', { id: offer!.id }), rig.work.ctx, remote(['read', 'operate', 'approve']) as never)).rejects.toThrow(NOT_A_PERSON)
    await expect(outboxModule.handle!(req('work.outbox.dismissOffer', { id: offer!.id }), rig.work.ctx, remote(['read', 'operate', 'approve']) as never)).rejects.toThrow(NOT_A_PERSON)
    expect(rig.host.store.grants()).toEqual([])
    // the socket's gate asks the same before the module hears the call
    const { requiredCapability } = await import('@shared/capabilities')
    const need = (method: string) => requiredCapability({ method } as never)
    expect(['work.outbox.offers', 'work.outbox.takeOffer', 'work.outbox.dismissOffer'].map(need)).toEqual(['approve', 'admin', 'admin'])
    // no tool of a thread names them
    expect(rig.work.tools.of({ id: 't-work', scope: 'work' })?.tools.map((x) => x.name) ?? []).toEqual([])
    // a device with admin takes it
    expect(await offers(approveKey as never)).toHaveLength(1)
    await expect(offers(readKey as never)).rejects.toThrow()
    expect(await rig.rpc<OutboxGrant>('work.outbox.takeOffer', { id: offer!.id }, adminKey)).toMatchObject({ kind: 'mail.send' })
  })

  it('a grant he makes by hand that fits the offered item closes the offer', async () => {
    for (let i = 0; i < EARN_AT; i++) await pressMail()
    const [offer] = await offers()
    await rig.rpc<OutboxGrant>('work.outbox.grant', { from: offer!.from, matcher: { domains: ['purdue.edu'] } })
    expect(await offers()).toEqual([])
    await expect(rig.rpc('work.outbox.takeOffer', { id: offer!.id })).rejects.toThrow(NO_SUCH_OFFER)
  })

  it('five sent by one press of Send N earn nothing', async () => {
    const ids = Array.from({ length: EARN_AT }, () => rig.lifeos.draft({ to: ['dana@purdue.edu'] }))
    rig.lifeos.fire()
    await settled()
    const items = (await list()).filter((i) => i.ref.at === 'lifeos' && ids.includes(i.ref.id))
    for (const item of items) await rig.rpc('work.outbox.send', { ref: item.ref, rev: item.updatedAt, many: true })
    expect(await offers()).toEqual([])
  })

  it("a deleted thread's discard still breaks the run: history is the row's, not the thread's", async () => {
    rig.thread('t-other', { scope: 'work', workspaceId: 'ws-purdue' } as Partial<SessionMeta>)
    for (let i = 0; i < EARN_AT - 1; i++) await pressMail()
    const id = rig.lifeos.draft({ to: ['dana@purdue.edu'], threadId: 't-other' })
    rig.lifeos.fire()
    await settled()
    const item = (await list()).find((i) => i.ref.id === id)!
    await rig.rpc('work.outbox.discard', { ref: item.ref })
    outboxModule.sessionsRemoved!(['t-other'], rig.work.ctx)
    rig.sessions.delete('t-other')
    await pressMail()
    expect(await offers()).toEqual([])
  })

  it('stops standing once a send that earned it comes back failed', async () => {
    for (let i = 0; i < EARN_AT; i++) await pressMail()
    const [offer] = await offers()
    const first = rig.host.store.byRunKey(`lifeos:outbox:${(await offers())[0]!.from.id}`)!
    expect(first.state).toBe('sent')
    // an earlier send of the run: LifeOS's own lane failed it after the host recorded it gone
    const earlier = rig.host.store.list({ show: 'decided' }).find((r) => r.id !== first.id && r.state === 'sent')!
    rig.host.store.failSent(earlier.id, 'Gmail refused it')
    expect(await offers()).toEqual([])
    await expect(rig.rpc('work.outbox.takeOffer', { id: offer!.id })).rejects.toThrow(NO_SUCH_OFFER)
  })

  it('taken, and then asked for by hand from the same item, is one grant: one Remove ends it', async () => {
    for (let i = 0; i < EARN_AT; i++) await pressMail()
    const [offer] = await offers()
    const taken = await rig.rpc<OutboxGrant>('work.outbox.takeOffer', { id: offer!.id })
    const again = await rig.rpc<OutboxGrant>('work.outbox.grant', { from: offer!.from, matcher: { accountId: 'acct_purdue', recipients: ['dana@purdue.edu'] } })
    expect(again.id).toBe(taken.id)
    expect(rig.host.store.grants()).toHaveLength(1)
    await rig.rpc('work.outbox.ungrant', { id: taken.id })
    expect(rig.host.store.grants()).toEqual([])
  })

  it("an add-on call earns its tool with every argument fixed: a call that differs in any argument is still held after he takes it", async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.rpc<ToolRulesCard>('work.outbox.setRules', { addonId: slack.id, rules: { echo: 'held' } })
    for (let i = 0; i < EARN_AT; i++) {
      await rig.claudeCall('t-work', slack.id, 'echo', { text: 'Standup at 10' })
      const [item] = await rig.waiting()
      await rig.rpc('work.outbox.send', { ref: item!.ref })
    }
    const [offer] = await offers()
    const grant = await rig.rpc<OutboxGrant>('work.outbox.takeOffer', { id: offer!.id })
    expect(grant.matcher).toMatchObject({ addonId: slack.id, tool: 'echo', arguments: { text: 'Standup at 10' } })
    expect(grant.matcher).not.toHaveProperty('free')
    rig.downstream.length = 0
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'Standup at 11' })
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'Standup at 10', bcc: 'everyone' })
    expect(rig.downstream).toEqual([])
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'Standup at 10' })
    expect(rig.downstream).toHaveLength(1)
  })

  it("tells each decided listener what the thread wrote, beside the act as it went: the house rules read his edits from it", async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.rpc<ToolRulesCard>('work.outbox.setRules', { addonId: slack.id, rules: { echo: 'held' } })
    const seen: { sent: unknown; asHeld: unknown }[] = []
    const off = rig.work.ctx.held.onDecided((item, asHeld) => seen.push({ sent: (item.payload as { arguments: unknown }).arguments, asHeld }))
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'Sounds great!! See you at 7' })
    const [item] = await rig.waiting()
    const edited = await rig.rpc<OutboxItem>('work.outbox.edit', { ref: item!.ref, payload: { arguments: { text: 'See you at 7' } } })
    await rig.rpc('work.outbox.send', { ref: edited.ref })
    off()
    expect(seen).toEqual([{ sent: { text: 'See you at 7' }, asHeld: { addonId: slack.id, tool: 'echo', arguments: { text: 'Sounds great!! See you at 7' } } }])
  })

  it("a routine's acts earn a grant for that routine alone; taking it gives the routine's grant", async () => {
    rig.work.ctx.db.exec(`CREATE TABLE IF NOT EXISTS work_routine_runs (id TEXT PRIMARY KEY, routine_id TEXT NOT NULL)`)
    rig.work.ctx.db.exec(`INSERT INTO work_routine_runs (id, routine_id) VALUES ('run-a1', 'routine-a')`)
    rig.thread('t-a1', { scope: 'work', workspaceId: 'ws-purdue', routineRunId: 'run-a1' } as Partial<SessionMeta>)
    for (let i = 0; i < EARN_AT; i++) await pressMail({ threadId: 't-a1', routineRunId: 'run-a1' })
    const [offer] = await offers()
    expect(offer).toMatchObject({ routineId: 'routine-a' })
    expect(await rig.rpc<OutboxGrant>('work.outbox.takeOffer', { id: offer!.id })).toMatchObject({ routineId: 'routine-a' })
    // an ordinary thread's mail to Dana is still held
    const id = rig.lifeos.draft({ to: ['dana@purdue.edu'] })
    rig.lifeos.fire()
    await settled()
    expect((await list()).find((i) => i.ref.id === id)?.state).toBe('held')
  })
})
