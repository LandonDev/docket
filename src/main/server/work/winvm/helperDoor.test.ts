import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { WinvmState } from '@shared/contract-work-winvm'
import { TC_OFFICE_CS } from '../office/com/source'
import { CHECK_MS, HELPER_PATH, HELPER_PORT, HelperDoor, helperCheckScript, helperCompileScript, helperHash, helperSourceName, NO_HELPER, WORK_OFF, type HelperKeeper } from './helperDoor'
import { TOKEN_PATH } from './setup'

/** The guest's second door over a fake keeper: what is run as the admin, when, and what a caller gets. */

const state = (name: WinvmState['state'], since = 1): WinvmState => ({ state: name, step: null, error: null, cannot: null, sleepAfter: '30m', since })
const want = helperHash('class X {}')

interface Over {
  knocks: boolean[]
  /** what each check answers, in turn (the last one repeats) */
  checks: (string | Error)[]
  compile: string | Error
  upload: Error
  state: WinvmState
}

function setup(over: Partial<Over> = {}) {
  const k = { state: over.state ?? state('awake'), scripts: [] as string[], timeouts: [] as (number | undefined)[], uploads: [] as { name: string; body: string }[], wakes: 0, touched: 0 }
  const checks = [...(over.checks ?? ['ready'])]
  const keeper: HelperKeeper = {
    door: async () => {
      k.wakes++
      k.state = state('awake', k.state.since)
      return { socket: '/run/door.sock', token: 't'.repeat(40) }
    },
    state: () => k.state,
    admin: async (script, ms) => {
      k.scripts.push(script)
      k.timeouts.push(ms)
      const said = script.includes('csc.exe') ? (over.compile ?? 'compiled') : checks.length > 1 ? checks.shift()! : checks[0]!
      if (said instanceof Error) throw said
      return said
    },
    upload: async (local, name) => {
      if (over.upload) throw over.upload
      k.uploads.push({ name, body: readFileSync(local, 'utf8') })
    },
    touch: () => void k.touched++
  }
  const knocks = [...(over.knocks ?? [true])]
  const knock = vi.fn(async () => (knocks.length > 1 ? knocks.shift()! : knocks[0]!))
  const log: string[] = []
  const door = new HelperDoor({ keeper: () => keeper, socket: '/run/office.sock', source: 'class X {}', log: (l) => log.push(l), knock, knockMs: 50, knockEvery: 1 })
  return { door, k, knock, log }
}
const compiles = (k: { scripts: string[] }) => k.scripts.filter((s) => s.includes('csc.exe')).length

