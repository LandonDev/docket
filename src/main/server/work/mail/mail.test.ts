import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { CanvasItem } from '@shared/work'
import { loadWorkModules, type WorkCtx } from '../modules'
import { outbox as outboxModule } from '../outbox'
import { cast, makeRig, readKey as reader, type Rig } from '../outbox/rig'
import { CHANGED, ELSEWHERE, ensureMailTables, HELD_NOT_SCHEDULED, mail, openDrafts, stillSeen, type MailRow } from '.'
import { outgoingHtml } from './outgoing'

/**
 * The mail pillar on the host (docs/agents/work-mail.md): TempCode's Send,
 * which goes through the hold for a thread's draft and as the owner's own
 * `compose.send` otherwise, both with the HTML cleaned; and a thread's draft
 * opened beside it once.
 */

describe('the outgoing rules', () => {
  it('drop what could run and keep what a mail looks like', () => {
    const html = [
      '<!-- a comment --><p onclick="steal()" style="color: red">Hi <b>there</b></p>',
      '<script>alert(1)</script><iframe src="https://x.test"></iframe><object data="x"></object>',
      '<form action="https://x.test"><input name="q"><button>Go</button></form>',
      '<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test">',
      '<a href="javascript:alert(1)">a</a><a href="java&#x09;script:alert(1)">b</a><a href="JaVaScRiPt&colon;x">c</a>',
      '<a href="https://ok.test/?a=1&amp;b=2" target="_blank">ok</a><a href="mailto:dana@purdue.edu">mail</a><a href="#top">top</a>',
      '<img src="data:image/png;base64,AAAA"><img src="cid:logo@1" alt="logo"><img src="//cdn.test/x.png">',
      '<table border="1" cellpadding="4" bgcolor="#eeeeee" style="background:#eeeeee"><tr><th colspan="2">H</th></tr><tr><td data-x="1" class="xl65">1</td></tr></table>',
      '<style>p { color: blue }</style><div style="width: expression(alert(1))">x</div>'
    ].join('')
    const out = outgoingHtml(html)
    expect(out).not.toMatch(/script|onclick|iframe|object|<form|<input|<button|<base|<meta|data:|expression|evil|<!--/i)
    expect(out).toContain('<p style="color: red">Hi <b>there</b></p>')
    expect(out).toContain('Go')
    expect(out).toContain('<a>a</a><a>b</a><a>c</a>')
    expect(out).toContain('<a href="https://ok.test/?a=1&amp;b=2" target="_blank">ok</a><a href="mailto:dana@purdue.edu">mail</a><a href="#top">top</a>')
    expect(out).toContain('<img><img src="cid:logo@1" alt="logo"><img>')
    expect(out).toContain('<table border="1" cellpadding="4" bgcolor="#eeeeee" style="background:#eeeeee"><tr><th colspan="2">H</th></tr><tr><td class="xl65">1</td></tr></table>')
    expect(out).toContain('<style>p { color: blue }</style><div>x</div>')
  })

  it('reads a stray quote as browsers do, so nothing after it is lost', () => {
    expect(outgoingHtml(`<img alt=Don't src=https://x.test/a.png><p>rest</p>`)).toBe(`<img alt="Don't" src="https://x.test/a.png"><p>rest</p>`)
    expect(outgoingHtml('<p>one</p><td width=50%">two</td><p>three</p>')).toBe('<p>one</p><td width="50%&quot;">two</td><p>three</p>')
  })

  it('keeps a character reference it does not know as written, and still escapes a bare ampersand', () => {
    expect(outgoingHtml('<span title="&eacute;t&eacute; &amp; R&D">x</span>')).toBe('<span title="&eacute;t&eacute; &amp; R&amp;D">x</span>')
  })

  it('reads CSS escapes before it judges a style, in an attribute and in a style block', () => {
    expect(outgoingHtml('<div style="width:\\65 xpression(alert(1))">a</div>')).toBe('<div>a</div>')
    expect(outgoingHtml('<div style="background:url(\\6a avascript:x)">a</div>')).toBe('<div>a</div>')
    expect(outgoingHtml('<style>@import url(https://x.test/a.css); p{}</style><p>b</p>')).toBe('<style></style><p>b</p>')
  })

  it('never lets a quote or a broken tag open markup of its own', () => {
    expect(outgoingHtml('<a title="x"><img src=x onerror=alert(1)>">y</a>')).toBe('<a title="x"><img>"&gt;y</a>')
    expect(outgoingHtml('1 < 2 and <3 >')).toBe('1 &lt; 2 and &lt;3 &gt;')
    expect(outgoingHtml('<p>cut <b')).toBe('<p>cut &lt;b')
    expect(outgoingHtml('<style>x</style ><p>a</p>')).toBe('<style>x</style><p>a</p>')
    expect(outgoingHtml('<style></style><script>a</style></script>')).toBe('<style></style>')
  })
})

