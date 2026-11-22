import { describe, expect, it, vi } from 'vitest'
import type { WinvmState } from '@shared/contract-work-winvm'
import { HELPER_PATH, HELPER_PORT, HelperDoor, helperHash, helperScript, NO_HELPER, WORK_OFF, type HelperKeeper } from './helperDoor'
import { TOKEN_PATH } from './setup'

/** The guest's second door over a fake keeper: what is run as the admin, when, and what a caller gets. */

const state = (name: WinvmState['state'], since = 1): WinvmState => ({ state: name, step: null, error: null, cannot: null, sleepAfter: '30m', since })

function setup(over: Partial<{ knocks: boolean[]; said: string; state: WinvmState }> = {}) {
  const k = { state: over.state ?? state('awake'), scripts: [] as string[], wakes: 0, touched: 0 }
  const keeper: HelperKeeper = {
    door: async () => {
      k.wakes++
      k.state = state('awake', k.state.since)
      return { socket: '/run/door.sock', token: 't'.repeat(40) }
    },
    state: () => k.state,
    admin: async (script) => {
      k.scripts.push(script)
      return over.said ?? 'ready'
    },
    touch: () => void k.touched++
  }
  const knocks = [...(over.knocks ?? [true])]
  const knock = vi.fn(async () => (knocks.length > 1 ? knocks.shift()! : knocks[0]!))
  const log: string[] = []
  const door = new HelperDoor({ keeper: () => keeper, socket: '/run/office.sock', source: 'class X {}', log: (l) => log.push(l), knock, knockMs: 50, knockEvery: 1 })
  return { door, k, knock, log }
}

describe("the helper's install script", () => {
  const script = helperScript('class X {}')
  it("compiles the box's own source with the guest's csc only when the guest's hash differs, with no console window", () => {
    expect(script).toContain(`$want = '${helperHash('class X {}')}'`)
    expect(script).toContain(Buffer.from('class X {}').toString('base64'))
    expect(script).toMatch(/csc\.exe/)
    expect(script).toContain('/target:winexe')
    expect(script).toMatch(/if \(\$have -ne \$want -or -not \(Test-Path -LiteralPath \$exe\)\)/)
    expect(script).toContain(HELPER_PATH)
  })
  it('a change to the source changes the hash, so the next wake compiles it again', () => {
    expect(helperHash('class X {}')).not.toBe(helperHash('class Y {}'))
  })
  it("registers a logon task of tcuser's that serves the loopback door behind the door's own token, and starts it unless it runs", () => {
    expect(script).toContain(`serve --listen 127.0.0.1:${HELPER_PORT} --token-file "${TOKEN_PATH}"`)
    expect(script).toContain('$def.Principal.LogonType = 3')
    expect(script).toMatch(/if \(-not \(Get-Process tc-office[^)]*\)\) \{ \$task\.Run/)
  })
  it("sets OneDrive's policies: files on demand, and a downloaded file back in the cloud after a day", () => {
    expect(script).toContain("'FilesOnDemandEnabled' 1")
    expect(script).toContain("'ConfigStorageSenseCloudContentDehydrationThreshold' 1")
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
  it('says so when it compiled one', async () => {
    const { door, log } = setup({ said: 'compiled\nready' })
    await door.open()
    expect(log.join(' ')).toMatch(/compiled the Office helper/)
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
