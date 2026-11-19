import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OutboxItem } from '@shared/contract-work-outbox'
import { ComputerService } from '../../../computer/service'
import { ComputerSessions } from '../../../computer/sessions'
import { cast, makeRig, type Rig } from '../../outbox/rig'
import { type BoxChromium, findChromium } from './chromium'
import { BoxComputerService, inProcessSpawn } from './service'
import { serveTestSite, type TestSite } from './testSite'
import { testBrowser } from './testTools'

/**
 * Milestone 38's done-when, end to end on the box with no Mac: a Work thread
 * drives the test site in the box's Chromium, its final submit becomes a
 * held computer act in the real Outbox (the hold as M10 built it, on the
 * host's own parts), Away releases nothing, and his press through
 * `work.outbox.send` submits it once.
 */

const bin = findChromium()
const d = bin && process.platform === 'linux' ? describe : describe.skip

d('a submit on the box, held in the Outbox until his press', () => {
  let rig: Rig
  let site: TestSite
  let browser: BoxChromium
  let sessions: ComputerSessions

  beforeAll(async () => {
    rig = await makeRig()
    cast(rig)
    site = await serveTestSite()
    const made = testBrowser(join(rig.dir, 'box'), bin!)
    browser = made.browser
    const service = new ComputerService({
      dataDir: join(rig.dir, 'box', 'computer'),
      bin: () => 'box-browser',
      spawn: inProcessSpawn(() => new BoxComputerService({ browser: made.link }))
    })
    sessions = new ComputerSessions({
      service,
      registry: { get: (id) => rig.sessions.get(id) ?? null, requestApproval: async () => true, awayOn: () => rig.away.enabled },
      store: { getSetting: () => null, setSetting: () => {} } as never,
      dataDir: join(rig.dir, 'box', 'computer'),
      landing: (id) => join(rig.dir, 'landing', id),
      log: () => {}
    })
  }, 30_000)

  afterAll(async () => {
    await browser?.stop()
    await site?.close()
    await rig?.close()
  })

  const run = (tool: string, args: Record<string, unknown>) => sessions.run({ threadId: 't-work', permission: () => 'auto' }, tool, args)
  const idOf = (text: string, re: RegExp): number => Number(/\[(\d+)\]/.exec(text.split('\n').find((l) => re.test(l)) ?? '')?.[1])

  it('holds the submit as a computer act of the box browser, keeps it through Away, and submits once on the press', async () => {
    await run('computer_apps', { launch: 'Chromium', open: [`${site.url}/review?name=Dana&amount=42`] })
    const read = await run('computer_observe', { app: 'Chromium' })
    const held = await run('computer_act', { app: 'Chromium', action: 'left_click', element: idOf(read.body!, /button "Submit expense"/) })
    expect(held.body).toMatch(/^Held as item \d+: Submit in Chromium/)

    rig.away.enabled = true
    const [item] = await rig.waiting()
    // a live hold: its press runs the call on the page as he was shown it
    expect(item).toMatchObject({ kind: 'computer.act', state: 'live', sessionId: 't-work', verb: 'Submit', sector: 'purdue' })
    expect((item!.payload as { app: { bundleId: string } }).app.bundleId).toBe('org.chromium.Chromium')
    await new Promise((r) => setTimeout(r, 300))
    expect(site.posts).toEqual([])
    expect(await rig.waiting()).toHaveLength(1)

    const sent = await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })
    expect(sent).toMatchObject({ state: 'sent', decidedBy: 'owner' })
    expect(site.posts).toEqual(['/done'])
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })).toMatchObject({ state: 'sent' })
    expect(site.posts).toEqual(['/done'])
  }, 60_000)
})