describe('Send from TempCode', () => {
  let rig: Rig
  const sends = () => rig.lifeos.calls.filter((c) => c.fn === 'compose:send')
  const settled = () => new Promise((r) => setTimeout(r, 15))

  type Files = { attachments?: { storageId: string; name: string }[]; forwardParts?: { partId: string; name: string }[] }
  /** What the composer saved: the row as it stands, its HTML and files included, as kit.tsx says them. */
  const seenOf = (id: string) => {
    const m = (rig.lifeos.rows.get(id) as { message: { to: { address: string }[]; cc: { address: string }[]; bcc: { address: string }[]; subject: string; text: string; html?: string } & Files }).message
    const attachments = [...(m.attachments ?? []).map((f) => ({ id: f.storageId, name: f.name })), ...(m.forwardParts ?? []).map((f) => ({ id: `part:${f.partId}`, name: f.name }))]
    const sender = m as { accountId?: string; from?: { name?: string; address: string } }
    return { to: m.to.map((a) => a.address), cc: m.cc.map((a) => a.address), bcc: m.bcc.map((a) => a.address), subject: m.subject, text: m.text, html: m.html ?? '', attachments, ...(sender.accountId ? { accountId: sender.accountId } : {}), ...(sender.from ? { from: sender.from } : {}) }
  }

  beforeEach(async () => {
    // The press finds the Outbox through the registry, as it does in the app.
    await loadWorkModules()
    rig = await makeRig({ modules: [outboxModule, mail] })
    cast(rig)
    await settled()
  })
  afterEach(async () => {
    await rig.close()
  })

  it("goes through the hold for a draft one of this host's threads made: one send, cleaned, the task completed, Sent in the Outbox", async () => {
    const id = rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'Re: budget', text: 'Attached.' })
    const row = rig.lifeos.rows.get(id)! as { message: { html: string } }
    row.message.html = '<p>Attached.</p><img src=x onerror="alert(1)">'
    rig.lifeos.fire()
    await settled()
    expect(await rig.rpc('work.mail.send', { id, seen: seenOf(id) })).toEqual({ id, via: 'hold' })
    expect(sends()).toHaveLength(1)
    expect(sends()[0]!.args).toMatchObject({ id, cause: 'press' })
    expect((sends()[0]!.args.message as { html: string }).html).toBe('<p>Attached.</p><img>')
    expect(rig.lifeos.completed.map((c) => c.sessionId)).toEqual(['t-work'])
    const { items } = await rig.rpc<{ items: OutboxItem[] }>('work.outbox.list', { show: 'all' })
    expect(items.find((i) => i.ref.at === 'lifeos' && i.ref.id === id)).toMatchObject({ state: 'sent', decidedBy: 'owner' })
    // a second press sends nothing twice
    await rig.rpc('work.mail.send', { id, seen: seenOf(id) }).catch(() => null)
    expect(sends()).toHaveLength(1)
  })

  it("tells LifeOS a held draft is due at once only when his press already waited in the window", async () => {
    // The composer's waited press: the hold sends it, and LifeOS need not queue it again.
    const waited = rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'Re: budget', text: 'Now.' })
    rig.lifeos.fire()
    await settled()
    expect(await rig.rpc('work.mail.send', { id: waited, seen: seenOf(waited), waited: true })).toEqual({ id: waited, via: 'hold' })
    expect(sends().at(-1)!.args).toMatchObject({ id: waited, cause: 'press', immediate: true })

    // The same hold, pressed from the Outbox page: no mark, so LifeOS queues it with its own Undo.
    const paged = rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'Re: budget', text: 'Later.' })
    rig.lifeos.fire()
    await settled()
    const { items } = await rig.rpc<{ items: OutboxItem[] }>('work.outbox.list', {})
    const item = items.find((i) => i.ref.at === 'lifeos' && i.ref.id === paged)!
    await rig.rpc('work.outbox.send', { ref: item.ref, rev: item.updatedAt })
    expect(sends().at(-1)!.args).toMatchObject({ id: paged, cause: 'press' })
    expect(sends().at(-1)!.args).not.toHaveProperty('immediate')

    // A press that did not wait, through the composer's own road: no immediate either.
    const plain = rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'Re: budget', text: 'Plain.' })
    rig.lifeos.fire()
    await settled()
    await rig.rpc('work.mail.send', { id: plain, seen: seenOf(plain) })
    expect(sends().at(-1)!.args).not.toHaveProperty('immediate')
  })

  it('never carries a waited mark over to his own mail or to a later send', async () => {
    const own = rig.lifeos.draft({ subject: 'Lunch' })
    delete (rig.lifeos.rows.get(own)! as { origin?: unknown }).origin
    // `waited` means nothing for his own mail, which keeps LifeOS's queue.
    expect(await rig.rpc('work.mail.send', { id: own, seen: seenOf(own), waited: true })).toEqual({ id: own, via: 'owner' })
    expect(sends().at(-1)!.args).not.toHaveProperty('immediate')
    // A waited press the hold refused leaves no mark behind for the next send of that draft.
    const held = rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'Re: budget', text: 'Held.' })
    rig.lifeos.fire()
    await settled()
    const seen = seenOf(held)
    ;(rig.lifeos.rows.get(held)! as { message: { text: string } }).message.text = 'Changed after the press.'
    await expect(rig.rpc('work.mail.send', { id: held, seen, waited: true })).rejects.toThrow()
    await rig.rpc('work.mail.send', { id: held, seen: seenOf(held) })
    expect(sends().at(-1)!.args).toMatchObject({ id: held })
    expect(sends().at(-1)!.args).not.toHaveProperty('immediate')
  })

  it('goes as his own compose.send for mail he wrote himself, cleaned, at the time he chose', async () => {
    const id = rig.lifeos.draft({ subject: 'Lunch' })
    const row = rig.lifeos.rows.get(id)! as { origin?: unknown; message: { html: string } }
    delete row.origin
    row.message.html = '<p onmouseover="x()">See you</p>'
    const at = Date.now() + 3_600_000
    expect(await rig.rpc('work.mail.send', { id, seen: seenOf(id), sendAt: at })).toEqual({ id, via: 'owner' })
    expect(sends()).toHaveLength(1)
    expect(sends()[0]!.args).toMatchObject({ id, cause: 'press', sendAt: at })
    expect((sends()[0]!.args.message as { html: string }).html).toBe('<p>See you</p>')
  })

  it("refuses a schedule on a thread's draft, another host's draft, and anyone who may not approve", async () => {
    const held = rig.lifeos.draft()
    const far = rig.lifeos.draft({ host: 'env_mac' })
    rig.lifeos.fire()
    await settled()
    await expect(rig.rpc('work.mail.send', { id: held, seen: seenOf(held), sendAt: Date.now() + 60_000 })).rejects.toThrow(HELD_NOT_SCHEDULED)
    await expect(rig.rpc('work.mail.send', { id: far, seen: seenOf(far) })).rejects.toThrow(ELSEWHERE)
    await expect(rig.rpc('work.mail.send', { id: held, seen: seenOf(held) }, reader)).rejects.toThrow()
    await expect(rig.rpc('work.mail.send', { id: 'ob_none', seen: seenOf(held) })).rejects.toThrow('LifeOS has no such mail')
    expect(sends()).toEqual([])
  })

  it('sends nothing when the row no longer says what he pressed Send on', async () => {
    const id = rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'Re: budget', text: 'Attached.' })
    rig.lifeos.fire()
    await settled()
    const seen = seenOf(id)
    // the thread's agent rewrites the draft between the composer's save and the press
    ;(rig.lifeos.rows.get(id) as { message: { to: { address: string }[] } }).message.to = [{ address: 'someone@else.test' }]
    await expect(rig.rpc('work.mail.send', { id, seen })).rejects.toThrow(CHANGED)
    expect(sends()).toEqual([])
    expect(stillSeen({ kind: 'mail', to: [{ address: 'A@b.co' }], cc: [], bcc: [], subject: 'S', text: 'T\n' }, { to: ['a@b.co'], cc: [], bcc: [], subject: 'S', text: 'T' })).toBe(true)
    expect(stillSeen({ kind: 'mail', to: [{ address: 'a@b.co' }], cc: [], bcc: [], subject: 'S', text: 'T' }, { to: ['a@b.co'], cc: [], bcc: [], subject: 'S', text: 'U' })).toBe(false)
  })

  it('sends nothing when only the HTML or the files changed after his save, nor for a client that never said them', async () => {
    const id = rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'Re: budget', text: 'Attached.' })
    rig.lifeos.fire()
    await settled()
    const message = (rig.lifeos.rows.get(id) as { message: { html: string } & Files }).message
    const seen = seenOf(id)
    // the words stay; the link under them changes
    message.html = '<p><a href="https://elsewhere.test/pay">Attached.</a></p>'
    await expect(rig.rpc('work.mail.send', { id, seen })).rejects.toThrow(CHANGED)
    // a file is added, or a forwarded part, with the HTML as he saw it
    message.html = seen.html
    message.attachments = [{ storageId: 'st_1', name: 'payroll.xlsx' }]
    await expect(rig.rpc('work.mail.send', { id, seen })).rejects.toThrow(CHANGED)
    message.attachments = []
    message.forwardParts = [{ partId: 'p2', name: 'invoice.pdf' }]
    await expect(rig.rpc('work.mail.send', { id, seen })).rejects.toThrow(CHANGED)
    message.forwardParts = []
    // an older client sends no HTML and no files: a row with HTML is refused, never approved unseen
    const { html: _html, attachments: _files, ...older } = seen
    await expect(rig.rpc('work.mail.send', { id, seen: older })).rejects.toThrow(CHANGED)
    expect(sends()).toEqual([])
    // what he saw, files and all, goes
    message.attachments = [{ storageId: 'st_1', name: 'plan.pdf' }]
    expect(await rig.rpc('work.mail.send', { id, seen: seenOf(id) })).toEqual({ id, via: 'hold' })
    expect(sends()).toHaveLength(1)
    // with neither HTML nor files on the row, the older client's word is enough
    expect(stillSeen({ kind: 'mail', to: [], cc: [], bcc: [], subject: 'S', text: 'T' }, { to: [], cc: [], bcc: [], subject: 'S', text: 'T' })).toBe(true)
  })

  it('sends nothing when the account or the From changed after his save (the hold review)', async () => {
    const id = rig.lifeos.draft({ to: ['dana@purdue.edu'], subject: 'Re: budget', text: 'Attached.' })
    rig.lifeos.fire()
    await settled()
    const message = (rig.lifeos.rows.get(id) as { message: { accountId?: string; from?: { name?: string; address: string } } }).message
    message.accountId = 'acc_purdue'
    message.from = { name: 'Landon', address: 'landon@purdue.edu' }
    const seen = seenOf(id)
    message.accountId = 'acc_personal'
    await expect(rig.rpc('work.mail.send', { id, seen })).rejects.toThrow(CHANGED)
    message.accountId = 'acc_purdue'
    message.from = { name: 'Landon', address: 'events@purdue.edu' }
    await expect(rig.rpc('work.mail.send', { id, seen })).rejects.toThrow(CHANGED)
    // an older client names no sender: a row that has one is refused
    message.from = { name: 'Landon', address: 'landon@purdue.edu' }
    const { accountId: _account, from: _from, ...older } = seen
    await expect(rig.rpc('work.mail.send', { id, seen: older })).rejects.toThrow(CHANGED)
    expect(sends()).toEqual([])
    expect(await rig.rpc('work.mail.send', { id, seen: { ...seen, from: { name: 'Landon', address: 'LANDON@purdue.edu' } } })).toEqual({ id, via: 'hold' })
  })

  it("says so when the hold's send fails, never Sent", async () => {
    const id = rig.lifeos.draft()
    rig.lifeos.fire()
    await settled()
    rig.lifeos.failNext.set('compose:send', 'the work PC is not there to send Purdue mail')
    await expect(rig.rpc('work.mail.send', { id, seen: seenOf(id) })).rejects.toThrow('the work PC is not there')
  })

  it('cleans the HTML of a send pressed in the Outbox too', async () => {
    const id = rig.lifeos.draft()
    ;(rig.lifeos.rows.get(id)! as { message: { html: string } }).message.html = '<p>Hi</p><script>x</script>'
    rig.lifeos.fire()
    await settled()
    const item = (await rig.waiting()).find((i) => i.ref.at === 'lifeos' && i.ref.id === id)!
    await rig.rpc('work.outbox.send', { ref: item.ref, rev: item.updatedAt })
    expect((sends()[0]!.args.message as { html: string }).html).toBe('<p>Hi</p>')
  })
})

