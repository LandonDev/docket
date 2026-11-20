import { afterEach, describe, expect, it } from 'vitest'
import type { ComputerSessionRow } from '@shared/contract-computer'
import { configureComputerDrive, configureDriveSessions, driveComputer, NOT_DRIVABLE, parseComputer, unknownComputer, type ComputerDriveHook } from './drive'

/** Take over on the host (computer/drive.ts): the wheel first, then the sessions that drove the computer, in one call. */

const row = (threadId: string, o: Partial<ComputerSessionRow> = {}): ComputerSessionRow => ({ threadId, apps: [], lastCallAt: 1, running: null, ...o }) as ComputerSessionRow

afterEach(() => {
  configureDriveSessions(null)
  configureComputerDrive('browser', null)
})

/** A host whose rows are listed and stopped, and a wheel whose change lands when `land` is called; `log` is what happened, in order. */
function rig(rows: ComputerSessionRow[]) {
  const log: string[] = []
  let land = (): void => {}
  configureDriveSessions({
    sessions: () => ({ sessions: rows }),
    async stop(id) {
      log.push(`stop ${id}`)
      return { stopped: true }
    }
  })
  const hook: ComputerDriveHook<{ driver: string }> = {
    holds: (pane) => (threadId) => threadId === pane || threadId.startsWith(`${pane}-`),
    drive: (pane, driver) =>
      new Promise((resolve) => {
        log.push(`drive ${pane} ${driver}`)
        land = () => {
          log.push('landed')
          resolve({ driver })
        }
      })
  }
  configureComputerDrive('browser', hook)
  return { log, land: () => land(), hook }
}

describe('computer.drive', () => {
  it("hands him the wheel, waits for the change to land, and only then stops every session that drove the page: the page has a row at every moment", async () => {
    const r = rig([row('t1'), row('t1-sub'), row('t9')])
    const done = driveComputer('browser:t1', 'owner')
    await Promise.resolve()
    // nothing is stopped while the change is on its way
    expect(r.log).toEqual(['drive t1 owner'])
    r.land()
    expect(await done).toEqual({ driver: 'owner' })
    expect(r.log).toEqual(['drive t1 owner', 'landed', 'stop t1', 'stop t1-sub'])
  })

  it("leaves a session already marked his, and stops nothing at Hand back", async () => {
    const r = rig([row('t1', { driver: 'owner' }), row('t1-sub')])
    const take = driveComputer('browser:t1', 'owner')
    r.land()
    await take
    expect(r.log.filter((l) => l.startsWith('stop'))).toEqual(['stop t1-sub'])
    r.log.length = 0
    const back = driveComputer('browser:t1', 'agent')
    r.land()
    await back
    expect(r.log).toEqual(['drive t1 agent', 'landed'])
  })

  it("reads which sessions drove it before the change: one the change marks his is still stopped", async () => {
    const rows = [row('t1')]
    const r = rig(rows)
    const take = driveComputer('browser:t1', 'owner')
    rows[0] = row('t1', { driver: 'owner' })
    r.land()
    await take
    expect(r.log).toContain('stop t1')
  })

  it("a stop that fails does not fail the Take over", async () => {
    const r = rig([row('t1')])
    configureDriveSessions({ sessions: () => ({ sessions: [row('t1')] }), stop: async () => Promise.reject(new Error('gone')) })
    const lines: string[] = []
    const take = driveComputer('browser:t1', 'owner', (l) => lines.push(l))
    r.land()
    expect(await take).toEqual({ driver: 'owner' })
    expect(lines[0]).toMatch(/could not stop t1/)
  })

  it("refuses a person's own window, a name with no kind and a kind nobody registered", async () => {
    rig([])
    await expect(driveComputer('window:t1', 'owner')).rejects.toThrow(NOT_DRIVABLE)
    await expect(driveComputer('t1', 'owner')).rejects.toThrow(unknownComputer('t1'))
    await expect(driveComputer('vm:windows', 'owner')).rejects.toThrow(unknownComputer('vm:windows'))
  })

  it("a stop clears only its own hook", () => {
    const { hook } = rig([])
    const other: ComputerDriveHook = { holds: () => () => false, drive: async () => null }
    configureComputerDrive('browser', other)
    configureComputerDrive('browser', null, hook)
    return expect(driveComputer('browser:t1', 'agent')).resolves.toBeNull()
  })

  it('parses a name at its first colon', () => {
    expect(parseComputer('browser:a:b')).toEqual({ kind: 'browser', id: 'a:b' })
    expect(parseComputer('vm:windows')).toEqual({ kind: 'vm', id: 'windows' })
    expect(parseComputer(':x')).toBeNull()
    expect(parseComputer('x:')).toBeNull()
  })
})
