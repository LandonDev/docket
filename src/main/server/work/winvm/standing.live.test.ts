import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WorkToolResult } from '@shared/work'
import { cast, makeRig, type Rig } from '../outbox/rig'
import { outbox as outboxModule } from '../outbox/index'
import { configureWinvmKeeper, hashFile, winvm, winvmKeeper } from './index'
import type { Keeper } from './keeper'
import { tcComputerExe } from './serviceBin'
import { SshGuest } from './sshGuest'
import { StandingMachine } from './standing'
import { restoreClipboard, saveClipboard, setVmHost, vmCopied, vmPaste, wireVm } from './vm'
import { readFileSync, writeFileSync } from 'node:fs'
import { loadWorkModules } from '../modules'

/**
 * The live run on the STANDING machine (docs/agents/work-winvm.md "The service
 * on the box"): a fresh setup by the real keeper, then the windows_* tools
 * through the real Work mount (no model): Notepad launched and read, text
 * typed, and Ctrl+S, a chord the VM's own gate admits, opens the Save dialog.
 * The machine is shut down and its disk deleted after. Runs only with
 * TC_WINVM_STANDING=1 and TEMP_CODE_WINVM_EXE naming a tc-computer.exe.
 */

const d = process.env.TC_WINVM_STANDING === '1' ? describe : describe.skip

const keep = process.env.TC_WINVM_KEEP === '1'

