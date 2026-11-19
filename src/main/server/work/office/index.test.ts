import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import type { Caller, WorkCtx } from '../modules'
import { FakeOffice } from './fake'
import { office as module, setCarrier } from './index'

/** The office wire: what another host's call may run here, and that a send carried over the link is still held. */
let office: FakeOffice
let held: { kind: string; sessionId: string | null }[]
let ctx: WorkCtx
const peer: Caller = { kind: 'remote', caps: ['read', 'operate'] }
const call = (method: string, params: unknown, by: Caller = peer) => module.handle!({ id: '1', method, params } as unknown as ClientRequest, ctx, by)

beforeEach(() => {
  office = new FakeOffice()
  office.addBook('/Users/o/B.xlsx', { Sheet1: { A1: 1 } })
  setCarrier(() => office)
  held = []
  const db = new DatabaseSync(':memory:')
  module.ensure(db)
  ctx = {
    db,
    host: 'env_mac',
    log: () => {},
    reaches: (_by: Caller, path: string) => path.startsWith('/Users/o/'),
    held: { create: (a: { kind: string; sessionId: string | null }) => (held.push(a), { state: 'held', summary: 's' }) }
  } as unknown as WorkCtx
})

describe('the office wire', () => {
  it('says what this host carries', async () => {
    await expect(call('work.office.status', {})).resolves.toMatchObject({ result: { carrier: 'fake', route: { accounts: [], beatAt: null } } })
  })

  it('runs a read tool for another host, and refuses a write tool on the read route', async () => {
    await expect(call('work.office.read', { tool: 'office_range_read', args: { workbook: '/Users/o/B.xlsx', range: 'Sheet1!A1' } })).resolves.toMatchObject({ result: { content: [{ text: expect.stringContaining('"values"') }] } })
    await expect(call('work.office.read', { tool: 'office_range_write', args: {} })).rejects.toThrow('work.office.write')
  })

  it("refuses a remote caller a file by path outside what it could name, and lets a URL through", async () => {
    office.addBook('/etc/Secret.xlsx', { Sheet1: { A1: 1 } })
    await expect(call('work.office.read', { tool: 'office_range_read', args: { workbook: '/etc/Secret.xlsx', range: 'Sheet1!A1' } })).rejects.toThrow()
    office.addBook('https://contoso.sharepoint.com/B.xlsx', { Sheet1: { A1: 1 } })
    await expect(call('work.office.read', { tool: 'office_range_read', args: { workbook: 'https://contoso.sharepoint.com/B.xlsx', range: 'Sheet1!A1' } })).resolves.toMatchObject({ handled: true })
  })

  it('holds a send that came over the link: it waits here for his press', async () => {
    const got = await call('work.office.write', { tool: 'office_mail_send', args: { to: ['d@example.com'], subject: 's', html: 'h' }, asked: true, by: 'agent:env_box:t9' })
    expect(got).toMatchObject({ result: { content: [{ text: expect.stringMatching(/^Held for the owner/) }] } })
    expect(held).toEqual([expect.objectContaining({ kind: 'office.mail.send', sessionId: null })])
    expect(office.sent).toEqual([])
  })

  it('brings a file forward only where the caller could name it', async () => {
    const src = (path: string) => ({ source: { at: 'microsoft', host: 'env_mac', app: 'excel', name: 'B.xlsx', ref: { kind: 'path', path } } })
    await call('work.office.switch', src('/Users/o/B.xlsx'))
    await expect(call('work.office.switch', src('/etc/B.xlsx'))).rejects.toThrow()
    expect(office.opened).toEqual([{ app: 'excel', ref: { kind: 'path', path: '/Users/o/B.xlsx' } }])
  })

  it('answers no carrier where no Office runs', async () => {
    setCarrier(() => null)
    await expect(call('work.office.read', { tool: 'office_files', args: {} })).rejects.toThrow('Office is not on this host')
  })
})