describe("a thread's draft beside it", () => {
  function fakeCtx(threads: Record<string, string>) {
    const db = new DatabaseSync(':memory:')
    ensureMailTables(db)
    const items: CanvasItem[] = []
    const ctx = {
      db,
      host: 'env_box',
      log: () => {},
      scopeOf: (id: string) => (threads[id] ? { sessionId: id } : null),
      canvas: {
        paneOf: (id: string) => threads[id]!,
        forSession: (id: string) => items.filter((i) => i.sessionId === id),
        open: (sessionId: string, kind: string, source: CanvasItem['source'], title: string) => {
          const item = { id: `i${items.length + 1}`, sessionId, kind, source, title } as CanvasItem
          items.push(item)
          return item
        }
      }
    } as unknown as WorkCtx
    return { ctx, items }
  }
  const row = (id: string, over: Partial<MailRow> = {}): MailRow => ({
    _id: id,
    _creationTime: 1,
    status: 'draft',
    message: { kind: 'mail', subject: 'Re: Invoice 1042' },
    origin: { app: 'tempcode', threadId: 'sub', host: 'env_box' },
    ...over
  })

  it("opens once, in the pane of the thread's root, and never again after he closes it", () => {
    const { ctx, items } = fakeCtx({ sub: 'root' })
    openDrafts(ctx, [row('ob_1')])
    expect(items.map((i) => [i.sessionId, i.kind, i.source, i.title])).toEqual([['root', 'mail', { at: 'lifeos', table: 'outbox', id: 'ob_1' }, 'Re: Invoice 1042']])
    items.length = 0
    openDrafts(ctx, [row('ob_1')])
    expect(items).toEqual([])
  })

  it("opens nothing for another host's draft, a thread this host does not have, a mail that left, or one with no thread", () => {
    const { ctx, items } = fakeCtx({ sub: 'root' })
    openDrafts(ctx, [
      row('ob_1', { origin: { app: 'tempcode', threadId: 'sub', host: 'env_mac' } }),
      row('ob_2', { origin: { app: 'tempcode', threadId: 'gone', host: 'env_box' } }),
      row('ob_3', { status: 'failed' }),
      row('ob_4', { origin: undefined })
    ])
    expect(items).toEqual([])
  })

  it('tells every Work thread how mail goes', () => {
    expect(mail.preamble?.({} as never)).toMatch(/draft_mail.*never send.*update_mail_draft/s)
  })
})