describe("the helper's scripts", () => {
  const check = helperCheckScript(want)
  const compile = helperCompileScript(want)
  it('the check is small and never carries the source: it says stale when the guest holds another build', () => {
    expect(Buffer.byteLength(check)).toBeLessThan(8 * 1024)
    expect(check).not.toContain(Buffer.from('class X {}').toString('base64'))
    expect(check).toContain(`if ($have -ne '${want}' -or -not (Test-Path -LiteralPath $exe)) { 'stale'; return }`)
    expect(check).not.toContain('csc.exe')
    expect(check).toContain(HELPER_PATH)
  })
  it('the check, finding no helper running and its port held, names what holds it instead of starting one that cannot listen', () => {
    expect(check).toContain(`Get-NetTCPConnection -LocalPort ${HELPER_PORT} -State Listen`)
    expect(check).toContain("if ((Get-Process -Id $owner -ErrorAction SilentlyContinue).Name -eq 'tc-office') { 'ready'; return }")
    expect(check).toMatch(/"port-held: \$\(@\(Get-CimInstance Win32_Process -Filter "ProcessId=\$owner or ParentProcessId=\$owner"/)
  })
  it("the helper's sockets are not handed to the programs it starts, so a helper put in its place can listen", () => {
    expect(TC_OFFICE_CS).toContain('NoInherit(listener.Server);')
    expect(TC_OFFICE_CS).toContain('NoInherit(client.Client);')
    expect(TC_OFFICE_CS).toContain('SetHandleInformation(s.Handle, 1, 0)')
    expect(TC_OFFICE_CS).not.toContain('UseShellExecute = false')
  })
  it('a change to the source changes the hash, so the next wake compiles it again', () => {
    expect(helperHash('class X {}')).not.toBe(helperHash('class Y {}'))
  })
  it("the check registers a logon task of tcuser's that serves the loopback door behind the door's own token, and starts it unless it runs", () => {
    expect(check).toContain(`serve --listen 127.0.0.1:${HELPER_PORT} --token-file "${TOKEN_PATH}"`)
    expect(check).toContain('$def.Principal.LogonType = 3')
    expect(check).toContain('$account = "$env:COMPUTERNAME\\tcuser"')
    expect(check).toContain("$svc.GetFolder('\\')")
    expect(check).toMatch(/if \(-not \(Get-Process tc-office[^)]*\)\) \{[\s\S]*\$task\.Run\(\$null\)/)
  })
  it("the check sets OneDrive's policies: files on demand, and a downloaded file back in the cloud after a day", () => {
    expect(check).toContain("'FilesOnDemandEnabled' 1")
    expect(check).toContain("'ConfigStorageSenseCloudContentDehydrationThreshold' 1")
  })
  it("the check sets Office's viewer mode, so a machine set up before it has no empty first-run dialog", () => {
    expect(check).toContain("-Name 'ViewerMode' -Value 1")
  })
  it('the compile reads the source the host copied into the admin\'s profile, builds with no console window, and writes the hash', () => {
    expect(compile).toContain(`$src = Join-Path $env:USERPROFILE '${helperSourceName(want)}'`)
    expect(compile).toContain("'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'")
    expect(compile).toContain('/target:winexe')
    expect(compile).toContain(`WriteAllText('${HELPER_PATH.replace('.exe', '.sha')}', '${want}')`)
    expect(compile).not.toContain(Buffer.from('class X {}').toString('base64'))
    expect(Buffer.byteLength(compile)).toBeLessThan(4 * 1024)
  })
})

describe('opening the door', () => {
  it('wakes the machine, runs the install once, knocks, and answers the socket with the token', async () => {
    const { door, k, knock } = setup({ state: state('asleep') })
    expect(await door.open()).toEqual({ socket: '/run/office.sock', token: 't'.repeat(40) })
    expect(k.wakes).toBe(1)
    expect(k.scripts).toHaveLength(1)
    expect(knock).toHaveBeenCalledWith('/run/office.sock', 't'.repeat(40))
    await door.open()
    expect(k.scripts).toHaveLength(1)
    expect(k.touched).toBe(2)
  })
  it('a wake with a current helper runs the small check alone, in seconds: no copy, no compile', async () => {
    const { door, k } = setup()
    await door.open()
    expect(k.scripts).toHaveLength(1)
    expect(k.timeouts).toEqual([CHECK_MS])
    expect(CHECK_MS).toBeLessThanOrEqual(15_000)
    expect(k.uploads).toHaveLength(0)
  })
  it('a stale helper: the source goes across as a file, the guest compiles it, and the check runs again', async () => {
    const { door, k, log } = setup({ checks: ['stale', 'ready'] })
    await door.open()
    expect(k.uploads).toEqual([{ name: helperSourceName(want), body: 'class X {}' }])
    expect(k.scripts.map((s) => (s.includes('csc.exe') ? 'compile' : 'check'))).toEqual(['check', 'compile', 'check'])
    expect(log.join(' ')).toMatch(/compiled the Office helper/)
  })
  it('says so when the compiled helper still reads as another build', async () => {
    const { door } = setup({ checks: ['stale'] })
    await expect(door.open()).rejects.toThrow(/was compiled, but the guest's copy still reads as another build/)
  })
  it('a port held by programs an older helper started is named in the error', async () => {
    const { door } = setup({ checks: ['port-held: OneDrive.exe, EXCEL.EXE'] })
    await expect(door.open()).rejects.toThrow(`The helper in the Windows VM cannot start while OneDrive.exe, EXCEL.EXE hold its port ${HELPER_PORT}. Close them in the VM, then try again.`)
  })
  it('a copy or a compile that fails says which', async () => {
    await expect(setup({ checks: ['stale'], upload: new Error('scp failed: lost') }).door.open()).rejects.toThrow(/Copying the helper's source into the Windows VM failed: scp failed: lost/)
    await expect(setup({ checks: ['stale'], compile: new Error('csc: CS1002') }).door.open()).rejects.toThrow(/Compiling the helper in the Windows VM failed: csc: CS1002/)
  })
  it('a check that hangs is run once more, then fails in words naming the check and why', async () => {
    const once = setup({ checks: [new Error('did not answer within 15 s'), 'ready'] })
    await once.door.open()
    expect(once.k.scripts).toHaveLength(2)
    expect(once.log.join(' ')).toMatch(/check did not finish/)
    const twice = setup({ checks: [new Error("the guest's script did not answer within 15 s")] })
    await expect(twice.door.open()).rejects.toThrow("The helper check in the Windows VM failed twice: the guest's script did not answer within 15 s")
    expect(twice.k.timeouts).toEqual([CHECK_MS, CHECK_MS])
  })
  it('after a new wake only knocks: a helper that answers is not installed again', async () => {
    const { door, k } = setup()
    await door.open()
    k.state = state('awake', 2)
    await door.open()
    expect(k.scripts).toHaveLength(1)
  })
  it('after a new wake with no answer, makes it ready again', async () => {
    const { door, k } = setup({ knocks: [true, false, true] })
    await door.open()
    k.state = state('awake', 2)
    await door.open()
    expect(k.scripts).toHaveLength(2)
  })
  it('a doubted door is made ready again at the next call', async () => {
    const { door, k } = setup()
    await door.open()
    door.doubt()
    await door.open()
    expect(k.scripts).toHaveLength(2)
  })
  it('fails in words when the helper never answers', async () => {
    const { door } = setup({ knocks: [false] })
    await expect(door.open()).rejects.toThrow(NO_HELPER)
  })
  it('never wakes a sleeping machine for a call that may not', async () => {
    const { door, k } = setup({ state: state('asleep') })
    expect(await door.openIfAwake()).toBeNull()
    expect(k.wakes).toBe(0)
  })
  it('refuses while Work is off', async () => {
    const door = new HelperDoor({ keeper: () => null, socket: 's', source: '', log: () => {} })
    await expect(door.open()).rejects.toThrow(WORK_OFF)
    expect(await door.openIfAwake()).toBeNull()
  })
})
