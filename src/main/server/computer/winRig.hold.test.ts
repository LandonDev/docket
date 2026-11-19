import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OutboxItem } from '@shared/contract-work-outbox'
import { rigSpawn, sleep, startService, tunnel, vm } from '../../../../scripts/lib/winComputerRig'
import { cast, makeRig, type Rig } from '../work/outbox/rig'
import { ComputerService } from './service'
import { ComputerSessions } from './sessions'

/**
 * Milestone 43's done-when for the hold, in the Windows rig: a Work thread's
 * flagged submit in Edge on a Windows PC becomes a live held computer act in
 * the real Outbox (M10's hold, on the host's own parts), Away releases
 * nothing and the page is not submitted, and his press through
 * `work.outbox.send` submits it once. The host's ComputerService speaks to
 * tc-computer.exe on tcuser's desktop through the SSH tunnel
 * (scripts/lib/winComputerRig.ts `rigSpawn`), so run.ts judges the act as it
 * would on a Windows host. Runs only with the rig up: TC_WIN_RIG=1.
 */

const d = process.env.TC_WIN_RIG === '1' ? describe : describe.skip
const GUEST_PORT = 47830
const LOCAL_PORT = 47831
const GUEST_DATA = 'C:\\Users\\tcuser\\AppData\\Local\\Temp\\m43-hold'

const FORM = `<!doctype html><title>Expense</title>
<h1 id=h>Expense for review</h1>
<form id=f><label>Name <input id=n value=Dana></label> <label>Amount <input id=a value=42></label> <button type=submit>Submit expense</button></form>
<script>let k=0;document.getElementById('f').onsubmit=e=>{e.preventDefault();k++;document.title='Submitted '+k;document.getElementById('h').textContent='Submitted '+k}</script>`

d('a flagged submit in Edge on a Windows PC, held in the Outbox until his press', () => {
  let rig: Rig
  let sessions: ComputerSessions
  let ssh: ChildProcess

  beforeAll(async () => {
    rig = await makeRig()
    cast(rig)
    vm('ssh', '--ps', 'Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue')
    const page = join(rig.dir, 'expense.html')
    writeFileSync(page, FORM)
    vm('scp', page, 'guest:m43-expense.html')
    vm('run-in-session', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '--no-first-run', '--no-default-browser-check', '--inprivate', '--window-size=900,600', 'file:///C:/Users/tcuser/m43-expense.html')
    await sleep(6000)
    expect(await startService(GUEST_PORT)).toBe(true)
    ssh = await tunnel(LOCAL_PORT, GUEST_PORT)
    const dataDir = join(rig.dir, 'computer')
    const service = new ComputerService({ dataDir, bin: () => 'tc-computer.exe', spawn: rigSpawn(LOCAL_PORT, GUEST_DATA, dataDir) })
    sessions = new ComputerSessions({
      service,
      registry: { get: (id) => rig.sessions.get(id) ?? null, requestApproval: async () => true, awayOn: () => rig.away.enabled },
      store: { getSetting: () => null, setSetting: () => {} } as never,
      dataDir,
      landing: (id) => join(rig.dir, 'landing', id),
      log: () => {}
    })
  }, 120_000)

  afterAll(async () => {
    ssh?.kill()
    await rig?.close()
  })

  const run = (tool: string, args: Record<string, unknown>) => sessions.run({ threadId: 't-work', permission: () => 'auto' }, tool, args)
  const idOf = (text: string, re: RegExp): number => Number(/\[(\d+)\]/.exec(text.split('\n').find((l) => re.test(l)) ?? '')?.[1])

  it('holds the flagged submit as a live computer act, keeps it through Away, and submits once on the press', async () => {
    const read = await run('computer_observe', { app: 'msedge.exe' })
    expect(read.body).toMatch(/button "Submit expense"/)
    const held = await run('computer_act', {
      app: 'msedge.exe',
      action: 'left_click',
      element: idOf(read.body!, /button "Submit expense"/),
      confirm: { kind: 'send', what: "Submit Dana's expense of 42" }
    })
    expect(held.body).toMatch(/^Held as item \d+/)

    rig.away.enabled = true
    const [item] = await rig.waiting()
    expect(item).toMatchObject({ kind: 'computer.act', state: 'live', sessionId: 't-work', sector: 'purdue' })
    expect((item!.payload as { app: { bundleId: string } }).app.bundleId).toBe('msedge.exe')
    await sleep(1500)
    const still = await run('computer_observe', { app: 'msedge.exe' })
    expect(still.body).not.toMatch(/Submitted/)
    expect(await rig.waiting()).toHaveLength(1)

    const sent = await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })
    expect(sent).toMatchObject({ state: 'sent', decidedBy: 'owner' })
    await sleep(1000)
    const after = await run('computer_observe', { app: 'msedge.exe' })
    expect(after.body).toMatch(/Submitted 1/)
    // a second press posts nothing more
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })).toMatchObject({ state: 'sent' })
    await sleep(1000)
    expect((await run('computer_observe', { app: 'msedge.exe' })).body).toMatch(/Submitted 1/)
  }, 180_000)
})
