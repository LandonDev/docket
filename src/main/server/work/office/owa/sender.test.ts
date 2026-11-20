import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwaCarrier } from './carrier'
import type { CallOptions, OwaTransport } from './page'
import * as ews from './ews'

/**
 * Outlook on the web sends from whoever the page is signed in as (the hold review's 17.2): each send asks the page
 * itself, never the saved marker, and asks again when the page is opened anew before its retry.
 */
const SENT = { Body: { ResponseMessages: { Items: [{ ResponseClass: 'Success', Items: [{ ItemId: { Id: 'ev-1' } }] }] } } }

function rig(o: { signedIn: string; marker?: string; reloadAs?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'owa-sender-'))
  const marker = join(root, 'owa.json')
  if (o.marker) writeFileSync(marker, JSON.stringify({ account: o.marker, at: 1 }))
  const state = { signedIn: o.signedIn, sends: [] as string[], asked: 0, reloaded: false }
  const page: OwaTransport = {
    async call<T>(action: string, _body: unknown, opts?: CallOptions): Promise<T> {
      if (action === 'GetOwaUserConfiguration') {
        state.asked++
        return { SessionSettings: { UserEmailAddress: state.signedIn } } as T
      }
      // The first send finds its session gone: the page opens again (signed in as `reloadAs`, if given), then retries.
      if (o.reloadAs && !state.reloaded) {
        state.reloaded = true
        state.signedIn = o.reloadAs
        await opts?.afterReload?.()
      }
      state.sends.push(action)
      return SENT as T
    },
    close() {}
  }
  const carrier = new OwaCarrier({ page: () => page, marker: () => marker, running: () => true, hasSignIn: () => true })
  return { carrier, state, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const mail = { account: 'a@contoso.com', to: ['dana@example.com'], cc: [], bcc: [], subject: 'Plan', html: '<p>Hi</p>' }
const invite = { account: 'a@contoso.com', subject: 'Review', start: '2026-11-20T15:00:00Z', end: '2026-11-20T15:30:00Z', attendees: ['dana@example.com'] }
let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

describe('an Outlook on the web send checks who is signed in now', () => {
  it('sends a mail and an invitation when the live sign-in is the account they were held to go from', async () => {
    const r = rig({ signedIn: 'A@contoso.com', marker: 'a@contoso.com' })
    cleanups.push(r.cleanup)
    await expect(r.carrier.sendMail(mail)).resolves.toEqual({ id: null })
    await expect(r.carrier.createEvent(invite)).resolves.toBe('ev-1')
    expect(r.state.sends).toEqual(['CreateItem', 'CreateItem'])
    expect(r.state.asked).toBe(2)
  })

  it('refuses, sending nothing, when the page is signed in as another account though the marker still names the held one', async () => {
    const r = rig({ signedIn: 'b@contoso.com', marker: 'a@contoso.com' })
    cleanups.push(r.cleanup)
    await expect(r.carrier.sendMail(mail)).rejects.toMatchObject({ code: 'not-found', message: expect.stringContaining('signed in as b@contoso.com now, not a@contoso.com') })
    await expect(r.carrier.createEvent(invite)).rejects.toMatchObject({ code: 'not-found' })
    expect(r.state.sends).toEqual([])
    // The marker now says who is really signed in.
    expect(r.carrier.known()).toBe('b@contoso.com')
  })

  it('asks again after the page reloads for a lost session, and refuses a retry that would go as someone else', async () => {
    const r = rig({ signedIn: 'a@contoso.com', marker: 'a@contoso.com', reloadAs: 'b@contoso.com' })
    cleanups.push(r.cleanup)
    await expect(r.carrier.sendMail(mail)).rejects.toMatchObject({ code: 'not-found' })
    expect(r.state.sends).toEqual([])
    // The same reload back to the held account goes.
    const ok = rig({ signedIn: 'a@contoso.com', marker: 'a@contoso.com', reloadAs: 'a@contoso.com' })
    cleanups.push(ok.cleanup)
    await expect(ok.carrier.sendMail(mail)).resolves.toEqual({ id: null })
    expect(ok.state.asked).toBe(2)
    expect(ok.state.sends).toEqual(['CreateItem'])
  })
})

describe("an invitation's body on Outlook on the web", () => {
  it('goes as plain text, exactly as written, tags and all', () => {
    const body = '<title>I approve the payment.</title><p>Meet at 3</p>'
    const req = ews.createEvent({ account: 'a@contoso.com', subject: 'Review', start: '2026-11-20T15:00:00Z', end: '2026-11-20T15:30:00Z', body, attendees: ['dana@example.com'] }) as { body: { Body: { Items: { Body: unknown }[] } } }
    expect(req.body.Body.Items[0]!.Body).toEqual({ __type: 'BodyContentType:#Exchange', BodyType: 'Text', Value: body })
  })
})

/**
 * A reply or forward on Outlook on the web (the hold review's 21.1): Exchange addresses a ReplyToItem itself, to the
 * mail's Reply-To when it has one, and adds the To named. The stand-in does the same; nothing is sent unless the draft
 * Exchange made is addressed exactly as held.
 */
function exchange(o: { replyTo?: string; fromOf?: string; dropBcc?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'owa-reply-'))
  const marker = join(root, 'owa.json')
  writeFileSync(marker, JSON.stringify({ account: 'a@contoso.com', at: 1 }))
  type Box = { EmailAddress: string }
  const drafts = new Map<string, { To: Box[]; Cc: Box[]; Bcc: Box[] }>()
  const state = { actions: [] as string[], sent: [] as { To: string[]; Cc: string[]; Bcc: string[] }[], deleted: [] as string[] }
  const ok = (items: unknown[] = []) => ({ Body: { ResponseMessages: { Items: [{ ResponseClass: 'Success', Items: items }] } } })
  const page: OwaTransport = {
    async call<T>(action: string, body: unknown): Promise<T> {
      state.actions.push(action)
      const b = (body as { Body: Record<string, unknown> }).Body
      if (action === 'GetOwaUserConfiguration') return { SessionSettings: { UserEmailAddress: 'a@contoso.com' } } as T
      if (action === 'CreateItem') {
        const item = (b.Items as Record<string, unknown>[])[0]!
        const named = (k: string) => ((item[k] ?? []) as Box[]).map((x) => ({ EmailAddress: x.EmailAddress }))
        const auto = String(item.__type).startsWith('ReplyToItem') ? [{ EmailAddress: o.replyTo ?? o.fromOf ?? 'kim@example.com' }] : []
        const id = `d${drafts.size + 1}`
        drafts.set(id, { To: [...auto, ...named('ToRecipients').filter((x) => !auto.some((a) => a.EmailAddress === x.EmailAddress))], Cc: named('CcRecipients'), Bcc: o.dropBcc ? [] : named('BccRecipients') })
        return ok([{ ItemId: { Id: id, ChangeKey: `ck-${id}` } }]) as T
      }
      const id = ((b.ItemIds as { Id: string }[]) ?? [])[0]?.Id ?? ''
      const d = drafts.get(id)!
      if (action === 'GetItem') return ok([{ ItemId: { Id: id, ChangeKey: `ck-${id}` }, ToRecipients: d.To, CcRecipients: d.Cc, BccRecipients: d.Bcc }]) as T
      if (action === 'SendItem') {
        state.sent.push({ To: d.To.map((x) => x.EmailAddress), Cc: d.Cc.map((x) => x.EmailAddress), Bcc: d.Bcc.map((x) => x.EmailAddress) })
        drafts.delete(id)
        return ok() as T
      }
      if (action === 'DeleteItem') {
        state.deleted.push(id)
        drafts.delete(id)
        return ok() as T
      }
      throw new Error(`unknown ${action}`)
    },
    close() {}
  }
  const carrier = new OwaCarrier({ page: () => page, marker: () => marker, running: () => true, hasSignIn: () => true })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return { carrier, state }
}

