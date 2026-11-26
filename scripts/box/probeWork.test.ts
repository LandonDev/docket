import { describe, expect, it } from 'vitest'
import { healthFaults, loadFault, probeWork } from './probe-work.mjs'

/** A host whose answers are `answers[method]`: a value, or an Error to throw. */
const host =
  (answers: Record<string, unknown>) =>
  async (method: string): Promise<unknown> => {
    const a = answers[method]
    if (a instanceof Error) throw a
    return a
  }

const healthy = {
  'work.set': { enabled: true },
  'work.get': { enabled: true },
  'workspace.create': { id: 'ws1' },
  'work.files.places': { places: [] },
  'work.health': { host: 'h', at: 0, rows: [{ id: 'lifeos.session', pillar: 'lifeos', group: 'LifeOS', title: 'LifeOS', state: 'needs-you', line: 'Not signed in' }] }
}

describe('loadFault', () => {
  it('reads the errors of a pillar that could not load, and passes what a working host says', () => {
    expect(loadFault("files did not load: Cannot access 'SHARED_BYTES' before initialization")).not.toBeNull()
    expect(loadFault('ReferenceError: x is not defined')).not.toBeNull()
    expect(loadFault('TypeError: handle.places is not a function')).not.toBeNull()
    expect(loadFault("The requested module './policy' does not provide an export named 'SHARED_BYTES'")).not.toBeNull()
    expect(loadFault('Work is off on this host')).toBeNull()
    expect(loadFault('not signed in to LifeOS')).toBeNull()
    expect(loadFault(undefined)).toBeNull()
  })
})

describe('healthFaults', () => {
  it('names a broken row that failed to load, never one that needs him', () => {
    expect(
      healthFaults({
        rows: [
          { pillar: 'files', state: 'broken', title: 'Files', line: 'work: files did not load: boom' },
          { pillar: 'mail', state: 'broken', title: 'Mail', line: 'The mail server refused the sign-in' },
          { pillar: 'lifeos', state: 'needs-you', title: 'LifeOS', line: 'Not signed in' }
        ]
      })
    ).toEqual(['files: work: files did not load: boom'])
    expect(healthFaults(null)).toEqual([])
  })
})

describe('probeWork', () => {
  it('passes a host whose pillars answer, signed in or not', async () => {
    const r = await probeWork(host(healthy))
    expect(r.failures).toEqual([])
  })

  it('fails on the Files place of 1.0.371, naming it and its error', async () => {
    const r = await probeWork(host({ ...healthy, 'work.files.places': new Error("files did not load: Cannot access 'SHARED_BYTES' before initialization") }))
    expect(r.failures).toEqual(["files (work.files.places): files did not load: Cannot access 'SHARED_BYTES' before initialization"])
  })

  it('fails when Work itself did not load, and on a pillar health names as unloaded', async () => {
    const inert = await probeWork(host({ ...healthy, 'work.set': new Error('work: Work did not load on this host: TypeError: x is not a function'), 'work.get': { enabled: false }, 'workspace.create': { id: 'ws1' } }))
    expect(inert.failures[0]).toMatch(/^work\.set: work: Work did not load/)
    const pillar = await probeWork(host({ ...healthy, 'work.health': { rows: [{ pillar: 'slides', state: 'broken', title: 'Slides', line: 'work: slides did not load: ReferenceError: z' }] } }))
    expect(pillar.failures).toEqual(['work.health slides: work: slides did not load: ReferenceError: z'])
  })

  it("fails a deploy's build whose Windows VM keeper has no service to copy in, asked only for a deploy", async () => {
    const blocked = { 'work.winvm.state': { state: 'none', cannot: 'The box has no Windows base image yet.', blocked: "This update left out the Windows VM's helper. Redeploy the box from master." } }
    expect((await probeWork(host({ ...healthy, ...blocked }), { vmService: true })).failures).toEqual(["work.winvm.state: This update left out the Windows VM's helper. Redeploy the box from master."])
    expect((await probeWork(host({ ...healthy, ...blocked }))).failures).toEqual([])
    const served = { 'work.winvm.state': { state: 'none', cannot: 'The box has no Windows base image yet.', blocked: null } }
    expect((await probeWork(host({ ...healthy, ...served }), { vmService: true })).failures).toEqual([])
  })

  it('keeps an error that is not a load failure as a note, and passes', async () => {
    const r = await probeWork(host({ ...healthy, 'work.health': new Error('Work is off on this host') }))
    expect(r.failures).toEqual([])
    expect(r.notes).toEqual(['work.health: Work is off on this host'])
  })
})
