import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboxItem } from '@shared/contract-work-outbox'
import { WORK_MODULES, type Caller } from '../modules'
import { outbox as outboxModule } from '../outbox/index'
import { cast, makeRig, type Rig } from '../outbox/rig'
import { guestLinkKind, guestRuntime, guests } from '.'
import { guestOriginSetting } from './links'

/*
 * Away lets nobody in (docs/agents/work-guests.md "The methods and the tools", docs/agents/away-from-computer.md): with
 * Away on for the host, a thread's `guest_link` is held as `share.guestLink` and stays held, nothing is made, and no
 * part of Away releases it, since the kind has no matcher and so no grant fits. A thread's own call to any method that
 * makes, widens, re-addresses or revokes a link is refused, whether he is away or not.
 *
 * The outbox's own rig (outbox/rig.ts): the real Work mount, the real hold, Away as the host's switch, with the guests
 * pillar mounted beside the Outbox.
 */

const DOC = 'kdoc1'
const THREAD: Caller = { kind: 'model', caps: [], sessionId: 't-work' } as Caller
let rig: Rig

beforeEach(async () => {
  vi.stubEnv('TEMP_CODE_WORK_PUBLIC_ORIGIN', 'https://proof.example')
  // The held kinds are read from the pillars the app loaded: the guests pillar is one, here as in the app.
  WORK_MODULES.push(guests)
  rig = await makeRig({ modules: [outboxModule, guests] })
  cast(rig)
  // LifeOS as the guests pillar reads it: one document of the thread's sector, and its `shared` mark taken.
  const { query, mutation } = rig.lifeos
  rig.lifeos.query = (<T,>(fn: string, args?: Record<string, unknown>) =>
    fn === 'docs:get' && args?.id === DOC ? Promise.resolve({ _id: DOC, sector: 'purdue', title: 'Spring LAN run of show', shared: false } as T) : query<T>(fn, args)) as typeof query
  rig.lifeos.mutation = (<T,>(fn: string, args?: Record<string, unknown>) => (fn.endsWith(':setShared') ? (rig.lifeos.calls.push({ fn, args: args ?? {} }), Promise.resolve(null as T)) : mutation<T>(fn, args))) as typeof mutation
})
afterEach(async () => {
  vi.unstubAllEnvs()
  WORK_MODULES.splice(WORK_MODULES.indexOf(guests), 1)
  await rig.close()
})

const text = (r: { content: unknown[] }): string => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')
const linkRows = (): number => (rig.work.ctx.db.prepare('SELECT count(*) AS n FROM work_guest_links').get() as { n: number }).n
const marks = () => rig.lifeos.calls.filter((c) => c.fn.endsWith(':setShared'))
const guestHeld = async (): Promise<OutboxItem[]> => (await rig.waiting()).filter((i) => i.kind === 'share.guestLink')

describe("a thread's guest link while he is away", () => {
  it('is held as share.guestLink and stays held: nothing is made, no grant fits it, and no part of Away releases it', async () => {
    rig.away.enabled = true
    const answer = await rig.work.tools.call({ id: 't-work', scope: 'work' }, 'guest_link', { docId: DOC, name: 'Dana Lee', role: 'edit', days: 7 }, new AbortController().signal)
    expect(answer.isError).toBeFalsy()
    expect(text(answer)).toContain('No link exists yet, and nothing was shared')
    const [item, ...more] = await guestHeld()
    expect(more).toEqual([])
    expect(item).toMatchObject({ kind: 'share.guestLink', state: 'held', sessionId: 't-work', workspaceId: 'ws-purdue' })
    expect(item!.payload).toMatchObject({ source: { at: 'lifeos', table: 'docs', id: DOC }, name: 'Dana Lee', role: 'edit' })
    // Nothing is made: no row, no live link, and LifeOS was never asked to mark the document shared.
    expect(linkRows()).toBe(0)
    expect(guestRuntime(rig.work.ctx).store.live()).toEqual([])
    expect(marks()).toEqual([])
    // The kind has no matcher: no grant can be made from it, so none can ever fit one.
    expect(guestLinkKind.matcher).toBeUndefined()
    expect(guestLinkKind.matches).toBeUndefined()
    await expect(rig.rpc('work.outbox.grant', { from: item!.ref, matcher: {} })).rejects.toThrow('share.guestLink is always held; no grant can be made for it')
    expect(rig.host.store.grants({ all: true })).toEqual([])
    // Time passes with nobody there, and the runtime runs its pass: still held, still nothing made. Away had no card
    // to allow either, since the hold asks no approval.
    await new Promise((r) => setTimeout(r, 50))
    await guestRuntime(rig.work.ctx).tick()
    expect((await guestHeld()).map((i) => i.state)).toEqual(['held'])
    expect(rig.cards).toEqual([])
    expect(linkRows()).toBe(0)
    expect(marks()).toEqual([])
    // A second ask while he is still away waits beside the first.
    await rig.work.tools.call({ id: 't-work', scope: 'work' }, 'guest_link', { docId: DOC, name: 'Sam Ortiz', days: 1 }, new AbortController().signal)
    expect((await guestHeld()).map((i) => i.state)).toEqual(['held', 'held'])
    expect(linkRows()).toBe(0)
  })
})

describe("a thread's own call to the owner's guest link methods", () => {
  it('is refused for make, role, new address, revoke and origin, Away on or off, and the link stays as he made it', async () => {
    // His own live link, for the calls to aim at (made in its store: his Create through the service has its own tests).
    const linkId = guestRuntime(rig.work.ctx).store.create({ name: 'Dana Lee', source: { at: 'lifeos', table: 'docs', id: DOC }, title: 'Spring LAN run of show', role: 'view', expiresAt: Date.now() + 7 * 24 * 60 * 60_000, bySession: null }).link.id
    const before = guestRuntime(rig.work.ctx).store.get(linkId)!
    expect(before).toMatchObject({ role: 'view', revokedAt: null, bySession: null })
    const calls = [
      { method: 'work.guests.create', params: { source: { at: 'lifeos', table: 'docs', id: DOC }, title: 'Spring LAN run of show', name: 'Someone else', role: 'edit', expiresAt: Date.now() + 24 * 60 * 60_000 } },
      { method: 'work.guests.setRole', params: { linkId, role: 'edit' } },
      { method: 'work.guests.rekey', params: { linkId } },
      { method: 'work.guests.revoke', params: { linkId } },
      { method: 'work.guests.setOrigin', params: { origin: 'https://share.example' } }
    ]
    for (const away of [false, true]) {
      rig.away.enabled = away
      for (const c of calls) await expect(guests.handle!({ id: '1', ...c } as never, rig.work.ctx, THREAD), `${c.method}, away ${away}`).rejects.toThrow('Only the owner makes or changes a guest link; a thread asks with guest_link.')
    }
    // Nothing moved: one link, his, as he made it, at the same address, and the origin unset.
    expect(linkRows()).toBe(1)
    expect(guestRuntime(rig.work.ctx).store.get(linkId)).toEqual(before)
    expect(guestOriginSetting(rig.work.ctx.db)).toBeNull()
    // The two reads stay a thread's to make.
    expect(await guests.handle!({ id: '1', method: 'work.guests.list', params: {} } as never, rig.work.ctx, THREAD)).toMatchObject({ handled: true })
  })
})
