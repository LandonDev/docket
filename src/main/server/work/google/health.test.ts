import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { WorkCtx } from '../modules'
import { canPickHere, googleRows } from './health'
import { google } from './index'
import { setClientId } from './picker'

const CLIENT_ID = '123456-abc.apps.googleusercontent.com'

function ctxWith(o: { connected?: boolean; accounts?: unknown[] | Error; clientId?: string }): { ctx: Pick<WorkCtx, 'db' | 'lifeos'>; calls: string[] } {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  if (o.clientId) setClientId(db, o.clientId)
  const calls: string[] = []
  const query = async (fn: string) => {
    calls.push(fn)
    if (o.accounts instanceof Error) throw o.accounts
    return o.accounts ?? []
  }
  const lifeos = { connected: () => o.connected ?? true, owner: () => ({ query, mutation: query, action: query }) } as unknown as WorkCtx['lifeos']
  return { ctx: { db, lifeos }, calls }
}

describe('google connections', () => {
  it('a working client id and an account that allowed Drive files', async () => {
    const { ctx } = ctxWith({ clientId: CLIENT_ID, accounts: [{ account: 'Me@Purdue.edu', sector: 'purdue', files: true, writes: true }] })
    const rows = await googleRows(ctx, { canPick: true, env: {} })
    expect(rows).toEqual([
      { id: 'google.clientId', pillar: 'google', group: 'Google', title: 'Google Picker', state: 'working', line: "Knows LifeOS's Google client" },
      { id: 'google.consent:me@purdue.edu', pillar: 'google', group: 'Google', title: 'Me@Purdue.edu', shared: true, sector: 'purdue', state: 'working', line: 'Drive files allowed' }
    ])
    // The client id is not a secret, but a row has no need of it.
    expect(JSON.stringify(rows)).not.toContain(CLIENT_ID)
  })

  it('needs him for a missing client id and an account without consent', async () => {
    const { ctx } = ctxWith({ accounts: [{ account: 'me@cosmic.gg', sector: 'cosmic', files: false }] })
    const rows = await googleRows(ctx, { canPick: true, env: {} })
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ['google.clientId', 'needs-you'],
      ['google.consent:me@cosmic.gg', 'needs-you']
    ])
    expect(rows[0]!.line).toContain('TEMP_CODE_GOOGLE_CLIENT_ID')
    expect(rows[1]).toMatchObject({ sector: 'cosmic', line: "Reconnect it in LifeOS and tick every box on Google's page" })
    expect(rows.every((r) => !r.fix)).toBe(true)
  })

  it('reads the client id from the variable too', async () => {
    const { ctx } = ctxWith({ accounts: [{ account: 'a@b.c', files: true }] })
    expect((await googleRows(ctx, { canPick: true, env: { TEMP_CODE_GOOGLE_CLIENT_ID: CLIENT_ID } }))[0]).toMatchObject({ id: 'google.clientId', state: 'working' })
  })

  it('leaves the client id out where no Picker can open, and only the box is such a host', async () => {
    const { ctx } = ctxWith({ accounts: [{ account: 'a@b.c', files: true }] })
    expect((await googleRows(ctx, { canPick: false, env: {} })).map((r) => r.id)).toEqual(['google.consent:a@b.c'])
    expect([canPickHere('darwin'), canPickHere('win32'), canPickHere('linux')]).toEqual([true, true, false])
  })

  it('no rows while LifeOS is not connected (its own row says so), and LifeOS is not asked', async () => {
    const { ctx, calls } = ctxWith({ connected: false, accounts: [{ account: 'a@b.c', files: false }] })
    expect(await googleRows(ctx, { canPick: true, env: {} })).toEqual([])
    expect(calls).toEqual([])
  })

  it('no rows where LifeOS holds no Google account', async () => {
    const { ctx, calls } = ctxWith({ accounts: [] })
    expect(await googleRows(ctx, { canPick: true, env: {} })).toEqual([])
    expect(calls).toEqual(['calendarOps:accounts'])
  })

  it('a failed read throws, which the frame turns into one broken row', async () => {
    const { ctx } = ctxWith({ accounts: new Error('LifeOS is unreachable') })
    await expect(googleRows(ctx, { canPick: true, env: {} })).rejects.toThrow(/unreachable/)
  })

  it('is the module’s health, with nothing that lapses', () => {
    expect(google.health?.check).toBeTypeOf('function')
    expect(google.health?.lapses).toBeUndefined()
  })
})
