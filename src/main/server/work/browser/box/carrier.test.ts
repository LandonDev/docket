import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerToolOutcome } from '../../../computer/result'
import { BOX_OWNER_DRIVES, boxBrowserTools, carrierComputer, setBoxBrowser, setCarrierServiceForTest, startBoxBrowser, type BoxBrowserHost } from './index'
import { FORMS_OPEN, isCarrierSession } from './service'

/** The msforms carrier's hands (`carrierComputer`): a marked session of its own, run through the box's computer sessions with no card. */

const done: ComputerToolOutcome = { steps: [], shots: [], body: 'ok', isError: false }

function fakeHost() {
  const sessions = {
    run: vi.fn(async () => done),
    previewTarget: vi.fn((thread: string) => ({ serviceSession: thread, app: { pid: 1, name: 'Chromium' }, window: { id: 4, title: 'Untitled form' } })),
    end: vi.fn(async () => {})
  }
  setBoxBrowser({ sessions, browser: { touch: () => {}, stop: () => {} } } as unknown as BoxBrowserHost)
  return sessions
}

afterEach(() => {
  setBoxBrowser(null)
  setCarrierServiceForTest(null)
})

describe('carrierComputer', () => {
  it('is null where the box has no browser', () => {
    setBoxBrowser(null)
    expect(carrierComputer()).toBeNull()
  })

  it('runs the tools on a session marked as the carrier, with no card, and drops the mark at its end', async () => {
    const sessions = fakeHost()
    const c = carrierComputer()!
    expect(isCarrierSession(c.session)).toBe(true)
    expect(await c.run('computer_observe', { app: 'Chromium' })).toBe(done)
    const [ctx, tool, args] = sessions.run.mock.calls[0] as unknown as [{ threadId: string; permission: () => string; approve: () => Promise<boolean> }, string, unknown]
    expect(ctx.threadId).toBe(c.session)
    expect(ctx.permission()).toBe('auto')
    expect(await ctx.approve()).toBe(false)
    expect([tool, args]).toEqual(['computer_observe', { app: 'Chromium' }])
    expect(c.window()).toEqual({ id: 4, title: 'Untitled form' })
    await c.end()
    expect(sessions.end).toHaveBeenCalledWith([c.session])
    expect(isCarrierSession(c.session)).toBe(false)
  })

  it('gives each carrier its own session', async () => {
    fakeHost()
    const a = carrierComputer()!
    const b = carrierComputer()!
    expect(a.session).not.toBe(b.session)
    await a.end()
    expect([isCarrierSession(a.session), isCarrierSession(b.session)]).toEqual([false, true])
    await b.end()
  })
})

describe("the carrier's lease and cleanup (review 24)", () => {
  /** A Work context whose drive table says whether he drives the browser now. */
  const workCtx = () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE work_browser_drive (pane TEXT PRIMARY KEY, driver TEXT, needs TEXT, since INTEGER)')
    const logs: string[] = []
    const stop = startBoxBrowser({ db, held: { onDecided: () => () => {} }, log: (l: string) => logs.push(l) } as never)
    return { db, logs, stop, drives: (on: boolean) => (on ? db.prepare("INSERT OR REPLACE INTO work_browser_drive VALUES ('p', 'owner', NULL, 1)").run() : db.prepare('DELETE FROM work_browser_drive').run()) }
  }
  const fakeService = (status: 'closed' | 'kept' | 'gone' = 'closed') => {
    const svc = {
      carrierPages: vi.fn(async () => [{ window: 1, url: 'https://x.sharepoint.com/', target: 't1' }]),
      carrierFetch: vi.fn(async () => ({ status: 200 })),
      carrierClose: vi.fn(async () => {}),
      carrierClear: vi.fn(async () => status)
    }
    setCarrierServiceForTest(svc as never)
    return svc
  }

  it('refuses every read once he takes the browser, for the rest of the operation, even after he hands it back; its cleanup still runs', async () => {
    const sessions = fakeHost()
    const svc = fakeService()
    const w = workCtx()
    try {
      const c = carrierComputer()!
      expect(await c.pages()).toHaveLength(1)
      expect(await c.fetch(1, 'https://x.sharepoint.com/_api/web')).toEqual({ status: 200 })
      // the carrier's own calls name its session, so they see and ask only what it may
      expect(svc.carrierPages).toHaveBeenCalledWith(c.session)
      expect(svc.carrierFetch).toHaveBeenCalledWith(1, 'https://x.sharepoint.com/_api/web', undefined, c.session)
      w.drives(true)
      expect((await c.run('computer_observe', { app: 'Chromium' })).body).toBe(BOX_OWNER_DRIVES)
      await expect(c.pages()).rejects.toThrow(BOX_OWNER_DRIVES)
      await expect(c.fetch(1, 'https://x.sharepoint.com/_api/web')).rejects.toThrow(BOX_OWNER_DRIVES)
      w.drives(false)
      // handed back mid-pull: the lease is lost for good, so nothing more is read
      expect((await c.run('computer_observe', { app: 'Chromium' })).body).toBe(BOX_OWNER_DRIVES)
      await expect(c.pages()).rejects.toThrow(BOX_OWNER_DRIVES)
      expect(sessions.run).not.toHaveBeenCalled()
      expect(svc.carrierFetch).toHaveBeenCalledTimes(1)
      await c.clear(['https://x.sharepoint.com'])
      expect(svc.carrierClear).toHaveBeenCalledWith(c.session)
    } finally {
      w.stop()
    }
  })

  it("closes every page the session owns at its end, whatever the operation did, and says so when one stayed", async () => {
    fakeHost()
    const svc = fakeService('kept')
    const w = workCtx()
    try {
      const c = carrierComputer()!
      await c.end()
      expect(svc.carrierClear).toHaveBeenCalledWith(c.session)
      expect(w.logs).toEqual(["box browser: the carrier's pages were not all closed (kept)"])
    } finally {
      w.stop()
    }
  })
})

describe('box_browser_open of a Forms address', () => {
  it('refuses it in the Forms sentence, before anything is asked of the service', async () => {
    const sessions = fakeHost()
    const open = boxBrowserTools().find((t) => t.name === 'box_browser_open')!
    const ctx = { sessionId: 't1', canvas: { paneOf: () => 'pane' }, db: new DatabaseSync(':memory:'), signal: new AbortController().signal }
    const got = (await open.run({ launch: 'Chromium', open: ['https://forms.office.com/Pages/DesignPageV2.aspx?id=x'] }, ctx as never)) as { content: { text: string }[]; isError?: boolean }
    expect(got.isError).toBe(true)
    expect(got.content[0]!.text).toBe(FORMS_OPEN)
    expect(sessions.run).not.toHaveBeenCalled()
  })
})

