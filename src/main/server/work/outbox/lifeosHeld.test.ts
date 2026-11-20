import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutboxGrant, OutboxItem } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import { CHANGED_SINCE, REV_NEEDED } from './outbox'
import { mailGrantFits, mailWords, type MailSendPayload } from './lifeosHeld'
import { outboxHostOf } from './ctx'
import { approveKey, cast, makeRig, until, type Rig } from './rig'
import { INTERRUPTED } from './store'

/**
 * The mail LifeOS holds for this host's threads, as the host owns it
 * (docs/agents/work-outbox.md): listed with the host's own held rows, sent
 * only by the owner's press through the host, matched against the same
 * grants, and the linked task completed when it goes.
 */

let rig: Rig
const list = async (show?: string) => (await rig.rpc<{ items: OutboxItem[]; waiting: number }>('work.outbox.list', show ? { show } : undefined))
const sends = () => rig.lifeos.calls.filter((c) => c.fn === 'compose:send')
const settled = () => new Promise((r) => setTimeout(r, 15))

beforeEach(async () => {
  rig = await makeRig()
  cast(rig)
  await settled()
})
afterEach(async () => {
  await rig.close()
})

describe('a draft a Work thread made in LifeOS', () => {
  it("says its list is loaded only once LifeOS has answered the watch, and not again after Work goes off and on until it answers", async () => {
    const outbox = outboxHostOf(rig.work.ctx)!.outbox
    expect(outbox.lifeos?.loaded()).toBe(true)
    rig.lifeos.connected = false
    rig.work.settings.set({ enabled: false })
    rig.work.settings.set({ enabled: true })
    await settled()
    expect(outbox.lifeos?.loaded()).toBe(false)
    rig.lifeos.connected = true
    rig.lifeos.fire()
    await settled()
    expect(outbox.lifeos?.loaded()).toBe(true)
  })

  it('is listed with this host\'s own held rows, as one list, in his words, and told once as held', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'x' })
    const id = rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'Re: budget', text: 'Attached.' })
    rig.lifeos.fire()
    await settled()
    const { items, waiting } = await list()
    expect(waiting).toBe(2)
    expect(items.map((i) => [i.ref.at, i.kind, i.state])).toEqual([
      ['host', 'addon.call', 'held'],
      ['lifeos', 'mail.send', 'held']
    ])
    const mail = items[1]!
    expect(mail).toMatchObject({ ref: { at: 'lifeos', table: 'outbox', id }, summary: 'Send to dana@purdue.edu: Re: budget', verb: 'Send', workspaceId: 'ws-purdue', sessionId: 't-work', sector: 'purdue', account: 'landon@purdue.edu', why: 'lifeos', n: null })
    expect((mail.payload as MailSendPayload).message).toMatchObject({ subject: 'Re: budget', text: 'Attached.' })
    // the watcher asked LifeOS only for this host's drafts
    expect(rig.lifeos.watchers.find((w) => w.fn === 'outboxHeld:held')?.args).toEqual({ host: 'env_box' })
    expect(rig.notices.filter((n) => (n.ref as { at: string }).at === 'lifeos')).toEqual([{ sessionId: 't-work', body: 'Held: Send to dana@purdue.edu: Re: budget', ref: mail.ref }])
    // firing again tells nobody twice
    rig.lifeos.fire()
    await settled()
    expect(rig.notices.filter((n) => (n.ref as { at: string }).at === 'lifeos')).toHaveLength(1)
    // nothing was sent by listing it
    expect(sends()).toEqual([])
  })

  it("of another host's thread is not this host's to list or to send", async () => {
    const id = rig.lifeos.draft({ host: 'env_mac' })
    rig.lifeos.fire()
    await settled()
    expect((await list()).items).toEqual([])
    await expect(rig.rpc('work.outbox.send', { ref: { at: 'lifeos', table: 'outbox', id }, rev: 1 })).rejects.toThrow('LifeOS no longer holds that item')
    expect(sends()).toEqual([])
  })

  it("carries a reply's quote when read for his eyes, since LifeOS sends it under the body", async () => {
    const id = rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'Re: budget', text: 'Attached.' })
    rig.lifeos.quotes.set(id, '<p>On Tue, Dana wrote:</p><p>Can you send the budget?</p>')
    rig.lifeos.fire()
    await settled()
    const [listed] = (await list()).items
    const read = await rig.rpc<OutboxItem>('work.outbox.get', { ref: listed!.ref })
    expect((read.payload as MailSendPayload).quote).toBe('<p>On Tue, Dana wrote:</p><p>Can you send the budget?</p>')
  })

  it('stays held while he is away', async () => {
    rig.away.enabled = true
    rig.lifeos.draft()
    rig.lifeos.fire()
    await new Promise((r) => setTimeout(r, 40))
    expect((await list()).items.map((i) => i.state)).toEqual(['held'])
    expect(sends()).toEqual([])
  })
})

