import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { GuestCreated, GuestLinkRow } from '@shared/contract-work-guests'
import { GuestsRequestSchemas } from '@shared/contract-work-guests'
import { ATTEMPT_CUT, ATTEMPT_GONE, ATTEMPT_KEPT_MS, ATTEMPT_OTHER, askOf, ensureGuestAttemptsTable, guestAttemptOf, makeOnce, rekeyOnce } from './attempts'

const row = (id: string): GuestLinkRow => ({
  id,
  name: 'Dana Lee',
  source: { at: 'lifeos', table: 'docs', id: 'doc1' },
  title: 'Budget',
  role: 'view',
  createdAt: 1,
  expiresAt: 2,
  revokedAt: null,
  by: 'owner',
  lastOpenedAt: null,
  open: 0
})

function setup() {
  const db = new DatabaseSync(':memory:')
  ensureGuestAttemptsTable(db)
  const links = new Map<string, GuestLinkRow>()
  let made = 0
  const make = async (): Promise<GuestCreated> => {
    made += 1
    const link = row(`link${made}`)
    links.set(link.id, link)
    return { link, url: `https://share.example/g/${link.id}#k=secret${made}` }
  }
  const linkOf = async (id: string) => links.get(id) ?? null
  return { db, make, linkOf, links, count: () => made }
}

const ask = askOf({ source: { at: 'lifeos', table: 'docs', id: 'doc1' }, name: 'Dana Lee' })

