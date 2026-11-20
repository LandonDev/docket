import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OutboxItem } from '@shared/contract-work-outbox'
import { qmpKeys, rigSpawn, sleep, startService, tunnel, vm } from '../../../../scripts/lib/winComputerRig'
import { VM_TIER_GATE } from '../work/winvm/gate'
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
 *
 * Plan B6's live cases run on the same service through sessions built as the
 * Windows VM's are (`vm: true`, `VM_TIER_GATE`): a console's launch refused, a
 * click in an open Windows Terminal held with no grant offered, and typing in
 * the Run box held. The Run box and the terminal are opened by the proof
 * itself (keys as hardware through QMP, a task on the desktop), never by the
 * thread, which cannot open either.
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
  let vmSessions: ComputerSessions
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
    const token = await startService(GUEST_PORT)
    expect(token).toBeTruthy()
    ssh = await tunnel(LOCAL_PORT, GUEST_PORT)
    const dataDir = join(rig.dir, 'computer')
    const service = new ComputerService({ dataDir, bin: () => 'tc-computer.exe', spawn: rigSpawn(LOCAL_PORT, token ?? '', GUEST_DATA, dataDir) })
    sessions = new ComputerSessions({
      service,
      registry: { get: (id) => rig.sessions.get(id) ?? null, requestApproval: async () => true, awayOn: () => rig.away.enabled },
      store: { getSetting: () => null, setSetting: () => {} } as never,
      dataDir,
      landing: (id) => join(rig.dir, 'landing', id),
      log: () => {}
    })
    // the Windows VM's own sessions over the same service: its launch list, its gate (work/winvm/vm.ts)
    rig.thread('t-vm', { scope: 'work', workspaceId: 'ws-purdue' } as never)
    vmSessions = new ComputerSessions({
      service,
      registry: { get: (id) => rig.sessions.get(id) ?? null, requestApproval: async () => true, awayOn: () => rig.away.enabled },
      store: { getSetting: () => null, setSetting: () => {} } as never,
      dataDir,
      landing: (id) => join(rig.dir, 'landing', id),
      gate: () => VM_TIER_GATE,
      vm: true,
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

  const vmRun = (tool: string, args: Record<string, unknown>) => vmSessions.run({ threadId: 't-vm', permission: () => 'auto' }, tool, args)

  it('B6: the VM refuses a console through computer_apps', async () => {
    const r = await vmRun('computer_apps', { launch: 'cmd' })
    expect(r.isError).toBe(true)
    expect(r.body).toMatch(/^no command line, shell or script host/)
  }, 60_000)

  it('B6: a click in an open Windows Terminal is held, and no grant can be made from it', async () => {
    vm('run-in-session', 'wt.exe')
    await sleep(6000)
    const read = await vmRun('computer_observe', { app: 'WindowsTerminal.exe' })
    expect(read.isError).toBe(false)
    const mine = async () => (await rig.waiting()).filter((i) => i.sessionId === 't-vm')
    const before = (await mine()).length
    const held = await vmRun('computer_act', { app: 'WindowsTerminal.exe', action: 'left_click', element: 1 })
    expect(held.body).toMatch(/^Held as item \d+/)
    const items = await mine()
    expect(items).toHaveLength(before + 1)
    const item = items.at(-1)!
    expect(item).toMatchObject({ kind: 'computer.act', state: 'live' })
    expect((item.payload as { read: { why: string; grantable?: boolean } }).read).toMatchObject({ why: 'console', grantable: false })
    vm('ssh', '--ps', 'Stop-Process -Name WindowsTerminal,OpenConsole -Force -ErrorAction SilentlyContinue')
  }, 120_000)

  it('B6: typing in the Run box is held', async () => {
    // the Run box opened as a person would, by keys on the guest's keyboard: never the thread's (it may not press Windows keys)
    await qmpKeys('meta_l', 'r')
    await sleep(2500)
    const read = await vmRun('computer_observe', { app: 'explorer.exe', window: 'Run' })
    expect(read.isError).toBe(false)
    const held = await vmRun('computer_act', { app: 'explorer.exe', window: 'Run', action: 'type', text: 'notepad' })
    expect(held.body).toMatch(/^Held as item \d+/)
    const item = (await rig.waiting()).filter((i) => i.sessionId === 't-vm').at(-1)!
    expect((item.payload as { read: { why: string; grantable?: boolean } }).read).toMatchObject({ why: 'console', grantable: false })
    await qmpKeys('esc')
  }, 120_000)
})