describe("the owner's press on a LifeOS-held mail", () => {
  const held = async (): Promise<OutboxItem> => {
    rig.lifeos.fire()
    await settled()
    return (await list()).items.find((i) => i.ref.at === 'lifeos')!
  }

  it('sends through the host as the owner, once, with exactly the mail he was shown, and completes the linked task', async () => {
    rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'Re: budget' })
    const item = await held()
    const sent = await rig.rpc<OutboxItem>('work.outbox.send', { ref: item.ref, rev: item.updatedAt })
    expect(sent).toMatchObject({ state: 'sent', decidedBy: 'owner', kind: 'mail.send', n: 1, ref: item.ref })
    expect(sends()).toHaveLength(1)
    expect(sends()[0]!.args).toMatchObject({ id: (item.ref as { id: string }).id, cause: 'press', message: (item.payload as MailSendPayload).message })
    // pressed again, here and from his phone: nothing more goes
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item.ref, rev: item.updatedAt })).toMatchObject({ state: 'sent' })
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item.ref, rev: item.updatedAt }, approveKey)).toMatchObject({ state: 'sent' })
    expect(sends()).toHaveLength(1)
    await settled()
    expect(rig.lifeos.completed).toEqual([{ sessionId: 't-work', reason: 'Sent: Send to dana@purdue.edu: Re: budget' }])
    // gone from what waits, in what was decided, with who pressed and when
    expect((await list()).items).toEqual([])
    const decided = (await list('decided')).items
    expect(decided).toMatchObject([{ state: 'sent', decidedBy: 'owner', summary: 'Send to dana@purdue.edu: Re: budget' }])
    expect(decided[0]!.decidedAt).toBeGreaterThan(0)
    // told to the thread quietly: a sent mail needs no turn
    expect(rig.woke).toEqual([])
    expect(rig.whispers.map((w) => w.text)).toEqual(['The owner sent held item 1 (Send to dana@purdue.edu: Re: budget).'])
  })

  it('names what was read, and is refused when the agent changed the draft since: what goes is what was shown', async () => {
    const id = rig.lifeos.draft({ to: ['dana@purdue.edu'] })
    const item = await held()
    await expect(rig.rpc('work.outbox.send', { ref: item.ref })).rejects.toThrow(REV_NEEDED)
    // the thread's key rewrites its own draft in place after he looked: another recipient
    const row = rig.lifeos.rows.get(id)!
    row.message = { ...(row.message as object), to: [{ address: 'dana@purdue.edu' }, { address: 'someone@elsewhere.example' }] }
    row.editedAt = Number(row.editedAt) + 5
    await expect(rig.rpc('work.outbox.send', { ref: item.ref, rev: item.updatedAt })).rejects.toThrow(CHANGED_SINCE)
    expect(sends()).toEqual([])
    // he looks again and presses on what is there now
    const again = await held()
    expect(again.summary).toBe('Send to dana@purdue.edu, someone@elsewhere.example: Re: budget')
    await rig.rpc('work.outbox.send', { ref: again.ref, rev: again.updatedAt })
    expect(sends()).toHaveLength(1)
    // and LifeOS is told which edit he saw, so it can refuse in its own transaction a row edited after this read
    expect(sends()[0]!.args.editedAt).toBe(again.updatedAt)
  })

  it('pressed twice at once sends once', async () => {
    rig.lifeos.draft()
    const item = await held()
    await Promise.all([rig.rpc('work.outbox.send', { ref: item.ref, rev: item.updatedAt }), rig.rpc('work.outbox.send', { ref: item.ref, rev: item.updatedAt }, approveKey)])
    expect(sends()).toHaveLength(1)
  })

  it('that LifeOS refuses leaves the item failed and waiting, and a later press sends it', async () => {
    rig.lifeos.draft()
    const item = await held()
    rig.lifeos.failNext.set('compose:send', 'this mail is over 25 MB')
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item.ref, rev: item.updatedAt })).toMatchObject({ state: 'failed', error: 'this mail is over 25 MB' })
    expect(rig.lifeos.completed).toEqual([])
    const waiting = (await list()).items
    expect(waiting).toMatchObject([{ state: 'failed', n: 1 }])
    // the failed row is listed with LifeOS's own revision, so a press from the list goes
    expect(waiting[0]!.updatedAt).toBe(item.updatedAt)
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: waiting[0]!.ref, rev: waiting[0]!.updatedAt })).toMatchObject({ state: 'sent' })
    expect(sends()).toHaveLength(2)
  })

  it("recorded as sent comes back as failed when LifeOS's own lane could not send it, and his press queues it again", async () => {
    const id = rig.lifeos.draft()
    const item = await held()
    await rig.rpc('work.outbox.send', { ref: item.ref, rev: item.updatedAt })
    Object.assign(rig.lifeos.rows.get(id)!, { status: 'failed', error: 'Gmail refused the recipient' })
    rig.lifeos.fire()
    await settled()
    const [back] = (await list()).items
    expect(back).toMatchObject({ state: 'failed', error: 'Gmail refused the recipient', n: 1 })
    const live = await rig.rpc<OutboxItem>('work.outbox.get', { ref: back!.ref })
    await rig.rpc('work.outbox.send', { ref: back!.ref, rev: live.updatedAt })
    expect(rig.lifeos.calls.filter((c) => c.fn === 'compose:retry')).toHaveLength(1)
    expect(sends()).toHaveLength(1)
    expect(rig.lifeos.rows.get(id)!.status).toBe('queued')
  })

  it('cut off by a restart is settled by what LifeOS says became of the mail, and never sent twice', async () => {
    const went = rig.lifeos.draft({ subject: 'went' })
    const stayed = rig.lifeos.draft({ subject: 'stayed' })
    rig.lifeos.fire()
    await settled()
    const items = (await list()).items
    // both presses were claimed when the host stopped; LifeOS had taken one of the two
    for (const item of items) await rig.rpc('work.outbox.send', { ref: item.ref, rev: item.updatedAt })
    const store = rig.host.store
    for (const row of store.list({ show: 'all' })) rig.work.ctx.db.prepare(`UPDATE work_held_acts SET state = 'sending' WHERE id = ?`).run(row.id)
    Object.assign(rig.lifeos.rows.get(stayed)!, { status: 'draft' })
    expect(store.recover()).toEqual({ interrupted: 2, lost: 0 })
    expect(store.list().map((r) => r.error)).toEqual([INTERRUPTED, INTERRUPTED])
    const before = sends().length
    rig.lifeos.fire()
    await until(() => store.list({ show: 'decided' }).length === 1)
    expect(store.list({ show: 'decided' })).toMatchObject([{ state: 'sent', summary: 'Send to dana@purdue.edu: went' }])
    expect(store.list()).toMatchObject([{ state: 'failed', error: INTERRUPTED, summary: 'Send to dana@purdue.edu: stayed' }])
    expect(sends()).toHaveLength(before)
    expect(went).toBeTruthy()
  })

  it('or his discard deletes the draft in LifeOS and keeps the decision; an edit saves into the draft and keeps its account', async () => {
    const id = rig.lifeos.draft()
    const item = await held()
    const edited = await rig.rpc<OutboxItem>('work.outbox.edit', { ref: item.ref, payload: { message: { ...(item.payload as MailSendPayload).message, accountId: 'acct_other', subject: 'Re: budget (final)' } } })
    expect(edited.summary).toBe('Send to dana@purdue.edu: Re: budget (final)')
    expect((rig.lifeos.rows.get(id)!.message as { accountId: string }).accountId).toBe('acct_purdue')
    expect(await rig.rpc<OutboxItem>('work.outbox.discard', { ref: item.ref })).toMatchObject({ state: 'discarded', decidedBy: 'owner' })
    expect(rig.lifeos.rows.has(id)).toBe(false)
    expect(sends()).toEqual([])
    expect((await list('decided')).items).toMatchObject([{ state: 'discarded', kind: 'mail.send' }])
  })
})