d('the windows_* tools on the standing Windows VM', () => {
  let rig: Rig
  let keeper: Keeper
  let token: string | null = null
  const machine = new StandingMachine('standing')
  const guest = new SshGuest(machine.c, machine.p)
  const log: string[] = []
  const call = (name: string, args: unknown) => rig.work.tools.call({ id: 't-work', scope: 'work' }, name, args, new AbortController().signal) as Promise<WorkToolResult>
  const text = (r: WorkToolResult) => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')
  const idOf = (body: string, re: RegExp): number => Number(/\[(\d+)\]/.exec(body.split('\n').find((l) => re.test(l)) ?? '')?.[1])
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  beforeAll(async () => {
    if (!keep && (machine.running() || machine.hasDisk())) throw new Error('the standing machine is in use or has a disk; this run starts from none')
    configureWinvmKeeper((ctx) => ({
      machine,
      guest,
      serviceExe: () => tcComputerExe(),
      hashFile,
      token: { get: () => token, set: (t) => (token = t) },
      doorSocket: join(machine.p.run, 'door.sock'),
      sleepAfter: () => 'never',
      setSleepAfter: () => {},
      points: machine.points(),
      log: (line) => (log.push(line), ctx.log(line))
    }))
    // a Result's undo finds its pillar in the loaded module list, as at boot
    await loadWorkModules()
    rig = await makeRig({ modules: [outboxModule, winvm] })
    cast(rig)
    // the rig's workspaces live in memory only: its settings read is turned on here, as the switch will in B10
    const settings = rig.work.ctx.settings
    const read = settings.workspace.bind(settings)
    settings.workspace = (id) => (id === 'ws-purdue' ? { mayUseDesktop: [], voice: false, windowsVm: true } : read(id))
    keeper = winvmKeeper()!
    mkdirSync(join(rig.dir, 'winvm'), { recursive: true })
    wireVm({
      registry: {
        get: (id) => rig.sessions.get(id) ?? null,
        requestApproval: async () => true,
        awayOn: () => rig.away.enabled,
        rootSessionOf: (id) => id,
        onMeta: () => {},
        onRemoved: () => {}
      },
      store: { getSetting: () => null, setSetting: () => {}, settingsWithPrefix: () => new Map() },
      dataDir: rig.dir,
      landing: (id) => join(rig.dir, 'landing', id),
      log: (line) => log.push(line)
    })
    const t = Date.now()
    // TC_WINVM_KEEP=1 keeps the machine after a run and takes it up again here, for a quick second look
    if (keep && machine.hasDisk()) {
      await machine.start()
      await guest.ready(300_000)
      token = (await guest.admin("[IO.File]::ReadAllText('C:\\ProgramData\\TempCode\\token')")).trim()
      await keeper.wake()
    } else await keeper.setup()
    console.log(`[live] setup done in ${Math.round((Date.now() - t) / 1000)} s; state ${keeper.state().state}`)
  }, 900_000)

  afterAll(async () => {
    configureWinvmKeeper(null)
    await rig?.close()
    setVmHost(null)
    if (machine.running() && !keep) {
      await guest.admin('shutdown /s /f /t 0').catch(() => {})
      if (!(await machine.stopped(180_000))) await machine.forceStop()
      await machine.keepTpm().catch(() => {})
    }
    if (!machine.running() && !keep) {
      rmSync(machine.c.dir, { recursive: true, force: true })
      rmSync(machine.c.tpmDir, { recursive: true, force: true })
    }
    console.log(`[live] the standing machine is ${machine.running() ? 'STILL RUNNING' : 'stopped, its disk deleted'}`)
  }, 300_000)

  it('lists the five tools for the thread whose workspace has the setting on', async () => {
    const names = (rig.work.tools.of({ id: 't-work', scope: 'work' })?.tools ?? []).map((t) => t.name).filter((n) => n.startsWith('windows_'))
    expect(names).toEqual(['windows_apps', 'windows_observe', 'windows_act', 'windows_batch', 'windows_result', 'windows_put', 'windows_get', 'windows_put_undo'])
  })

  it('launches Notepad, reads it, types in it, and opens the Save dialog with Ctrl+S', async () => {
    const launched = await call('windows_apps', { launch: 'Notepad' })
    console.log(`[live] windows_apps launch Notepad: ${text(launched).split('\n')[0]}`)
    expect(launched.isError).toBe(false)
    await sleep(4000)
    const read = await call('windows_observe', { app: 'Notepad' })
    console.log(`[live] windows_observe: ${text(read).split('\n')[0]}`)
    expect(read.isError).toBe(false)
    const doc = idOf(text(read), /(document|text area|edit)/i)
    expect(doc).toBeGreaterThan(0)
    const typed = await call('windows_act', { app: 'Notepad', action: 'type', text: 'Typed through the windows_* tools', element: doc })
    console.log(`[live] windows_act type: ${text(typed).split('\n')[0]}`)
    expect(typed.isError).toBe(false)
    const saved = await call('windows_act', { app: 'Notepad', action: 'key', text: 'ctrl+s' })
    console.log(`[live] windows_act key ctrl+s: ${text(saved).split('\n')[0]}`)
    expect(saved.isError).toBe(false)
    expect(text(saved)).not.toMatch(/needs the session tier/)
    await sleep(2500)
    const dialog = await call('windows_observe', { app: 'Notepad' })
    const head = text(dialog).split('\n').slice(0, 6).join(' | ')
    console.log(`[live] after ctrl+s: ${head}`)
    expect(text(dialog)).toMatch(/Save as/i)
    await call('windows_act', { app: 'Notepad', action: 'key', text: 'Escape' })
    // a picture the guest's service took, copied home over SFTP on the forward's connection
    const shot = await call('windows_observe', { app: 'Notepad', screenshot: true })
    const image = (shot.content as { type: string; data?: string }[]).find((c) => c.type === 'image')
    console.log(`[live] windows_observe with a screenshot: ${image ? `an image of ${Math.round(((image.data?.length ?? 0) * 3) / 4)} bytes came home` : `no image: ${text(shot).split('\n').filter((l) => /shot|picture|screen/i.test(l)).join(' | ') || text(shot).split('\n')[0]}; ${log.filter((l) => /picture|winvm/.test(l)).slice(-3).join(' | ')}`}`)
    expect(image?.data?.length ?? 0).toBeGreaterThan(1000)
  }, 600_000)

  it('puts a workspace file into Documents, gets it back, and the put\'s undo removes it', async () => {
    const ws = join(rig.dir, 'Purdue')
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'B9 live notes.txt'), 'put through windows_put')
    rig.work.ctx.db.prepare('INSERT OR REPLACE INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run('ws-purdue', 'Purdue', ws, Date.now())
    const put = await call('windows_put', { path: 'B9 live notes.txt', to: 'Documents' })
    console.log(`[live] windows_put: ${text(put)}`)
    expect(put.isError).toBeFalsy()
    const got = await call('windows_get', { from: 'Documents', name: 'B9 live notes.txt' })
    console.log(`[live] windows_get: ${text(got)}`)
    expect(got.isError).toBeFalsy()
    expect(readFileSync(join(ws, 'B9 live notes (1).txt'), 'utf8')).toBe('put through windows_put')
    const refused = await call('windows_put', { path: 'B9 live notes.txt', to: 'Downloads', name: 'notes.ps1' })
    console.log(`[live] windows_put as .ps1: ${text(refused)}`)
    expect(refused.isError).toBe(true)
    const result = (await rig.rpc<{ results: { id: string; kind: string }[] }>('work.outbox.results', { sessionId: 't-work' })).results.find((r) => r.kind === 'windows.put')!
    const undone = await rig.rpc<{ undoneAt: number | null }>('work.outbox.undo', { id: result.id })
    console.log(`[live] the put's Result undone: ${undone.undoneAt ? 'yes' : 'no'}`)
    expect(undone.undoneAt).toBeTruthy()
    const left = (await guest.admin("Test-Path -LiteralPath 'C:\\Users\\tcuser\\Documents\\B9 live notes.txt'")).trim()
    console.log(`[live] the file still in Documents after the undo: ${left}`)
    expect(left).toBe('False')
  }, 600_000)

  it('pastes his text in, reads a copy out, and puts the clipboard back at Hand back', async () => {
    await vmPaste('seed before Take over')
    await saveClipboard()
    await vmPaste('his own copy, pasted at the picture')
    const out = await vmCopied()
    console.log(`[live] the guest's clipboard after his paste: ${JSON.stringify(out)}`)
    expect(out).toEqual({ text: 'his own copy, pasted at the picture', truncated: false })
    await restoreClipboard()
    const back = await vmCopied()
    console.log(`[live] after Hand back: ${JSON.stringify(back)}`)
    expect(back.text).toBe('seed before Take over')
  }, 300_000)

  it('refuses a console through windows_apps', async () => {
    const r = await call('windows_apps', { launch: 'cmd' })
    console.log(`[live] windows_apps launch cmd: ${text(r).split('\n')[0]}`)
    expect(r.isError).toBe(true)
  })
})
