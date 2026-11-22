import { PassThrough } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCtx } from '../../modules'
import { ensureSuggestionTables } from '../../sheets/suggestions'
import type { HelperProcess } from '../com/carrier'
import { ensureExcelTables } from '../excel'
import { ensureFilesTables } from '../files/library'
import { NO_LICENCE, setVmHelperStart, setVmState, vmAllowed, vmHasOffice, vmHereOf } from './office'

/** Office in the Windows VM over a stand-in helper that speaks the helper's frames on one socket-like pair. */

function helper(answer: (verb: string, args: unknown) => { ok: true; value: unknown } | { ok: false; error: { code?: string; message?: string; hresult?: string } }): () => Promise<HelperProcess> {
  return async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    stdin.setEncoding('utf8').on('data', (d: string) => {
      for (const line of d.split('\n').filter(Boolean)) {
        const req = JSON.parse(line) as { id: number; verb: string; args: unknown }
        stdout.write(JSON.stringify({ id: req.id, ...answer(req.verb, req.args) }) + '\n')
      }
    })
    setImmediate(() => stdout.write(JSON.stringify({ event: 'ready', version: 1 }) + '\n'))
    return { stdin, stdout, kill: () => true, once: () => undefined }
  }
}

const ctxOf = (office: { installed: boolean; licensed: boolean | null } | null): WorkCtx => {
  const db = new DatabaseSync(':memory:')
  ensureFilesTables(db)
  ensureSuggestionTables(db)
  ensureExcelTables(db)
  if (office) db.prepare('INSERT INTO work_office_files (key, value) VALUES (?, ?)').run('vm:status', JSON.stringify({ at: 1, status: { onedrive: { installed: true, running: true, account: null }, mounts: [], office: { ...office, version: '16', apps: ['excel'], account: null } }, tops: {} }))
  return { db, log: () => {}, settings: { workspace: () => ({ mayUseDesktop: [], windowsVm: true }) } } as unknown as WorkCtx
}

afterEach(() => {
  setVmHelperStart(null)
  setVmState(null)
})

describe('Office in the Windows VM', () => {
  it("drives Excel there through the guest's helper, one frame per call", async () => {
    setVmHelperStart(helper((verb) => ({ ok: true, value: verb === 'workbooks' ? [{ key: 'C:\\b.xlsx', name: 'b.xlsx', sheets: [] }] : null })))
    const here = vmHereOf(ctxOf({ installed: true, licensed: true }))
    expect(await here.carrier.workbooks()).toEqual([{ key: 'C:\\b.xlsx', name: 'b.xlsx', sheets: [] }])
    expect(here.carrier.kind).toBe('com')
  })

  it("says an Office with no licence views only, where the app answers a bare code; a licensed one's failure stays as it is", async () => {
    const refuse = helper(() => ({ ok: false, error: { code: 'failed', message: 'Microsoft Excel answered: Exception from HRESULT: 0x800A03EC', hresult: '0x800A03EC' } }))
    setVmHelperStart(refuse)
    await expect(vmHereOf(ctxOf({ installed: true, licensed: false })).carrier.readRange('b', 's', 'A1')).rejects.toMatchObject({ message: NO_LICENCE, code: 'not-allowed' })
    setVmHelperStart(refuse)
    await expect(vmHereOf(ctxOf({ installed: true, licensed: true })).carrier.readRange('b', 's', 'A1')).rejects.toThrow('0x800A03EC')
  })

  it('is a place for a thread only where its workspace turns the VM on, the VM is set up, and Office is installed there', () => {
    const ctx = ctxOf({ installed: true, licensed: false })
    setVmState(() => ({ state: 'asleep', cannot: null }))
    expect(vmAllowed(ctx, { workspaceId: 'w1' })).toBe(true)
    expect(vmAllowed(ctx, { workspaceId: null })).toBe(false)
    expect(vmHasOffice(ctx)).toBe(true)
    expect(vmHasOffice(ctxOf({ installed: false, licensed: null }))).toBe(false)
    expect(vmHasOffice(ctxOf(null))).toBe(false)
    setVmState(() => ({ state: 'none', cannot: null }))
    expect(vmAllowed(ctx, { workspaceId: 'w1' })).toBe(false)
    setVmState(() => null)
    expect(vmAllowed(ctx, { workspaceId: 'w1' })).toBe(false)
    expect(vmAllowed({ settings: { workspace: () => ({ mayUseDesktop: [], windowsVm: false }) } } as never, { workspaceId: 'w1' })).toBe(false)
  })
})