describe('a grant made from a LifeOS-held mail', () => {
  it('releases the next draft that fits and nothing else, by the same rule as a host row', async () => {
    rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'first' })
    rig.lifeos.fire()
    await settled()
    const [first] = (await list()).items
    // a grant must fit the mail it is made from, and must name whom it is for
    await expect(rig.rpc('work.outbox.grant', { from: first!.ref, matcher: { recipients: ['someone@else.example'] } })).rejects.toThrow('a grant must fit the item it is made from')
    await expect(rig.rpc('work.outbox.grant', { from: first!.ref, matcher: {} })).rejects.toThrow()
    const g = await rig.rpc<OutboxGrant>('work.outbox.grant', { from: first!.ref, matcher: { recipients: ['dana@purdue.edu'] }, label: 'Mail to Dana' })
    expect(g).toMatchObject({ kind: 'mail.send', workspaceId: 'ws-purdue', madeFrom: first!.ref })
    // the one it was made from still waits for his own press
    expect(sends()).toEqual([])
    // the next draft to Dana goes when the watcher first sees it; one to Dana and a stranger does not, nor one from another workspace's thread
    rig.workspace('ws-cosmic', { kind: 'work', sector: 'cosmic' } as never)
    rig.thread('t-cosmic', { scope: 'work', workspaceId: 'ws-cosmic' } as Partial<SessionMeta>)
    const at = Date.now() + 5
    const fits = rig.lifeos.draft({ to: ['Dana@Purdue.edu'], subject: 'second', at })
    rig.lifeos.draft({ to: ['dana@purdue.edu', 'stranger@gmail.com'], subject: 'with a stranger', at })
    rig.lifeos.draft({ to: ['dana@purdue.edu'], cc: ['stranger@gmail.com'], subject: 'copied to a stranger', at })
    rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'from another job', threadId: 't-cosmic', sector: 'cosmic', at })
    rig.lifeos.fire()
    await until(() => sends().length === 1)
    await settled()
    expect(sends()).toHaveLength(1)
    expect(sends()[0]!.args).toMatchObject({ id: fits, cause: 'grant' })
    const decided = (await list('decided')).items
    expect(decided).toMatchObject([{ state: 'sent', decidedBy: `grant:${g.id}`, grantId: g.id, summary: 'Send to Dana@Purdue.edu: second' }])
    expect((await list()).items.map((i) => i.summary).sort()).toEqual([
      'Send to dana@purdue.edu, stranger@gmail.com: copied to a stranger',
      'Send to dana@purdue.edu, stranger@gmail.com: with a stranger',
      'Send to dana@purdue.edu: first',
      'Send to dana@purdue.edu: from another job'
    ])
    // and the task of the thread whose draft went is completed
    expect(rig.lifeos.completed).toEqual([{ sessionId: 't-work', reason: 'Sent: Send to Dana@Purdue.edu: second' }])
  })

  it("made from a routine's draft fits that routine alone: the run is the host's own stamp, never the model's", async () => {
    rig.work.ctx.db.exec(`CREATE TABLE IF NOT EXISTS work_routine_runs (id TEXT PRIMARY KEY, routine_id TEXT NOT NULL)`)
    rig.work.ctx.db.exec(`INSERT INTO work_routine_runs (id, routine_id) VALUES ('run-a1', 'routine-a'), ('run-a2', 'routine-a'), ('run-b1', 'routine-b')`)
    for (const id of ['t-a1', 't-a2', 't-b1']) rig.thread(id, { scope: 'work', workspaceId: 'ws-purdue', routineRunId: `run-${id.slice(2)}` } as Partial<SessionMeta>)
    rig.lifeos.draft({ subject: 'digest 1', threadId: 't-a1', routineRunId: 'run-a1' })
    rig.lifeos.fire()
    await settled()
    const g = await rig.rpc<OutboxGrant>('work.outbox.grant', { from: (await list()).items[0]!.ref, matcher: { domains: ['purdue.edu'] } })
    expect(g.routineId).toBe('routine-a')
    const at = Date.now() + 5
    const next = rig.lifeos.draft({ subject: 'digest 2', threadId: 't-a2', routineRunId: 'run-a2', at })
    rig.lifeos.draft({ subject: 'other routine', threadId: 't-b1', routineRunId: 'run-b1', at })
    rig.lifeos.draft({ subject: 'by hand', threadId: 't-work', at })
    rig.lifeos.fire()
    await until(() => sends().length === 1)
    await settled()
    expect(sends().map((s) => s.args.id)).toEqual([next])
  })
})