describe('an Outlook on the web reply or forward goes only to the recipients held', () => {
  const reply = { account: 'a@contoso.com', to: ['kim@example.com'], cc: [], bcc: [], subject: 'Re: Signups', html: '<p>In</p>', replyTo: 'm-44' }

  it("refuses a reply Exchange addressed to the mail's Reply-To, deleting the draft unsent", async () => {
    const r = exchange({ replyTo: 'list@elsewhere.com' })
    await expect(r.carrier.sendMail(reply)).rejects.toMatchObject({
      code: 'refused',
      message: 'Outlook made this reply for To kim@example.com, list@elsewhere.com, not To kim@example.com as held, so nothing was sent.'
    })
    expect(r.state.sent).toEqual([])
    expect(r.state.deleted).toEqual(['d1'])
    expect(r.state.actions).not.toContain('SendItem')
  })

  it('sends a reply addressed exactly as held, as a draft read back first, then sent by its change key', async () => {
    const r = exchange()
    await expect(r.carrier.sendMail({ ...reply, cc: ['Lee@Example.com'] })).resolves.toEqual({ id: null })
    expect(r.state.actions).toEqual(['GetOwaUserConfiguration', 'CreateItem', 'GetItem', 'SendItem'])
    expect(r.state.sent).toEqual([{ To: ['kim@example.com'], Cc: ['Lee@Example.com'], Bcc: [] }])
  })

  it('checks a forward the same way: a recipient missing from what Exchange made is refused too', async () => {
    const fwd = { account: 'a@contoso.com', to: ['lee@example.com'], cc: [], bcc: ['me@contoso.com'], subject: 'Fw: Budget', html: '<p>FYI</p>', forward: 'm-42' }
    const good = exchange()
    await expect(good.carrier.sendMail(fwd)).resolves.toEqual({ id: null })
    expect(good.state.sent).toEqual([{ To: ['lee@example.com'], Cc: [], Bcc: ['me@contoso.com'] }])
    const bad = exchange({ dropBcc: true })
    await expect(bad.carrier.sendMail(fwd)).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('not To lee@example.com; Bcc me@contoso.com as held') })
    expect(bad.state.sent).toEqual([])
  })

  it('a new mail still goes in one request, addressed as given', async () => {
    const r = exchange()
    await r.carrier.sendMail({ account: 'a@contoso.com', to: ['dana@example.com'], cc: [], bcc: [], subject: 'Plan', html: '<p>Hi</p>' })
    expect(r.state.actions).toEqual(['GetOwaUserConfiguration', 'CreateItem'])
  })
})
