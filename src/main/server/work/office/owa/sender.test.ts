import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwaCarrier } from './carrier'
import type { CallOptions, OwaTransport } from './page'

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