describe('the words and the fit of a mail', () => {
  const mail = (to: string[], cc: string[] = [], bcc: string[] = []): MailSendPayload => ({
    id: 'ob',
    status: 'draft',
    message: { kind: 'mail', accountId: 'acct', to: to.map((address) => ({ address })), cc: cc.map((address) => ({ address })), bcc: bcc.map((address) => ({ address })), subject: 'S', html: '', text: '' }
  })
  it('names people by their names, counts past three, and never shows a raw tool name', () => {
    expect(mailWords({ ...mail([]), message: { ...mail([]).message, to: [{ name: 'Dana Lee', address: 'dana@purdue.edu' }], subject: '  Re:   budget ' } })).toEqual({ summary: 'Send to Dana Lee: Re: budget', verb: 'Send' })
    expect(mailWords(mail(['a@x.y', 'b@x.y', 'c@x.y', 'd@x.y', 'e@x.y'])).summary).toBe('Send to a@x.y, b@x.y, c@x.y and 2 more: S')
    expect(mailWords({ ...mail([]), message: { ...mail([]).message, subject: '' } }).summary).toBe('Send to nobody yet: (no subject)')
  })
  it('a grant fits only when every recipient, copied and blind-copied ones too, is one it names', () => {
    expect(mailGrantFits({ recipients: ['dana@purdue.edu'] }, mail(['dana@purdue.edu']))).toBe(true)
    expect(mailGrantFits({ recipients: ['dana@purdue.edu'] }, mail(['dana@purdue.edu'], [], ['hidden@elsewhere.example']))).toBe(false)
    expect(mailGrantFits({ recipients: ['dana@purdue.edu'] }, mail([]))).toBe(false)
    expect(mailGrantFits({ domains: ['purdue.edu'] }, mail(['a@purdue.edu', 'b@PURDUE.edu']))).toBe(true)
    // a domain is itself: not a lookalike, not a subdomain nobody named, not a name with the domain inside it
    expect(mailGrantFits({ domains: ['purdue.edu'] }, mail(['a@evil-purdue.edu']))).toBe(false)
    expect(mailGrantFits({ domains: ['purdue.edu'] }, mail(['a@mail.purdue.edu']))).toBe(false)
    expect(mailGrantFits({ domains: ['purdue.edu'] }, mail(['purdue.edu@attacker.example']))).toBe(false)
    expect(mailGrantFits({ domains: ['purdue.edu'], accountId: 'other' }, mail(['a@purdue.edu']))).toBe(false)
  })
})

describe('calendar acts', () => {
  it('are registered against LifeOS\'s names and answer "not built" until LifeOS has them; nothing of them is listed meanwhile', async () => {
    expect((await list()).items).toEqual([])
    const def = rig.host.outbox.def('calendar.op')
    await expect(def.execute({ id: 'op_1' }, { ...rig.work.ctx, item: {} as never, decidedBy: 'owner' })).rejects.toThrow('not built: calendar acts in LifeOS (milestone 24)')
  })
})