describe('a Create link answered once by its attempt key', () => {
  it('takes the key on the wire: 8 to 64 characters, and the read-back', () => {
    const create = GuestsRequestSchemas.find((s) => s.shape.method.value === 'work.guests.create')!
    const base = { id: '1', method: 'work.guests.create', params: { source: { at: 'lifeos', table: 'docs', id: 'doc1' }, title: 'Budget', name: 'Dana', role: 'view', expiresAt: 5 } }
    expect(create.safeParse(base).success).toBe(true)
    expect(create.safeParse({ ...base, params: { ...base.params, attempt: 'abcdefgh' } }).success).toBe(true)
    expect(create.safeParse({ ...base, params: { ...base.params, attempt: 'short' } }).success).toBe(false)
    expect(GuestsRequestSchemas.some((s) => s.shape.method.value === 'work.guests.attempt')).toBe(true)
  })

  it('makes one link for a double press after the first answered, and the repeat carries no address', async () => {
    const t = setup()
    const first = await makeOnce(t.db, { attempt: 'press-0001', ask }, t.make, t.linkOf)
    expect('url' in first && first.url).toContain('#k=secret1')
    const again = await makeOnce(t.db, { attempt: 'press-0001', ask }, t.make, t.linkOf)
    expect(again).toEqual({ link: row('link1'), again: true })
    expect(t.count()).toBe(1)
    // The address is never kept: nothing of it is in the table.
    const kept = JSON.stringify(t.db.prepare('SELECT * FROM work_guests_attempts').all())
    expect(kept).not.toContain('secret')
  })

  it('answers two presses that arrive together from one making, address and all', async () => {
    const t = setup()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = async (): Promise<GuestCreated> => {
      await gate
      return t.make()
    }
    const a = makeOnce(t.db, { attempt: 'press-0002', ask }, slow, t.linkOf)
    const b = makeOnce(t.db, { attempt: 'press-0002', ask }, slow, t.linkOf)
    expect(guestAttemptOf(t.db, 'press-0002')).toEqual({ state: 'making' })
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toEqual(rb)
    expect(t.count()).toBe(1)
  })

  it('reads a lost answer back by its key without making anything', async () => {
    const t = setup()
    await makeOnce(t.db, { attempt: 'press-0003', ask }, t.make, t.linkOf)
    expect(guestAttemptOf(t.db, 'press-0003')).toEqual({ state: 'made', linkId: 'link1' })
    expect(guestAttemptOf(t.db, 'never-heard')).toEqual({ state: 'none' })
    expect(t.count()).toBe(1)
  })

  it('answers a refusal again in the same words and never tries again', async () => {
    const t = setup()
    let tries = 0
    const refuse = async (): Promise<GuestCreated> => {
      tries += 1
      throw new Error('LifeOS did not mark Budget as shared, so no guest link was made. Nothing was made.')
    }
    await expect(makeOnce(t.db, { attempt: 'press-0004', ask }, refuse, t.linkOf)).rejects.toThrow('LifeOS did not mark')
    await expect(makeOnce(t.db, { attempt: 'press-0004', ask }, refuse, t.linkOf)).rejects.toThrow('LifeOS did not mark')
    expect(tries).toBe(1)
    expect(guestAttemptOf(t.db, 'press-0004')).toEqual({ state: 'refused', words: 'LifeOS did not mark Budget as shared, so no guest link was made. Nothing was made.' })
  })

  it('refuses a key reused for another item or person', async () => {
    const t = setup()
    await makeOnce(t.db, { attempt: 'press-0005', ask }, t.make, t.linkOf)
    const other = askOf({ source: { at: 'lifeos', table: 'docs', id: 'doc2' }, name: 'Dana Lee' })
    await expect(makeOnce(t.db, { attempt: 'press-0005', ask: other }, t.make, t.linkOf)).rejects.toThrow(ATTEMPT_OTHER)
    const person = askOf({ source: { at: 'lifeos', table: 'docs', id: 'doc1' }, name: 'Sam' })
    await expect(makeOnce(t.db, { attempt: 'press-0005', ask: person }, t.make, t.linkOf)).rejects.toThrow(ATTEMPT_OTHER)
    expect(t.count()).toBe(1)
  })

  it('says a key cut off by a restart may have made a link, and makes none', async () => {
    const t = setup()
    t.db.prepare('INSERT INTO work_guests_attempts (attempt, ask, state, answer, at) VALUES (?, ?, ?, NULL, ?)').run('press-0006', ask, 'making', Date.now())
    expect(guestAttemptOf(t.db, 'press-0006')).toEqual({ state: 'unknown', words: ATTEMPT_CUT })
    await expect(makeOnce(t.db, { attempt: 'press-0006', ask }, t.make, t.linkOf)).rejects.toThrow(ATTEMPT_CUT)
    expect(t.count()).toBe(0)
  })

  it('says so when the link a key made is no longer listed', async () => {
    const t = setup()
    await makeOnce(t.db, { attempt: 'press-0007', ask }, t.make, t.linkOf)
    t.links.clear()
    await expect(makeOnce(t.db, { attempt: 'press-0007', ask }, t.make, t.linkOf)).rejects.toThrow(ATTEMPT_GONE)
    expect(t.count()).toBe(1)
  })

  it('keeps a key a day', async () => {
    const t = setup()
    const then = Date.now()
    await makeOnce(t.db, { attempt: 'press-0008', ask }, t.make, t.linkOf, then)
    expect(guestAttemptOf(t.db, 'press-0008', then + ATTEMPT_KEPT_MS - 1).state).toBe('made')
    expect(guestAttemptOf(t.db, 'press-0008', then + ATTEMPT_KEPT_MS + 1)).toEqual({ state: 'none' })
  })
})

describe('Replace Address answered once by its attempt key', () => {
  it('rotates once after a lost answer: the repeat says again with no address, and the key reads back as made', async () => {
    const t = setup()
    t.links.set('link9', row('link9'))
    let rotations = 0
    const rekey = async (): Promise<GuestCreated> => {
      rotations += 1
      return { link: row('link9'), url: `https://share.example/g/link9#k=new${rotations}` }
    }
    const first = await rekeyOnce(t.db, { attempt: 'press-0101', linkId: 'link9' }, rekey, t.linkOf)
    expect(first).toEqual({ url: 'https://share.example/g/link9#k=new1' })
    // The answer was lost; his press again with the same key rotates nothing.
    expect(await rekeyOnce(t.db, { attempt: 'press-0101', linkId: 'link9' }, rekey, t.linkOf)).toEqual({ again: true })
    expect(rotations).toBe(1)
    expect(guestAttemptOf(t.db, 'press-0101')).toEqual({ state: 'made', linkId: 'link9' })
    // The same key for another link is another press: refused.
    await expect(rekeyOnce(t.db, { attempt: 'press-0101', linkId: 'link8' }, rekey, t.linkOf)).rejects.toThrow(ATTEMPT_OTHER)
  })
})
